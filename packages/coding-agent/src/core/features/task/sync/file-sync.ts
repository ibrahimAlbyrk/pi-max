/**
 * File Sync — TASKS.md auto-sync logic
 *
 * Maintains a TASKS.md file in the project root that stays in sync
 * with the session task state. This file is human-readable,
 * version-controllable, and persists across sessions.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { generateFullExport } from "../export/full-export.js";
import { generateSummaryExport } from "../export/summary-export.js";
import type { SyncConfig, TaskStore } from "../types.js";

/**
 * Write the current task state to the sync file.
 * Does nothing if config.enabled is false.
 */
export function syncPush(store: TaskStore, config: SyncConfig, cwd: string): void {
	if (!config.enabled) return;

	const content = config.format === "full" ? generateFullExport(store) : generateSummaryExport(store);

	const fullPath = resolve(cwd, config.path);
	try {
		writeFileSync(fullPath, content, "utf-8");
	} catch (err) {
		console.error(`[task-sync] Failed to sync push to ${config.path}: ${String(err)}`);
	}
}

/**
 * Read the sync file content (for pull/import).
 * Returns null if the file doesn't exist or cannot be read.
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
 * Check whether the sync file exists on disk.
 */
export function syncFileExists(config: SyncConfig, cwd: string): boolean {
	return existsSync(resolve(cwd, config.path));
}
