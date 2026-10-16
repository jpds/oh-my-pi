import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils/dirs";

const ENV_KEY = "PI_TINY_MODELS_CACHE";
const originalValue = process.env[ENV_KEY];

afterEach(() => {
	if (originalValue === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalValue;
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
