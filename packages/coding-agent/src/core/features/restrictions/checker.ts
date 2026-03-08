/**
 * Restriction checker - evaluates tool calls against restriction configuration.
 *
 * Four layers of checks:
 * 1. Tool disable - blocks entire tools by name
 * 2. Read-only mode - prevents write/edit/bash operations
 * 3. Filesystem path restrictions - whitelist/blacklist/glob patterns
 * 4. Bash command restrictions - regex/substring/confirmation
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
	BashConfig,
	FilesystemConfig,
	RestrictionChecker,
	RestrictionCheckResult,
	RestrictionConfig,
	RestrictionUIContext,
} from "./types.js";

// ============================================================================
// Path Utilities
// ============================================================================

function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(homedir(), p.slice(1));
	}
	return p;
}

function resolvePath(cwd: string, toolPath: string): string {
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

// ============================================================================
// Filesystem Checks
// ============================================================================

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
	let regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\{\{GLOBSTAR\}\}/g, ".*");

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
	if (isDeniedPath(resolvedPath, cwd, config)) {
		return { blocked: true, reason: "Access denied: path is explicitly restricted" };
	}

	if (isDeniedByPattern(resolvedPath, config)) {
		return { blocked: true, reason: "Access denied: path matches a restricted pattern" };
	}

	if (!isAllowedPath(resolvedPath, cwd, config)) {
		return { blocked: true, reason: "Access denied: path is outside allowed directories" };
	}

	return { blocked: false };
}

// ============================================================================
// Bash Command Checks
// ============================================================================

function matchesDeniedBashPattern(command: string, config: BashConfig): string | undefined {
	for (const pattern of config.deniedPatterns ?? []) {
		try {
			if (new RegExp(pattern, "i").test(command)) {
				return pattern;
			}
		} catch {
			// Skip invalid regex
		}
	}

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
// Checker Factory
// ============================================================================

/**
 * Create a restriction checker from a loaded configuration.
 *
 * @param config - The restriction configuration
 * @param cwd - Current working directory for path resolution
 * @param ui - UI context for confirmations and notifications (optional)
 */
export function createRestrictionChecker(
	config: RestrictionConfig,
	cwd: string,
	ui?: RestrictionUIContext,
): RestrictionChecker {
	const notify = (message: string): void => {
		if (config.ui?.showNotifications !== false && ui?.hasUI) {
			ui.notify(message, "warning");
		}
	};

	return {
		async check(toolName: string, input: Record<string, unknown>): Promise<RestrictionCheckResult | undefined> {
			if (!config.enabled) return undefined;

			// Layer 1: Tool-level disable
			if (config.tools?.disabled?.includes(toolName)) {
				notify(`Blocked: tool "${toolName}" is disabled`);
				return { block: true, reason: `Tool "${toolName}" is disabled by restrictions` };
			}

			// Layer 2: Read-only mode
			if (config.tools?.readOnlyMode || config.filesystem?.readOnly) {
				if (toolName === "write" || toolName === "edit") {
					notify(`Blocked: ${toolName} (read-only mode)`);
					return { block: true, reason: "Read-only mode is active - write/edit operations are blocked" };
				}
				if (toolName === "bash") {
					notify("Blocked: bash (read-only mode)");
					return { block: true, reason: "Read-only mode is active - bash commands are blocked" };
				}
			}

			// Layer 3: Filesystem path restrictions
			const toolPath = getToolPath(toolName, input);
			if (toolPath && config.filesystem) {
				const resolvedPath = resolvePath(cwd, toolPath);
				const pathCheck = checkPath(resolvedPath, cwd, config.filesystem);
				if (pathCheck.blocked) {
					notify(`Blocked: ${toolName} "${toolPath}" - ${pathCheck.reason}`);
					return { block: true, reason: `${pathCheck.reason} (${toolPath})` };
				}
			}

			// Layer 4: Bash command restrictions
			if (toolName === "bash" && config.bash) {
				const command = input.command as string | undefined;
				if (command) {
					// 4a. Denied patterns/commands
					const deniedMatch = matchesDeniedBashPattern(command, config.bash);
					if (deniedMatch) {
						notify(`Blocked bash command matching rule: ${deniedMatch}`);
						return {
							block: true,
							reason: `Command blocked by restriction rule: ${deniedMatch}`,
						};
					}

					// 4b. Confirmation required
					const confirmMatch = needsConfirmation(command, config.bash);
					if (confirmMatch) {
						if (!ui?.hasUI) {
							return {
								block: true,
								reason: `Command requires confirmation but no UI available: ${confirmMatch}`,
							};
						}

						const ok = await ui.confirm(
							"Confirmation Required",
							`This command matches a restricted pattern:\n\n  ${command}\n\nMatched rule: "${confirmMatch}"\n\nAllow execution?`,
						);
						if (!ok) {
							return { block: true, reason: "Blocked by user confirmation" };
						}
					}
				}
			}

			return undefined;
		},
	};
}
