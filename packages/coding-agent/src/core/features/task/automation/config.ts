/**
 * Automation Configuration — defaults and helpers
 *
 * The TaskAutomationConfig type and DEFAULT_AUTOMATION_CONFIG constant live in
 * ../types.ts (shared with the rest of the feature). This file re-exports them
 * and provides the mergeConfig helper used by /automation command and tests.
 */

export type { TaskAutomationConfig } from "../types.js";
export { DEFAULT_AUTOMATION_CONFIG } from "../types.js";

import type { TaskAutomationConfig } from "../types.js";
import { DEFAULT_AUTOMATION_CONFIG } from "../types.js";

/**
 * Merge a partial config override with the defaults.
 * Only provided keys are overridden; all others fall back to DEFAULT_AUTOMATION_CONFIG.
 */
export function mergeConfig(partial: Partial<TaskAutomationConfig>): TaskAutomationConfig {
	return { ...DEFAULT_AUTOMATION_CONFIG, ...partial };
}
