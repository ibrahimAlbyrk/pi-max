/**
 * Restrictions Extension - Configurable sandbox for agent tool access
 *
 * Restricts filesystem access, bash commands, and tool usage via config files.
 * Uses the tool_call event to intercept and block tool executions before they run.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/restrictions.json (global)
 * - <cwd>/.pi/restrictions.json (project-local)
 *
 * Example .pi/restrictions.json:
 * ```json
 * {
 *   "enabled": true,
 *   "filesystem": {
 *     "allowedPaths": ["."],
 *     "deniedPaths": ["~/.ssh", "~/.aws"],
 *     "deniedPatterns": ["**\/.env", "**\/*.pem"]
 *   },
 *   "bash": {
 *     "deniedPatterns": ["sudo\\s+", "rm\\s+(-rf|--recursive)\\s+/"],
 *     "requireConfirmation": ["git push --force", "npm publish"]
 *   },
 *   "tools": {
 *     "disabled": [],
 *     "readOnlyMode": false
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./restrictions.ts` - restrictions enabled with default/config settings
 * - `pi -e ./restrictions.ts --no-restrictions` - disable restrictions
 * - `/restrictions` - show current restriction configuration
 *
 * Setup:
 * - Copy to ~/.pi/agent/extensions/ for global auto-discovery
 * - Or place in .pi/extensions/ for project-local
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface FilesystemConfig {
	/** Allowed base paths (relative to cwd). Files outside these are blocked. Default: ["."] */
	allowedPaths?: string[];
	/** Explicitly denied paths (absolute or relative). Checked before allowedPaths. */
	deniedPaths?: string[];
	/** Glob-like patterns for denied files (e.g., "**\/.env", "**\/*.pem"). */
	deniedPatterns?: string[];
	/** If true, block all write/edit operations. Default: false */
	readOnly?: boolean;
}

interface BashConfig {
	/** Regex patterns for denied commands. If any matches, the command is blocked. */
	deniedPatterns?: string[];
	/** Literal substrings - if command contains any, it's blocked. */
	deniedCommands?: string[];
	/** Literal substrings - if command contains any, user confirmation is required. */
	requireConfirmation?: string[];
	/** Max timeout in seconds for bash commands. 0 = no limit. */
	timeout?: number;
}

interface ToolsConfig {
	/** Tool names to disable entirely (e.g., ["bash", "write"]). */
	disabled?: string[];
	/** If true, disable write, edit, and bash tools. Default: false */
	readOnlyMode?: boolean;
}

interface UIConfig {
	/** Show notifications when a tool call is blocked. Default: true */
	showNotifications?: boolean;
}

interface RestrictionConfig {
	enabled?: boolean;
	filesystem?: FilesystemConfig;
	bash?: BashConfig;
	tools?: ToolsConfig;
	ui?: UIConfig;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: RestrictionConfig = {
	enabled: false,
	filesystem: {
		allowedPaths: [],
		deniedPaths: [],
		deniedPatterns: [],
		readOnly: false,
	},
	bash: {
		deniedPatterns: [],
		deniedCommands: [],
		requireConfirmation: [],
		timeout: 0,
	},
	tools: {
		disabled: [],
		readOnlyMode: false,
	},
	ui: {
		showNotifications: true,
	},
};

// ============================================================================
// Config Loading
// ============================================================================

function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(homedir(), p.slice(1));
	}
	return p;
}

function loadConfigFile(path: string): Partial<RestrictionConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`Warning: Could not parse ${path}: ${e}`);
		return {};
	}
}

function mergeConfig(base: RestrictionConfig, override: Partial<RestrictionConfig>): RestrictionConfig {
	const result: RestrictionConfig = { ...base };

	if (override.enabled !== undefined) result.enabled = override.enabled;

	if (override.filesystem) {
		result.filesystem = {
			...base.filesystem,
			...override.filesystem,
		};
	}

	if (override.bash) {
		result.bash = {
			...base.bash,
			...override.bash,
		};
	}

	if (override.tools) {
		result.tools = {
			...base.tools,
			...override.tools,
		};
	}

	if (override.ui) {
		result.ui = {
			...base.ui,
			...override.ui,
		};
	}

	return result;
}

