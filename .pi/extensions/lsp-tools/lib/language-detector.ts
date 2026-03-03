import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ALL_CONFIGS, TIER1_CONFIGS, type LanguageConfig } from "./language-configs.js";

export interface DetectedLanguage {
	key: string;
	config: LanguageConfig;
	status: "ready" | "installable" | "missing-runtime" | "manual";
}

interface DetectorContext {
	cwd: string;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, type: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
}

/**
 * Detect languages from a given config set and check what's installed.
 */
async function detectLanguagesFromConfigs(
	pi: ExtensionAPI,
	cwd: string,
	configs: Record<string, LanguageConfig>
): Promise<DetectedLanguage[]> {
	const detected: DetectedLanguage[] = [];
	const handledServers = new Set<string>();

	for (const [key, config] of Object.entries(configs)) {
		const found = await detectLanguage(pi, config, cwd);
		if (!found) continue;

		// Skip duplicate server checks (TS and JS share the same server)
		if (handledServers.has(config.server.command)) {
			const existing = detected.find((d) => d.config.server.command === config.server.command);
			if (existing && existing.status === "ready") {
				detected.push({ key, config, status: "ready" });
			}
			continue;
		}
		handledServers.add(config.server.command);

		// Is the LSP server already installed?
		const serverInstalled = await isCommandAvailable(pi, config.server.command);
		if (serverInstalled) {
			detected.push({ key, config, status: "ready" });
			continue;
		}

		// Is the runtime installed?
		const runtimeInstalled = await isCommandAvailable(pi, config.runtime.command);
		if (!runtimeInstalled) {
			detected.push({ key, config, status: "missing-runtime" });
			continue;
		}

		// Auto-installable?
		if (config.server.autoInstallable) {
			detected.push({ key, config, status: "installable" });
		} else {
			detected.push({ key, config, status: "manual" });
		}
	}

	return detected;
}

/**
 * Detect ALL languages (Tier 1 + Tier 2). Used by /lsp-setup command.
 */
export async function detectLanguages(pi: ExtensionAPI, cwd: string): Promise<DetectedLanguage[]> {
	return detectLanguagesFromConfigs(pi, cwd, ALL_CONFIGS);
}

/**
 * Phase 2: For installable servers, prompt user and install.
 * Called from /lsp-setup command -- uses interactive dialogs.
 */
export async function installMissingServers(
	pi: ExtensionAPI,
	ctx: DetectorContext,
	languages: DetectedLanguage[]
): Promise<DetectedLanguage[]> {
	const results: DetectedLanguage[] = [];

	for (const lang of languages) {
		if (lang.status === "ready") {
			results.push(lang);
			continue;
		}

		if (lang.status === "missing-runtime") {
			ctx.ui.notify(
				`${lang.config.name}: ${lang.config.runtime.command} not found.\n${lang.config.runtime.installHint}`,
				"warning"
			);
			continue;
		}

		if (lang.status === "manual") {
			const hint = lang.config.server.manualInstallHint || `Install ${lang.config.server.name} manually.`;
			ctx.ui.notify(`${lang.config.name}: ${lang.config.server.name} not installed.\n${hint}`, "warning");
			continue;
		}

		if (lang.status === "installable") {
			const ok = await ctx.ui.confirm(
				`${lang.config.name} project detected`,
				`Install ${lang.config.server.name} LSP server?\n\n  ${lang.config.server.installCommand}`
			);

			if (!ok) continue;

			ctx.ui.setStatus("lsp", `Installing ${lang.config.server.name}...`);
			try {
				const result = await pi.exec("bash", ["-c", lang.config.server.installCommand], {
					timeout: 120_000,
				});
				if (result.code === 0) {
					results.push({ ...lang, status: "ready" });
					ctx.ui.notify(`${lang.config.server.name} installed.`, "info");
				} else {
					const errorMsg = result.stderr || result.stdout || "Unknown error";
					ctx.ui.notify(`${lang.config.server.name} install failed:\n${errorMsg}`, "error");
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`${lang.config.server.name} install error: ${msg}`, "error");
			}
		}
	}

	return results.filter((d) => d.status === "ready");
}

