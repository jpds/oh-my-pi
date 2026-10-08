import { describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";
const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	// The full prelude exceeds Windows' ~32k `python -c` command-line limit
	// (ENAMETOOLONG); a script file behaves identically on every platform.
	const dir = await TempDir.create("omp-py-prelude-");
	try {
		const scriptPath = dir.join("script.py");
		await Bun.write(scriptPath, script);
		const proc = Bun.spawn([pythonPath, scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// Python's text-mode stdout emits \r\n on Windows.
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	} finally {
		await dir.remove();
	}
}

describe("python prelude", () => {
	it("infers eval tool schemas and replaces definitions by name", async () => {
		const result = await runPrelude(
			[
				"from typing import Annotated, Literal, Optional",
				"@tool",
				"def word_count(text: Annotated[str, 'Text to split'], sep: Literal[' ', ','] = ' ', limit: Optional[int] = None) -> dict:",
				'    """Count words in text."""',
				"    return {'count': len(text.split(sep))}",
				"first = __omp_tools__['word_count'].describe()",
				"@tool(name='word_count', description='Replacement')",
				"def replacement(text: str) -> dict:",
				"    return {'count': 1}",
				"print(json.dumps({'first': first, 'current': __omp_tools__['word_count'].describe(), 'defined': tool.defined()}, sort_keys=True))",
				"print(tool.undefine('word_count'), tool.defined())",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines[0] ?? "{}");
		expect(value.first).toEqual({
			name: "word_count",
			description: "Count words in text.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Text to split" },
					sep: { enum: [" ", ","], default: " " },
					limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
				},
				required: ["text"],
				additionalProperties: false,
			},
		});
		expect(value.current.description).toBe("Replacement");
		expect(value.defined).toEqual(["word_count"]);
		expect(lines[1]).toBe("True []");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("bypasses discovered proxies for loopback bridge calls", async () => {
		let proxyRequests = 0;
		const bridge = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args?: { path?: string } };
				return Response.json({
					ok: true,
					value: body.args?.path,
				});
			},
		});
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxyRequests++;
				return new Response("proxy intercepted", { status: 502 });
			},
		});

		try {
			const proxyUrl = proxy.url.toString();
			// urllib also reads macOS SystemConfiguration; environment injection
			// is the hermetic equivalent for this subprocess test.
			const result = await runPrelude(
				[
					"async def main():",
					'    paths = ["one.ts", "two.ts", "three.ts"]',
					"    results = []",
					"    for path in paths:",
					'        results.append(await tool.read({"path": path}))',
					"    print(results)",
					"asyncio.run(main())",
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: bridge.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
				},
			);

			expect(result).toEqual({
				stdout: "['one.ts', 'two.ts', 'three.ts']\n",
				stderr: "",
				exitCode: 0,
			});
			expect(proxyRequests).toBe(0);
		} finally {
			bridge.stop(true);
			proxy.stop(true);
		}
	});
});

