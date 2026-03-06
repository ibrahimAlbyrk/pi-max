/**
 * Sync Configuration — Re-export of SyncConfig type and defaults from types.ts
 *
 * The SyncConfig interface and DEFAULT_SYNC_CONFIG constant live in types.ts
 * as part of the canonical type definitions. This module re-exports them for
 * use by sync-specific consumers (file-sync, commands, feature setup) and
 * provides the mergeSyncConfig helper.
 */

import type { SyncConfig } from "../types.js";
import { DEFAULT_SYNC_CONFIG } from "../types.js";

export type { SyncConfig } from "../types.js";
export { DEFAULT_SYNC_CONFIG } from "../types.js";

/**
 * Merge a partial sync config with the defaults.
 * Returns a complete SyncConfig with all fields set.
 */
export function mergeSyncConfig(partial: Partial<SyncConfig>): SyncConfig {
	return { ...DEFAULT_SYNC_CONFIG, ...partial };
}
