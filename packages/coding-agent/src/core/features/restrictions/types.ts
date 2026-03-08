/**
 * Types for the built-in restrictions feature.
 *
 * Defines configuration schema and result types for the sandbox
 * that controls tool access, filesystem paths, and bash commands.
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface FilesystemConfig {
	/** Allowed base paths (relative to cwd). Files outside these are blocked. Default: ["."] */
	allowedPaths?: string[];
	/** Explicitly denied paths (absolute or relative). Checked before allowedPaths. */
	deniedPaths?: string[];
	/** Glob-like patterns for denied files (e.g., "**\/.env", "**\/*.pem"). */
	deniedPatterns?: string[];
	/** If true, block all write/edit operations. Default: false */
	readOnly?: boolean;
}

export interface BashConfig {
	/** Regex patterns for denied commands. If any matches, the command is blocked. */
	deniedPatterns?: string[];
	/** Literal substrings - if command contains any, it's blocked. */
	deniedCommands?: string[];
	/** Literal substrings - if command contains any, user confirmation is required. */
	requireConfirmation?: string[];
	/** Max timeout in seconds for bash commands. 0 = no limit. */
	timeout?: number;
}

export interface ToolsConfig {
	/** Tool names to disable entirely (e.g., ["bash", "write"]). */
	disabled?: string[];
	/** If true, disable write, edit, and bash tools. Default: false */
	readOnlyMode?: boolean;
}

export interface UIConfig {
	/** Show notifications when a tool call is blocked. Default: true */
	showNotifications?: boolean;
}

export interface RestrictionConfig {
	enabled?: boolean;
	filesystem?: FilesystemConfig;
	bash?: BashConfig;
	tools?: ToolsConfig;
	ui?: UIConfig;
}

// ============================================================================
// Result Types
// ============================================================================

/** Result returned by the restriction checker when a tool call is evaluated. */
export interface RestrictionCheckResult {
	/** Whether the tool call should be blocked. */
	block: boolean;
	/** Human-readable reason for blocking. */
	reason: string;
}

// ============================================================================
// Checker Interface
// ============================================================================

/** UI context subset needed by the restriction checker (e.g., for confirmations). */
export interface RestrictionUIContext {
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	hasUI: boolean;
}

/**
 * Restriction checker that evaluates tool calls against the loaded configuration.
 * Returns undefined to allow execution, or a RestrictionCheckResult to block.
 */
export interface RestrictionChecker {
	check(toolName: string, input: Record<string, unknown>): Promise<RestrictionCheckResult | undefined>;
}