function loadConfig(cwd: string): RestrictionConfig {
	const globalConfig = loadConfigFile(join(homedir(), ".pi", "agent", "restrictions.json"));
	const projectConfig = loadConfigFile(join(cwd, ".pi", "restrictions.json"));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

// ============================================================================
// Path Resolution & Matching
// ============================================================================

function resolvePath(cwd: string, toolPath: string): string {
	// Strip leading @ (some models add it)
	const cleaned = toolPath.startsWith("@") ? toolPath.slice(1) : toolPath;
	const expanded = expandHome(cleaned);
	if (isAbsolute(expanded)) {
		return normalize(expanded);
	}
	return normalize(resolve(cwd, expanded));
}

function isPathUnder(filePath: string, basePath: string): boolean {
	const rel = relative(basePath, filePath);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

function isDeniedPath(resolvedPath: string, cwd: string, config: FilesystemConfig): boolean {
	const deniedPaths = config.deniedPaths ?? [];
	for (const denied of deniedPaths) {
		const expandedDenied = normalize(resolve(cwd, expandHome(denied)));
		if (resolvedPath === expandedDenied || isPathUnder(resolvedPath, expandedDenied)) {
			return true;
		}
	}
	return false;
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
	// Convert simple glob pattern to regex
	// Supports: ** (any path), * (any filename chars), ? (single char)
	let regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars (except * and ?)
		.replace(/\*\*/g, "{{GLOBSTAR}}") // placeholder for **
		.replace(/\*/g, "[^/]*") // * = any non-separator
		.replace(/\?/g, "[^/]") // ? = single non-separator
		.replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** = anything

	// If pattern doesn't start with /, match anywhere in path
	if (!pattern.startsWith("/")) {
		regexStr = `(^|/)${regexStr}`;
	}

	regexStr = `${regexStr}$`;

	try {
		return new RegExp(regexStr).test(filePath);
	} catch {
		return false;
	}
}

function isDeniedByPattern(resolvedPath: string, config: FilesystemConfig): boolean {
	const patterns = config.deniedPatterns ?? [];
	for (const pattern of patterns) {
		if (matchesGlobPattern(resolvedPath, pattern)) {
			return true;
		}
	}
	return false;
}

function isAllowedPath(resolvedPath: string, cwd: string, config: FilesystemConfig): boolean {
	const allowedPaths = config.allowedPaths ?? ["."];
	for (const allowed of allowedPaths) {
		const expandedAllowed = normalize(resolve(cwd, expandHome(allowed)));
		if (resolvedPath === expandedAllowed || isPathUnder(resolvedPath, expandedAllowed)) {
			return true;
		}
	}
	return false;
}

function checkPath(resolvedPath: string, cwd: string, config: FilesystemConfig): { blocked: boolean; reason?: string } {
	// 1. Denied paths (highest priority)
	if (isDeniedPath(resolvedPath, cwd, config)) {
		return { blocked: true, reason: `Access denied: path is explicitly restricted` };
	}

	// 2. Denied patterns
	if (isDeniedByPattern(resolvedPath, config)) {
		return { blocked: true, reason: `Access denied: path matches a restricted pattern` };
	}

	// 3. Allowed paths
	if (!isAllowedPath(resolvedPath, cwd, config)) {
		return { blocked: true, reason: `Access denied: path is outside allowed directories` };
	}

	return { blocked: false };
}

// ============================================================================
// Bash Command Matching
// ============================================================================

function matchesDeniedBashPattern(command: string, config: BashConfig): string | undefined {
	// Check denied patterns (regex)
	for (const pattern of config.deniedPatterns ?? []) {
		try {
			if (new RegExp(pattern, "i").test(command)) {
				return pattern;
			}
		} catch {
			// Skip invalid regex
		}
	}

	// Check denied commands (literal substring)
	for (const denied of config.deniedCommands ?? []) {
		if (command.includes(denied)) {
			return denied;
		}
	}

	return undefined;
}

function needsConfirmation(command: string, config: BashConfig): string | undefined {
	for (const pattern of config.requireConfirmation ?? []) {
		if (command.includes(pattern)) {
			return pattern;
		}
	}
	return undefined;
}

// ============================================================================
// Tool Path Extraction
// ============================================================================

const TOOLS_WITH_PATH = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function getToolPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if (!TOOLS_WITH_PATH.has(toolName)) return undefined;
	const path = input.path as string | undefined;
	return path ?? undefined;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	let config: RestrictionConfig = DEFAULT_CONFIG;
	let cwd = process.cwd();

	pi.registerFlag("no-restrictions", {
		description: "Disable all restrictions",
		type: "boolean",
		default: false,
	});

	// Load config on session start
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;

		const noRestrictions = pi.getFlag("no-restrictions") as boolean;
		if (noRestrictions) {
			config = { ...DEFAULT_CONFIG, enabled: false };
			ctx.ui.notify("Restrictions disabled via --no-restrictions", "warning");
			return;
		}

		config = loadConfig(cwd);

		if (!config.enabled) {
			ctx.ui.notify("Restrictions disabled via config", "info");
			return;
		}

		const deniedPathCount = config.filesystem?.deniedPaths?.length ?? 0;
		const deniedPatternCount =
			(config.bash?.deniedPatterns?.length ?? 0) + (config.bash?.deniedCommands?.length ?? 0);
		const disabledToolCount = config.tools?.disabled?.length ?? 0;

		const parts: string[] = [];
		if (config.filesystem?.readOnly || config.tools?.readOnlyMode) parts.push("read-only");
		if (deniedPathCount > 0) parts.push(`${deniedPathCount} denied paths`);
		if (deniedPatternCount > 0) parts.push(`${deniedPatternCount} bash rules`);
		if (disabledToolCount > 0) parts.push(`${disabledToolCount} disabled tools`);

		const summary = parts.length > 0 ? parts.join(", ") : "default rules";
		ctx.ui.setStatus("restrictions", ctx.ui.theme.fg("accent", `Restrictions: ${summary}`));
		ctx.ui.notify(`Restrictions active: ${summary}`, "info");
	});

	// Main restriction handler
	pi.on("tool_call", async (event, ctx) => {
		if (!config?.enabled) return;

		const toolName = event.toolName;
		const input = event.input as Record<string, unknown>;

		// Layer 1: Tool-level disable
		if (config.tools?.disabled?.includes(toolName)) {
			notify(ctx, `Blocked: tool "${toolName}" is disabled`);
			return { block: true, reason: `Tool "${toolName}" is disabled by restrictions` };
		}

		// Layer 2: Read-only mode
		if (config.tools?.readOnlyMode || config.filesystem?.readOnly) {
			if (toolName === "write" || toolName === "edit") {
				notify(ctx, `Blocked: ${toolName} (read-only mode)`);
				return { block: true, reason: "Read-only mode is active - write/edit operations are blocked" };
			}
			if (toolName === "bash") {
				notify(ctx, "Blocked: bash (read-only mode)");
				return { block: true, reason: "Read-only mode is active - bash commands are blocked" };
			}
		}

		// Layer 3: Filesystem path restrictions
		const toolPath = getToolPath(toolName, input);
		if (toolPath && config.filesystem) {
			const resolvedPath = resolvePath(cwd, toolPath);
			const check = checkPath(resolvedPath, cwd, config.filesystem);
			if (check.blocked) {
				notify(ctx, `Blocked: ${toolName} "${toolPath}" - ${check.reason}`);
				return { block: true, reason: `${check.reason} (${toolPath})` };
			}
		}

		// Layer 4: Bash command restrictions
		if (isToolCallEventType("bash", event) && config.bash) {
			const command = event.input.command;

			// 4a. Denied patterns/commands
			const deniedMatch = matchesDeniedBashPattern(command, config.bash);
			if (deniedMatch) {
				notify(ctx, `Blocked bash command matching rule: ${deniedMatch}`);
				return {
					block: true,
					reason: `Command blocked by restriction rule: ${deniedMatch}`,
				};
			}

			// 4b. Confirmation required
			const confirmMatch = needsConfirmation(command, config.bash);
			if (confirmMatch) {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `Command requires confirmation but no UI available: ${confirmMatch}`,
					};
				}

				const ok = await ctx.ui.confirm(
					"Confirmation Required",
					`This command matches a restricted pattern:\n\n  ${command}\n\nMatched rule: "${confirmMatch}"\n\nAllow execution?`,
				);
				if (!ok) {
					return { block: true, reason: "Blocked by user confirmation" };
				}
			}
		}

		return undefined;
	});

	// /restrictions command
	pi.registerCommand("restrictions", {
		description: "Show current restriction configuration",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify("Restrictions are disabled", "info");
				return;
			}

			const lines: string[] = ["Restriction Configuration:", ""];

			// Filesystem
			lines.push("Filesystem:");
			const fs = config.filesystem;
			if (fs?.readOnly || config.tools?.readOnlyMode) {
				lines.push("  Mode: READ-ONLY");
			}
			lines.push(`  Allowed paths: ${fs?.allowedPaths?.join(", ") || "(all)"}`);
			lines.push(`  Denied paths: ${fs?.deniedPaths?.map((p) => expandHome(p)).join(", ") || "(none)"}`);
			lines.push(`  Denied patterns: ${fs?.deniedPatterns?.join(", ") || "(none)"}`);

			// Bash
			lines.push("");
			lines.push("Bash:");
			const bash = config.bash;
			lines.push(`  Denied patterns: ${bash?.deniedPatterns?.length ?? 0} rules`);
			if (bash?.deniedPatterns?.length) {
				for (const p of bash.deniedPatterns) {
					lines.push(`    - /${p}/i`);
				}
			}
			lines.push(`  Denied commands: ${bash?.deniedCommands?.length ?? 0} rules`);
			if (bash?.deniedCommands?.length) {
				for (const c of bash.deniedCommands) {
					lines.push(`    - "${c}"`);
				}
			}
			lines.push(`  Require confirmation: ${bash?.requireConfirmation?.length ?? 0} rules`);
			if (bash?.requireConfirmation?.length) {
				for (const c of bash.requireConfirmation) {
					lines.push(`    - "${c}"`);
				}
			}

			// Tools
			lines.push("");
			lines.push("Tools:");
			lines.push(`  Disabled: ${config.tools?.disabled?.length ? config.tools.disabled.join(", ") : "(none)"}`);
			lines.push(`  Read-only mode: ${config.tools?.readOnlyMode ? "ON" : "OFF"}`);

			// Config sources
			lines.push("");
			lines.push("Config sources:");
			const globalPath = join(homedir(), ".pi", "agent", "restrictions.json");
			const projectPath = join(cwd, ".pi", "restrictions.json");
			lines.push(`  Global: ${existsSync(globalPath) ? globalPath : "(not found)"}`);
			lines.push(`  Project: ${existsSync(projectPath) ? projectPath : "(not found)"}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	function notify(
		ctx: { ui: { notify: (msg: string, type: "info" | "warning" | "error") => void }; hasUI: boolean },
		message: string,
	): void {
		if (config.ui?.showNotifications !== false && ctx.hasUI) {
			ctx.ui.notify(message, "warning");
		}
	}
}
