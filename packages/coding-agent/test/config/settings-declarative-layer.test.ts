import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgProvidersMaxInFlightRequests, cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("settings declarative layer", () => {
	let state: SettingsTestState | undefined;
	let testDir: string;
	let projectDir: string;
	let agentDir: string;
	let declarativePath: string;
	let overlayPath: string;

	beforeEach(() => {
		state = beginSettingsTest();
		testDir = path.join(os.tmpdir(), "test-config-declarative", Snowflake.next());
		projectDir = path.join(testDir, "project");
		agentDir = path.join(testDir, "agent");
		declarativePath = path.join(testDir, "declarative.yml");
		overlayPath = path.join(testDir, "overlay.yml");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	const writeYaml = (file: string, settings: Record<string, unknown>) => Bun.write(file, YAML.stringify(settings));
	const writeGlobal = (settings: Record<string, unknown>) => writeYaml(path.join(agentDir, "config.yml"), settings);
	const useDeclarativeFiles = (files: string[] = [declarativePath]) => {
		process.env.PI_CONFIG_DECLARATIVE_FILES = files.join(path.delimiter);
	};

	it("supplies a value until an in-session edit outranks it", async () => {
		await writeYaml(declarativePath, { temperature: 0.9 });
		useDeclarativeFiles();

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgTemperature.get(settings)).toBe(0.9);
		expect(cfgTemperature.provenance(settings)).toBe("declarative");

		cfgTemperature.set(settings, 0.5);
		await settings.flush();
		expect(cfgTemperature.get(settings)).toBe(0.5);
		expect(cfgTemperature.provenance(settings)).toBe("global");
	});

	it("ranks below global config, an explicit overlay, and runtime overrides", async () => {
		await writeYaml(declarativePath, { temperature: 0.9 });
		await writeGlobal({ temperature: 0.5 });
		await writeYaml(overlayPath, { temperature: 0.7 });
		useDeclarativeFiles();

		const settings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
		expect(cfgTemperature.get(settings)).toBe(0.7);
		expect(cfgTemperature.provenance(settings)).toBe("overlay");

		cfgTemperature.override(settings, 0.3);
		expect(cfgTemperature.get(settings)).toBe(0.3);
		expect(cfgTemperature.provenance(settings)).toBe("runtime");

		cfgTemperature.clearOverride(settings);
		expect(cfgTemperature.get(settings)).toBe(0.7);
	});

	it("deep-merges records with the global config and replaces arrays wholesale", async () => {
		await writeYaml(declarativePath, {
			providers: { maxInFlightRequests: { openai: 2 } },
			enabledModels: ["model-a", "model-b"],
		});
		await writeGlobal({
			providers: { maxInFlightRequests: { anthropic: 3 } },
			enabledModels: ["model-c"],
		});
		useDeclarativeFiles();

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2, anthropic: 3 });
		expect(cfgEnabledModels.get(settings)).toEqual(["model-c"]);
	});

	it("reads several declarative config files in order, later files winning key by key", async () => {
		const secondPath = path.join(testDir, "declarative-2.yml");
		await writeYaml(declarativePath, { temperature: 0.9, compaction: { enabled: false } });
		await writeYaml(secondPath, { temperature: 0.4 });
		useDeclarativeFiles([declarativePath, secondPath]);

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgTemperature.get(settings)).toBe(0.4);
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
	});

	it("rejects a missing declarative config file instead of silently dropping the layer", async () => {
		useDeclarativeFiles([path.join(testDir, "absent.yml")]);

		await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow("Declarative config file not found:");
	});

	it("rejects a malformed declarative config file", async () => {
		await Bun.write(declarativePath, "compaction: [unclosed\n");
		useDeclarativeFiles();

		await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
			"Failed to parse declarative config file",
		);
	});

	it("applies a rewritten declarative config file on reload", async () => {
		await writeYaml(declarativePath, { temperature: 0.9 });
		useDeclarativeFiles();
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(cfgTemperature.get(settings)).toBe(0.9);

		await writeYaml(declarativePath, { temperature: 0.4 });
		await settings.reloadFromDisk();
		expect(cfgTemperature.get(settings)).toBe(0.4);
		expect(cfgTemperature.provenance(settings)).toBe("declarative");
	});

	it("releases a soft-pinned default once the declarative config file supplies the setting", async () => {
		await writeYaml(declarativePath, {});
		useDeclarativeFiles();
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		cfgTemperature.pinDefault(settings);
		expect(cfgTemperature.provenance(settings)).toBe("runtime");

		await writeYaml(declarativePath, { temperature: 0.4 });
		await settings.reloadFromDisk();
		expect(cfgTemperature.get(settings)).toBe(0.4);
		expect(cfgTemperature.provenance(settings)).toBe("declarative");
	});

	it("attributes model roles and presets to the declarative layer", async () => {
		await writeYaml(declarativePath, {
			modelRoles: { smol: "anthropic/claude-haiku-4-5" },
			modelPresets: { pinned: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } } },
		});
		useDeclarativeFiles();

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRoleProvenance("smol")).toBe("declarative");
		expect(settings.getOwnedModelPreset("pinned")?.source).toBe("declarative");
	});

	it("names the file that supplied a broken shellPath", async () => {
		const bogus = path.join(testDir, "no-such-shell");
		await writeYaml(declarativePath, { shellPath: bogus });
		useDeclarativeFiles();

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(() => settings.getShellConfig()).toThrow(`Please update shellPath in ${declarativePath}`);

		// The global config outranks the declarative config file, so it is the file named instead.
		await writeGlobal({ shellPath: bogus });
		resetSettingsForTest();
		const rescoped = await Settings.init({ cwd: projectDir, agentDir });
		expect(() => rescoped.getShellConfig()).toThrow(
			`Please update shellPath in ${path.join(agentDir, "config.yml")}`,
		);
	});

	it("resolves relative declarative paths against the cwd for child processes", async () => {
		await writeYaml(path.join(testDir, "declarative.yml"), { temperature: 0.9 });
		process.env.PI_CONFIG_DECLARATIVE_FILES = "declarative.yml";

		const settings = await Settings.init({ cwd: testDir, agentDir });
		expect(settings.getConfigDeclarativeFiles()).toEqual([path.join(testDir, "declarative.yml")]);
		expect(cfgTemperature.get(settings)).toBe(0.9);
	});
});
