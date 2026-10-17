import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type ExtensionModule, extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { readConfiguredExtensions } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("native configured extensions listing", () => {
	let state: SettingsTestState | undefined;
	let root: string;
	let home: string;
	let project: string;

	beforeEach(async () => {
		state = beginSettingsTest();
		// The host's PI_CONFIG_DECLARATIVE_FILES/PI_CONFIG_FILES blend the real
		// nix-store extensions into every load; tests here own the full config chain.
		delete process.env.PI_CONFIG_DECLARATIVE_FILES;
		delete process.env.PI_CONFIG_FILES;
		delete Bun.env.PI_CONFIG_DECLARATIVE_FILES;
		delete Bun.env.PI_CONFIG_FILES;
		clearFsCache();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-configured-ext-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
		await fs.mkdir(path.join(project, ".omp"), { recursive: true });
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		vi.restoreAllMocks();
		await removeWithRetries(root);
	});

	const loadModules = async (): Promise<ExtensionModule[]> => {
		const result = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			cwd: project,
			includeDisabled: true,
			providers: ["native"],
		});
		return result.items;
	};

	test("lists extensions configured in global config.yml (dashboard regression)", async () => {
		// Regression: the native provider read only legacy settings.json, so an
		// extension configured via YAML (incl. the declarative layer) ran at
		// startup but never showed in /extensions.
		const configured = path.join(root, "pkg-a", "ext.ts");
		await fs.mkdir(path.dirname(configured), { recursive: true });
		await fs.writeFile(configured, "export default function(pi) {}");
		await fs.writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${configured}\n`);

		const settings = await Settings.init({ cwd: project, agentDir: path.join(home, ".omp", "agent") });
		const release = initializeWithSettings(settings);
		try {
			const items = await loadModules();
			expect(items.map(item => item.path)).toContain(configured);
		} finally {
			release();
		}
	});

	test("lists extensions from the scopeless persisted-config path with no bound settings", async () => {
		const configured = path.join(root, "pkg-b", "ext.ts");
		await fs.mkdir(path.dirname(configured), { recursive: true });
		await fs.writeFile(configured, "export default function(pi) {}");
		await fs.writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${configured}\n`);

		const release = initializeWithSettings(Settings.isolated());
		try {
			const items = await loadModules();
			expect(items.map(item => item.path)).toContain(configured);
		} finally {
			release();
		}
	});

	test("does not duplicate a configured path already read from legacy settings.json", async () => {
		const configured = path.join(root, "pkg-c", "ext.ts");
		await fs.mkdir(path.dirname(configured), { recursive: true });
		await fs.writeFile(configured, "export default function(pi) {}");
		await fs.writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${configured}\n`);
		await fs.writeFile(
			path.join(home, ".omp", "agent", "settings.json"),
			JSON.stringify({ extensions: [configured] }),
		);

		const settings = await Settings.init({ cwd: project, agentDir: path.join(home, ".omp", "agent") });
		const release = initializeWithSettings(settings);
		try {
			const items = await loadModules();
			expect(items.filter(item => item.path === configured)).toHaveLength(1);
		} finally {
			release();
		}
	});

	test("prefers project config over user config for the configured level", async () => {
		const userExt = path.join(root, "user-ext.ts");
		const projectExt = path.join(root, "project-ext.ts");
		await fs.writeFile(userExt, "export default function(pi) {}");
		await fs.writeFile(projectExt, "export default function(pi) {}");
		await fs.writeFile(path.join(project, ".omp", "config.yml"), `extensions:\n  - ${projectExt}\n`);
		await fs.writeFile(path.join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${userExt}\n`);

		const persisted = await readConfiguredExtensions({ cwd: project, home, repoRoot: project } as LoadContext);
		expect(persisted).toEqual({ entries: [projectExt], level: "project" });

		const release = initializeWithSettings(Settings.isolated());
		try {
			const items = await loadModules();
			expect(items.map(item => item.path)).toContain(projectExt);
			expect(items.map(item => item.path)).not.toContain(userExt);
		} finally {
			release();
		}
	});

	test("warns on a missing legacy settings.json path but not on a missing configured path", async () => {
		await fs.writeFile(
			path.join(home, ".omp", "agent", "settings.json"),
			JSON.stringify({ extensions: [path.join(root, "missing-legacy.ts")] }),
		);
		await fs.writeFile(
			path.join(home, ".omp", "agent", "config.yml"),
			`extensions:\n  - ${path.join(root, "missing-config.ts")}\n`,
		);

		const settings = await Settings.init({ cwd: project, agentDir: path.join(home, ".omp", "agent") });
		const release = initializeWithSettings(settings);
		try {
			const result = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
				cwd: project,
				includeDisabled: true,
				providers: ["native"],
			});
			// The runtime loader owns the "cannot load configured extension" error;
			// the provider only warns about legacy spelling it cannot attribute.
			expect(result.warnings.join("\n")).toContain("missing-legacy.ts");
			expect(result.warnings.join("\n")).not.toContain("missing-config.ts");
		} finally {
			release();
		}
	});
});
