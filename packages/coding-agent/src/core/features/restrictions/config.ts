/**
 * Configuration loading and merging for the restrictions feature.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/restrictions.json (global)
 * - <cwd>/.pi/restrictions.json (project-local)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RestrictionConfig } from "./types.js";

// ============================================================================
// Default Config
// ============================================================================

export const DEFAULT_CONFIG: RestrictionConfig = {
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

function loadConfigFile(path: string): Partial<RestrictionConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<RestrictionConfig>;
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

/**
 * Load restrictions configuration from global and project-local config files.
 * Project-local config takes precedence over global config.
 * Both are merged on top of DEFAULT_CONFIG.
 */
export function loadRestrictionsConfig(cwd: string): RestrictionConfig {
	const globalConfig = loadConfigFile(join(homedir(), ".pi", "agent", "restrictions.json"));
	const projectConfig = loadConfigFile(join(cwd, ".pi", "restrictions.json"));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}
