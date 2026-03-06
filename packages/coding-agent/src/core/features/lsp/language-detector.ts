import { execCommand } from "../../exec.js";
import { ALL_CONFIGS, type LanguageConfig } from "./language-configs.js";

export interface DetectedLanguage {
	key: string;
	config: LanguageConfig;
	status: "ready" | "installable" | "missing-runtime" | "manual";
}

/** Directories excluded from language detection `find` scans. */
export const EXCLUDED_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	"target",
	"bin",
	"obj",
	".pi",
	".cache",
	"coverage",
	".tox",
	".eggs",
];

const FIND_PRUNE_ARGS = EXCLUDED_DIRS.flatMap((dir) => ["-path", `./${dir}`, "-prune", "-o"]);

/**
 * Detect all supported languages present in the project by scanning source
 * files and marker files, then check server/runtime availability.
 */
export async function detectLanguages(cwd: string): Promise<DetectedLanguage[]> {
	const detected: DetectedLanguage[] = [];
	const handledServers = new Set<string>();

	for (const [key, config] of Object.entries(ALL_CONFIGS)) {
		const found = await detectLanguage(config, cwd);
		if (!found) continue;

		// TypeScript and JavaScript share the same server; reuse status if already resolved.
		if (handledServers.has(config.server.command)) {
			const existing = detected.find((d) => d.config.server.command === config.server.command);
			if (existing && existing.status === "ready") {
				detected.push({ key, config, status: "ready" });
			}
			continue;
		}
		handledServers.add(config.server.command);

		const serverInstalled = await isCommandAvailable(config.server.command);
		if (serverInstalled) {
			detected.push({ key, config, status: "ready" });
			continue;
		}

		const runtimeInstalled = await isCommandAvailable(config.runtime.command);
		if (!runtimeInstalled) {
			detected.push({ key, config, status: "missing-runtime" });
			continue;
		}

		if (config.server.autoInstallable) {
			detected.push({ key, config, status: "installable" });
		} else {
			detected.push({ key, config, status: "manual" });
		}
	}

	return detected;
}

/**
 * Non-interactive version for session_start.
 * Returns only "ready" languages; the caller handles notifications.
 * Does NOT auto-install anything.
 */
export async function detectAndSetup(cwd: string): Promise<DetectedLanguage[]> {
	const all = await detectLanguages(cwd);
	return all.filter((lang) => lang.status === "ready");
}

/**
 * Interactive version for /lsp-setup.
 * Prompts the user to install missing servers and returns the languages
 * that ended up ready (including those that were already ready).
 *
 * @param languages  Result of `detectLanguages()`
 * @param confirm    Prompt the user for a yes/no decision
 * @param notify     Display an informational message to the user
 * @param exec       Run a shell command; receives the raw install command string
 */
export async function installMissingServers(
	languages: DetectedLanguage[],
	confirm: (title: string, message: string) => Promise<boolean>,
	notify: (message: string, type: "info" | "warning" | "error") => void,
	exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<DetectedLanguage[]> {
	const results: DetectedLanguage[] = [];

	for (const lang of languages) {
		if (lang.status === "ready") {
			results.push(lang);
			continue;
		}

		if (lang.status === "missing-runtime") {
			notify(
				`${lang.config.name}: ${lang.config.runtime.command} not found.\n${lang.config.runtime.installHint}`,
				"warning",
			);
			continue;
		}

		if (lang.status === "manual") {
			const hint = lang.config.server.manualInstallHint ?? `Install ${lang.config.server.name} manually.`;
			notify(`${lang.config.name}: ${lang.config.server.name} not installed.\n${hint}`, "warning");
			continue;
		}

		if (lang.status === "installable") {
			const ok = await confirm(
				`${lang.config.name} project detected`,
				`Install ${lang.config.server.name} LSP server?\n\n  ${lang.config.server.installCommand}`,
			);
			if (!ok) continue;

			notify(`Installing ${lang.config.server.name}...`, "info");
			try {
				const result = await exec(lang.config.server.installCommand);
				if (result.code === 0) {
					results.push({ ...lang, status: "ready" });
					notify(`${lang.config.server.name} installed.`, "info");
				} else {
					const errorMsg = result.stderr || result.stdout || "Unknown error";
					notify(`${lang.config.server.name} install failed:\n${errorMsg}`, "error");
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				notify(`${lang.config.server.name} install error: ${msg}`, "error");
			}
		}
	}

	return results.filter((d) => d.status === "ready");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a language is present in the project by scanning for
 * source file extensions and optional marker files.
 */
async function detectLanguage(config: LanguageConfig, cwd: string): Promise<boolean> {
	let hasSourceFile = false;

	for (const ext of config.detect.extensions) {
		try {
			const result = await execCommand(
				"find",
				[".", "-maxdepth", "3", ...FIND_PRUNE_ARGS, "-name", `*${ext}`, "-type", "f", "-print", "-quit"],
				cwd,
				{ timeout: 5000 },
			);
			if (result.stdout.trim()) {
				hasSourceFile = true;
				break;
			}
		} catch {
			// Ignore find errors; treat as not found.
		}
	}

	if (!hasSourceFile) return false;

	// If marker files are configured, require at least one to confirm the project
	// (prevents false positives, e.g., a stray .java file in a non-Java project).
	if (config.detect.markerFiles && config.detect.markerFiles.length > 0) {
		for (const pattern of config.detect.markerFiles) {
			try {
				const result = await execCommand(
					"find",
					[".", "-maxdepth", "3", ...FIND_PRUNE_ARGS, "-name", pattern, "-type", "f", "-print", "-quit"],
					cwd,
					{ timeout: 5000 },
				);
				if (result.stdout.trim()) return true;
			} catch {
				// Ignore find errors.
			}
		}
		// Marker files configured but none found — still return true for
		// simple script projects that lack explicit config files.
	}

	return hasSourceFile;
}

/** Returns true if the given command is available in PATH. */
async function isCommandAvailable(command: string): Promise<boolean> {
	try {
		const result = await execCommand("which", [command], process.cwd(), { timeout: 5000 });
		return result.code === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	}
}