/**
 * Combined: detect + auto-start ready servers + notify about missing ones.
 * Used in session_start (non-interactive).
 *
 * Checks ALL languages (Tier 1 + Tier 2). Source file requirement
 * prevents false positives (e.g., build.gradle in Unity won't trigger Java).
 */
export async function detectAndSetup(
	pi: ExtensionAPI,
	ctx: DetectorContext
): Promise<DetectedLanguage[]> {
	const all = await detectLanguages(pi, ctx.cwd);
	const ready: DetectedLanguage[] = [];
	const installable: string[] = [];
	const manual: string[] = [];

	for (const lang of all) {
		switch (lang.status) {
			case "ready":
				ready.push(lang);
				break;
			case "installable":
				installable.push(`${lang.config.name} (${lang.config.server.name})`);
				break;
			case "missing-runtime":
				ctx.ui.notify(
					`${lang.config.name} detected but ${lang.config.runtime.command} not found. ${lang.config.runtime.installHint}`,
					"warning"
				);
				break;
			case "manual": {
				const hint = lang.config.server.manualInstallHint || `Install ${lang.config.server.name} manually.`;
				manual.push(`${lang.config.name}: ${hint}`);
				break;
			}
		}
	}

	if (installable.length > 0) {
		ctx.ui.notify(
			`LSP servers available for: ${installable.join(", ")}.\nRun /lsp-setup to install.`,
			"info"
		);
	}

	for (const msg of manual) {
		ctx.ui.notify(msg, "warning");
	}

	return ready;
}

/**
 * Check if a language is present in the project by scanning for
 * marker files and file extensions.
 */
/** Directories to exclude from language detection. */
const EXCLUDED_DIRS = [
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
	"vendor", "__pycache__", ".venv", "venv", "target", "bin", "obj",
	".pi", ".cache", "coverage", ".tox", ".eggs",
];

const FIND_PRUNE_ARGS = EXCLUDED_DIRS.flatMap((dir) => ["-path", `./${dir}`, "-prune", "-o"]);

async function detectLanguage(pi: ExtensionAPI, config: LanguageConfig, cwd: string): Promise<boolean> {
	// Must find at least one source file with a matching extension.
	// Marker files alone are not enough (e.g., build.gradle in a Unity project doesn't mean Java).
	let hasSourceFile = false;

	for (const ext of config.detect.extensions) {
		try {
			const result = await pi.exec(
				"find",
				[".", "-maxdepth", "3", ...FIND_PRUNE_ARGS, "-name", `*${ext}`, "-type", "f", "-print", "-quit"],
				{ timeout: 5000 }
			);
			if (result.stdout.trim()) {
				hasSourceFile = true;
				break;
			}
		} catch {
			// Ignore find errors
		}
	}

	if (!hasSourceFile) return false;

	// If marker files are defined, require at least one to confirm this is a real project
	// (not just a stray file). If no marker files defined, source files alone are sufficient.
	if (config.detect.markerFiles && config.detect.markerFiles.length > 0) {
		for (const pattern of config.detect.markerFiles) {
			try {
				const result = await pi.exec(
					"find",
					[".", "-maxdepth", "3", ...FIND_PRUNE_ARGS, "-name", pattern, "-type", "f", "-print", "-quit"],
					{ timeout: 5000 }
				);
				if (result.stdout.trim()) return true;
			} catch {
				// Ignore find errors
			}
		}
		// Has source files but no marker files -- still detect (could be a simple script project)
	}

	return hasSourceFile;
}

/** Check if a command is available in PATH. */
async function isCommandAvailable(pi: ExtensionAPI, command: string): Promise<boolean> {
	try {
		const result = await pi.exec("which", [command], { timeout: 5000 });
		return result.code === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	}
}
