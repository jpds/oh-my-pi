import { describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";
const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPrelude(
	code: string,
	env: Record<string, string>,
	setup?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = setup ? `${prelude}\n${setup}\n${code}` : `${prelude}\n${code}`;
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
describe("python host-mediated judgment (runner stdio channel)", () => {
	// The runner injects `__omp_host_bridge__(name, args)`; a kernel with no
	// HTTP tool bridge reaches every host-mediated helper through it. Stub it in
	// the prelude's own namespace so the standalone script exercises the real
	// dispatch path without a host process.
	const CHANNEL_SETUP = [
		"__omp_calls__ = []",
		"__omp_settled__ = [",
		'    {"key": "0", "answers": {"q": {"type": "bool", "bool": 1}}, "model": "typesafe/jev-preview"},',
		'    {"key": "1", "answers": {"q": {"type": "bool", "bool": 0}}, "model": "typesafe/jev-preview"},',
		"]",
		"__omp_drains__ = [0]",
		"def __omp_host_bridge__(name, args):",
		"    __omp_calls__.append((name, args))",
		'    if name == "__judge__":',
		'        return {"answers": {"q": {"type": "bool", "bool": 1}}, "model": "typesafe/jev-preview"}',
		'    if name == "__judge_batch__":',
		'        op = args.get("op")',
		'        if op in ("create", "attach"):',
		'            return {"id": "jdgb-stub", "total": len(__omp_settled__), "intent": args.get("intent") or "Judging"}',
		'        if op == "drain":',
		"            seen = __omp_drains__[0]",
		"            __omp_drains__[0] = seen + 1",
		'            return {"items": __omp_settled__ if seen == 0 else []}',
		'        if op == "results":',
		'            return {"results": {item["key"]: item for item in __omp_settled__}}',
		'        if op == "failed":',
		'            return {"failed": {item["key"]: item["error"] for item in __omp_settled__ if item.get("error")}}',
		'        if op == "status":',
		'            return {"intent": "Judging", "done": 2, "total": 2, "failed": 0, "cost": 0.0004, "running": False}',
		'        if op == "cancel":',
		'            return {"cancelled": True}',
		"        return {}",
	].join("\n");

	it("judge() forwards cell questions over the runner channel and returns the host answers", async () => {
		const result = await runPrelude(
			[
				"async def main():",
				'    answers = await judge("hello", {"q": {"type": "bool", "instructions": "non-empty?"}})',
				'    print(json.dumps({"answers": answers, "calls": __omp_calls__}, sort_keys=True))',
				"asyncio.run(main())",
			].join("\n"),
			{},
			CHANNEL_SETUP,
		);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			answers: { q: { type: "bool", bool: 1 } },
			calls: [["__judge__", { state: "hello", questions: { q: { type: "bool", instructions: "non-empty?" } } }]],
		});
	});

	it("judge_batch() drives the host run over the runner channel and wraps its items", async () => {
		const result = await runPrelude(
			[
				"async def main():",
				'    b = judge_batch(["one", "two"], {"q": {"type": "bool", "instructions": "non-empty?"}}, intent="Triage")',
				"    drained = []",
				"    while True:",
				"        got = await b.drain(timeout=10)",
				"        if not got:",
				"            break",
				"        drained += got",
				"    print(json.dumps({",
				'        "id": b.id,',
				'        "drain_keys": [k for k, _ in drained],',
				'        "item_keys": [item["key"] for _, item in drained],',
				'        "ok": [item.ok for _, item in drained],',
				'        "answers": [item.answers for _, item in drained],',
				'        "results": sorted(b.results().keys()),',
				'        "failed": b.failed(),',
				'        "cost": b.status()["cost"],',
				'        "attach": judge_batch.attach(b.id).id,',
				'        "cancelled": b.cancel(),',
				'        "ops": [args["op"] for _, args in __omp_calls__],',
				'        "create_args": __omp_calls__[0][1],',
				"    }, sort_keys=True))",
				"asyncio.run(main())",
			].join("\n"),
			{},
			CHANNEL_SETUP,
		);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			id: "jdgb-stub",
			drain_keys: ["0", "1"],
			item_keys: ["0", "1"],
			ok: [true, true],
			answers: [{ q: { type: "bool", bool: 1 } }, { q: { type: "bool", bool: 0 } }],
			results: ["0", "1"],
			failed: {},
			cost: 0.0004,
			attach: "jdgb-stub",
			cancelled: true,
			ops: ["create", "drain", "drain", "results", "failed", "status", "attach", "cancel"],
			create_args: {
				op: "create",
				items: [
					{ key: "0", state: "one" },
					{ key: "1", state: "two" },
				],
				questions: { q: { type: "bool", instructions: "non-empty?" } },
				intent: "Triage",
			},
		});
	});

	it("prefers the configured HTTP tool bridge over the runner channel", async () => {
		// A configured bridge wins even when it is dead: the call fails with the
		// typed bridge error instead of silently falling back to the channel.
		const result = await runPrelude(
			[
				"async def main():",
				"    try:",
				'        await judge("hello", {"q": {"type": "bool", "instructions": "non-empty?"}})',
				'        print("NO ERROR (BAD)")',
				"    except RuntimeError as exc:",
				"        print(json.dumps({",
				'            "bridged": "eval tool bridge unreachable" in str(exc),',
				'            "channel_calls": len(__omp_calls__),',
				"        }, sort_keys=True))",
				"asyncio.run(main())",
			].join("\n"),
			{
				PI_TOOL_BRIDGE_URL: "http://127.0.0.1:1",
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			},
			CHANNEL_SETUP,
		);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ bridged: true, channel_calls: 0 });
	});

	it("rejects malformed list-form questions before reaching the channel", async () => {
		const result = await runPrelude(
			[
				"async def main():",
				"    errors = []",
				"    for questions in (",
				'        [{"type": "bool", "instructions": "x"}],',
				'        [{"id": "a", "type": "bool", "instructions": "x"}, {"id": "a", "type": "bool", "instructions": "y"}],',
				"        [],",
				"    ):",
				"        try:",
				'            await judge("hello", questions)',
				'            errors.append("no-error")',
				"        except TypeError as exc:",
				"            errors.append(str(exc))",
				'    print(json.dumps({"errors": errors, "channel_calls": len(__omp_calls__)}, sort_keys=True))',
				"asyncio.run(main())",
			].join("\n"),
			{},
			CHANNEL_SETUP,
		);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			errors: [
				'question entry 0 must carry a non-empty string "id" (or pass questions as a dict keyed by id)',
				'duplicate question id "a"',
				"judge() received invalid arguments: questions must contain at least one question",
			],
			channel_calls: 0,
		});
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

	it("judges over the channel with no credential in the kernel", async () => {
		// The host holds the judge transport: the cell sees no PI_JUDGE_DIRECT
		// and no descriptor-returning accessor, only the call-only channel.
		const result = await runPrelude(
			[
				"import os as _os",
				"async def main():",
				'    answers = await judge("hello", {"q": {"type": "bool", "instructions": "non-empty?"}})',
				"    print(json.dumps({",
				'        "answers": answers,',
				'        "judge_env": _os.environ.get("PI_JUDGE_DIRECT"),',
				'        "accessor": "__omp_judge_direct__" in globals(),',
				'        "channel": callable(globals().get("__omp_host_bridge__")),',
				"    }, sort_keys=True))",
				"asyncio.run(main())",
			].join("\n"),
			{},
			CHANNEL_SETUP,
		);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			answers: { q: { type: "bool", bool: 1 } },
			judge_env: null,
			accessor: false,
			channel: true,
		});
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