describe("python direct judgment (PI_JUDGE_DIRECT)", () => {
	const DIRECT_ENV = (baseUrl: string): Record<string, string> => ({
		PI_JUDGE_DIRECT: JSON.stringify({
			api: "typesafe",
			route: "/v1/systemone",
			provider: "typesafe",
			model: "jev-preview",
			baseUrl,
			apiKey: "ts-key",
		}),
	});

	it("judge() POSTs the System One wire format directly and surfaces bool answers", async () => {
		const requests: { url: string; authorization: string; body: unknown }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push({
					url: new URL(request.url).pathname,
					authorization: request.headers.get("authorization") ?? "",
					body: await request.json(),
				});
				return Response.json({
					model: "jev-preview",
					answers: {
						ok: { type: "noul", noul: 1 },
						pick: { type: "choice", choice: "b", confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
					},
					usage: { input_tokens: 5, output_tokens: 7 },
				});
			},
		});

		try {
			const result = await runPrelude(
				[
					"async def main():",
					'    answers = await judge("hello", {',
					'        "ok": {"type": "bool", "instructions": "fake?", "criteria": {"true": "yes please", "false": "no"}},',
					'        "pick": {"type": "choice", "instructions": "which?", "criteria": {"a": None, "b": "bee"}},',
					"    })",
					"    print(json.dumps(answers, sort_keys=True))",
					"asyncio.run(main())",
				].join("\n"),
				DIRECT_ENV(server.url.toString()),
			);

			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.trim())).toEqual({
				ok: { type: "bool", bool: 1 },
				pick: { type: "choice", choice: "b", confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
			});
			expect(requests).toEqual([
				{
					url: "/v1/systemone",
					authorization: "Bearer ts-key",
					body: {
						state: "hello",
						model: "jev-preview",
						questions: {
							ok: { type: "noul", instructions: "fake?", criteria: { true: "yes please", false: "no" } },
							pick: { type: "choice", instructions: "which?", criteria: { a: null, b: "bee" } },
						},
					},
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("judge_batch() runs kernel-local with per-item retry, drain cursor, and attach", async () => {
		const attempts: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { state?: string };
				const state = body.state ?? "";
				attempts.push(state);
				// "world" never succeeds; "hello" succeeds on its second attempt.
				if (state === "world") return new Response("boom", { status: 500 });
				if (attempts.filter(attempt => attempt === "hello").length < 2) {
					return new Response("flaky", { status: 500 });
				}
				return Response.json({
					model: "jev-preview",
					answers: { q: { type: "noul", noul: 1 } },
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			},
		});

		try {
			const result = await runPrelude(
				[
					"async def main():",
					'    b = judge_batch({"x": "hello", "y": "world"}, {"q": {"type": "bool", "instructions": "non-empty?"}}, retries=2)',
					"    items = []",
					"    while True:",
					"        got = await b.drain(timeout=10)",
					"        if not got:",
					"            break",
					"        items += got",
					"    status = b.status()",
					"    print(json.dumps({",
					'        "ok_keys": sorted(k for k, item in items if item.ok),',
					'        "failed_keys": sorted(b.failed().keys()),',
					'        "results": b.results(),',
					'        "done": status["done"],',
					'        "failed": status["failed"],',
					'        "total": status["total"],',
					'        "model": status.get("model"),',
					'        "attach_same": judge_batch.attach(b.id).id == b.id,',
					"    }, sort_keys=True))",
					"asyncio.run(main())",
				].join("\n"),
				DIRECT_ENV(server.url.toString()),
			);

			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(attempts.filter(attempt => attempt === "hello").length).toBe(2);
			expect(attempts.filter(attempt => attempt === "world").length).toBe(9);
			const value = JSON.parse(result.stdout.trim());
			expect(value).toEqual({
				ok_keys: ["x"],
				failed_keys: ["y"],
				results: { x: { q: { type: "bool", bool: 1 } } },
				done: 2,
				failed: 1,
				total: 2,
				model: "typesafe/jev-preview",
				attach_same: true,
			});
		} finally {
			server.stop(true);
		}
	});

	it("judge_batch() raises from drain() when min_ok cannot be met", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("down", { status: 503 }),
		});

		try {
			const result = await runPrelude(
				[
					"async def main():",
					'    b = judge_batch({"x": "hello"}, {"q": {"type": "bool", "instructions": "non-empty?"}}, retries=0, min_ok=1)',
					"    drained = []",
					"    try:",
					"        while True:",
					"            drained += await b.drain(timeout=10)",
					'        print("NO ERROR (BAD)")',
					"    except RuntimeError as exc:",
					'        print("RAISED:", len(drained) == 1 and "only 0/1 item(s) judged" in str(exc) and "min_ok=1" in str(exc))',
					"    b.close()",
					"    try:",
					"        judge_batch.attach(b.id)",
					'        print("ATTACH (BAD)")',
					"    except RuntimeError as exc:",
					'        print("ATTACH_GONE:", "eval tool bridge unreachable at" in str(exc))',
					"asyncio.run(main())",
				].join("\n"),
				{
					...DIRECT_ENV(server.url.toString()),
					// Closed local run attaches via bridge; dead URL hits the typed error.
					PI_TOOL_BRIDGE_URL: "http://127.0.0.1:1",
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines[0]).toBe("RAISED: True");
			expect(lines[1]).toBe("ATTACH_GONE: True");
		} finally {
			server.stop(true);
		}
	});

	it("names the calling helper when a host-mediated helper lacks the bridge", async () => {
		const result = await runPrelude(
			[
				"async def main():",
				"    errors = []",
				"    async def label(call):",
				"        try:",
				"            await call()",
				'            errors.append("no-error")',
				"        except RuntimeError as exc:",
				'            errors.append(str(exc).split(" cannot run:")[0])',
				'    await label(lambda: tool.read({"path": "x"}))',
				'    await label(lambda: _omp_prelude("omp_find", {}))',
				'    await label(lambda: wait([_Handle("missing")], timeout=0))',
				"    for start in (lambda: completion('hi'), lambda: agent('hi')):",
				"        try:",
				"            start()",
				'            errors.append("no-error")',
				"        except RuntimeError as exc:",
				'            errors.append(str(exc).split(" cannot run:")[0])',
				"    print(json.dumps(errors))",
				"",
				"asyncio.run(main())",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const errors = JSON.parse(result.stdout.trim());
		// Each surface reports the helper the cell actually called, not a generic bridge error.
		expect(errors).toEqual(["tool.read(...)", "omp_find() prelude helper", "wait()", "completion()", "agent()"]);
	});

	it("rejects judge() arguments client-side without touching the network", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests++;
				await request.json();
				return Response.json({ model: "jev-1.13", answers: {}, usage: {} });
			},
		});

		try {
			const result = await runPrelude(
				[
					"async def main():",
					"    errors = []",
					'    for questions in ({"q": {"type": "choice", "instructions": "x", "criteria": {"only": None}}},',
					'                      {"q": {"type": "score", "instructions": "x", "criteria": ["only-one"]}},',
					'                      {"q": {"type": "nope", "instructions": "x"}}):',
					"        try:",
					'            await judge("hello", questions)',
					'            errors.append("no-error")',
					"        except TypeError as exc:",
					'            errors.append(str(exc).split(": ")[1])',
					"    print(json.dumps(errors))",
					"asyncio.run(main())",
				].join("\n"),
				DIRECT_ENV(server.url.toString()),
			);

			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.trim())).toEqual([
				'choice question "q" needs at least two options',
				'score question "q" needs at least two levels',
				'question "q" type must be "choice", "bool", or "score"',
			]);
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("surfaces a typed error when the bridge endpoint is unreachable", async () => {
		const result = await runPrelude(
			[
				"async def main():",
				"    try:",
				'        await tool.read({"path": "packages/package.json"})',
				'        print("NO ERROR (BAD)")',
				"    except RuntimeError as exc:",
				"        print(str(exc))",
				"asyncio.run(main())",
			].join("\n"),
			{
				PI_TOOL_BRIDGE_URL: "http://127.0.0.1:1",
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("eval tool bridge unreachable at http://127.0.0.1:1");
		expect(result.stdout).toContain("'test-session'");
		expect(result.stdout).not.toContain("Traceback");
	});
});
