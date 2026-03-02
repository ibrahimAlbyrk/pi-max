/**
 * File Sync — TASKS.md auto-sync logic
 *
 * Maintains a TASKS.md file in the project root that stays in sync
 * with the session task state. This file is human-readable,
 * version-controllable, and persists across sessions.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { TaskStore } from "../types.js";
import type { SyncConfig } from "./sync-config.js";
import { generateSummaryExport } from "../export/summary-export.js";
import { generateFullExport } from "../export/full-export.js";

/**
 * Write the current task state to the sync file.
 */
export function syncPush(store: TaskStore, config: SyncConfig, cwd: string): void {
	if (!config.enabled) return;

	const content = config.format === "full"
		? generateFullExport(store)
		: generateSummaryExport(store);

	const fullPath = resolve(cwd, config.path);
	try {
		writeFileSync(fullPath, content, "utf-8");
	} catch (err) {
		console.error(`[task-management] Failed to sync push to ${config.path}: ${err}`);
	}
}

/**
 * Read the sync file content (for pull/import).
 * Returns null if file doesn't exist.
 */
export function syncPullContent(config: SyncConfig, cwd: string): string | null {
	const fullPath = resolve(cwd, config.path);
	try {
		if (!existsSync(fullPath)) return null;
		return readFileSync(fullPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Check if the sync file exists.
 */
export function syncFileExists(config: SyncConfig, cwd: string): boolean {
	return existsSync(resolve(cwd, config.path));
}
