import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getTinyModelsCacheDir, getTinyModelsRuntimesDir } from "@oh-my-pi/pi-utils/dirs";

const ENV_KEY = "PI_TINY_MODELS_CACHE";
const RUNTIMES_KEY = "PI_TINY_MODELS_RUNTIMES";
const originalValue = process.env[ENV_KEY];
const originalRuntimesValue = process.env[RUNTIMES_KEY];

afterEach(() => {
	if (originalValue === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalValue;
	if (originalRuntimesValue === undefined) delete process.env[RUNTIMES_KEY];
	else process.env[RUNTIMES_KEY] = originalRuntimesValue;
});

describe("tiny models cache dir override", () => {
	it("prefers PI_TINY_MODELS_CACHE over the agent dir, including an explicit one", () => {
		delete process.env[ENV_KEY];
		const agentDir = path.join(os.homedir(), ".omp", "agent");
		expect(getTinyModelsCacheDir()).toBe(path.join(agentDir, "cache", "tiny-models"));
		expect(getTinyModelsCacheDir(agentDir)).toBe(path.join(agentDir, "cache", "tiny-models"));

		const storeDir = path.join(os.tmpdir(), "nix-store", "tiny-models");
		process.env[ENV_KEY] = storeDir;
		expect(getTinyModelsCacheDir()).toBe(storeDir);
		expect(getTinyModelsCacheDir(agentDir)).toBe(storeDir);
	});

	it("keeps redirects machine-global: ignores PI_CODING_AGENT_DIR entirely", () => {
		// Nothing to wire: getTinyModelsCacheDir reads only PI_TINY_MODELS_CACHE; the
		// contract under test is that an explicit agentDir does not bypass the override.
		const storeDir = path.join(os.tmpdir(), "nix-store-tiny");
		process.env[ENV_KEY] = storeDir;
		expect(getTinyModelsCacheDir(path.join(os.tmpdir(), "some-other-agent"))).toBe(storeDir);
	});

	it("~-expands the override and rejects relative values", () => {
		process.env[ENV_KEY] = "~/nix-store/tiny-models";
		expect(getTinyModelsCacheDir()).toBe(path.join(os.homedir(), "nix-store/tiny-models"));

		process.env[ENV_KEY] = "./relative/tiny-models";
		expect(getTinyModelsCacheDir()).not.toContain("relative"); // falls back to agent subdir
	});
});

describe("tiny models runtimes dir override", () => {
	it("defaults under the cache dir so the cache override relocates runtimes", () => {
		delete process.env[RUNTIMES_KEY];
		process.env[ENV_KEY] = "/var/lib/omp/tiny-models";
		expect(getTinyModelsRuntimesDir()).toBe("/var/lib/omp/tiny-models/runtimes");
	});

	it("prefers PI_TINY_MODELS_RUNTIMES over the cache-derived root, independent of the cache override", () => {
		const runtimesDir = path.join(os.tmpdir(), "writable", "omp-runtimes");
		process.env[RUNTIMES_KEY] = runtimesDir;
		process.env[ENV_KEY] = path.join(os.tmpdir(), "nix-store", "tiny-models");
		expect(getTinyModelsRuntimesDir()).toBe(runtimesDir);
		expect(getTinyModelsRuntimesDir(path.join(os.tmpdir(), "some-other-agent"))).toBe(runtimesDir);
	});

	it("~-expands the override and rejects relative values", () => {
		delete process.env[ENV_KEY];
		process.env[RUNTIMES_KEY] = "~/omp/runtimes";
		expect(getTinyModelsRuntimesDir()).toBe(path.join(os.homedir(), "omp/runtimes"));

		process.env[RUNTIMES_KEY] = "relative/runtimes";
		expect(getTinyModelsRuntimesDir()).not.toContain("relative"); // falls back to cache subdir
	});
});
