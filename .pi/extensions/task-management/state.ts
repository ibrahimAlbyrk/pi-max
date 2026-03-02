/**
 * State Management — Hybrid persistence
 *
 * Primary source: .pi/tasks/ (project-scoped per-file storage, survives /new)
 * Secondary source: session tool-result details (LLM context + branch-awareness)
 * Tertiary source: custom entries (post-compaction snapshots, UI mutations)
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskStore, TaskToolDetails } from "./types.js";
import type { TaskStorage } from "./storage.js";

/**
 * Load state from file storage (project-scoped).
 */
export function loadFromStorage(storage: TaskStorage): TaskStore {
	return storage.load();
}

/**
 * Reconstruct state from session entries (branch-aware).
 * Scans tool results AND custom entries for the latest snapshot.
 *
 * Branch-awareness works through full store snapshots in tool result details.
 * When the user navigates the session tree, the latest snapshot on that branch
 * is used, falling back to file storage if no session data exists.
 */
export function reconstructFromSession(ctx: ExtensionContext, storage: TaskStorage): TaskStore {
	let store: TaskStore | null = null;

	for (const entry of ctx.sessionManager.getBranch()) {
		// Source 1: Tool result details from the "task" tool
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "task") {
				const details = msg.details as TaskToolDetails | undefined;
				if (details?.store) {
					store = details.store;
				}
			}
		}

		// Source 2: Custom entries (post-compaction snapshots, UI mutations)
		if (entry.type === "custom" && (entry as any).customType === "task-store-snapshot") {
			const data = (entry as any).data;
			if (data?.store) {
				store = data.store;
			}
		}
	}

	return store ?? storage.load();
}

/**
 * Persist full store to file storage.
 * Writes all tasks, sprints, and index.
 */
export function persistToStorage(store: TaskStore, storage: TaskStorage): void {
	storage.save(store);
}
