/**
 * State Management — Hybrid persistence
 *
 * Primary source:   .pi/tasks/ (project-scoped per-file storage, survives /new)
 * Secondary source: session tool-result details (LLM context + branch-awareness)
 * Tertiary source:  custom entries (post-compaction snapshots, UI mutations)
 *
 * Branch-awareness works by scanning tool results and custom entries in the
 * session branch. The latest snapshot on the current branch wins, falling back
 * to file storage if no session data exists.
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ReadonlySessionManager } from "../../session-manager.js";
import { PerFileTaskStorage } from "./storage.js";
import { createDefaultStore } from "./store.js";
import type { TaskStorage, TaskStore, TaskToolDetails } from "./types.js";

// ─── File-Based Load ─────────────────────────────────────────────

/**
 * Create a PerFileTaskStorage for the given working directory and load
 * the task store from disk.
 *
 * Handles all error cases gracefully:
 * - Missing .pi/tasks/  → returns a fresh default store
 * - Corrupt index.json  → rebuilds index from individual files
 * - Corrupt entity file → skips that file with an error log, loads the rest
 * - Corrupt tasks.json  → skips migration, returns fresh store
 */
export function loadState(cwd: string): TaskStore {
	const storage = new PerFileTaskStorage(cwd);
	return storage.load();
}

// ─── Session Reconstruction ──────────────────────────────────────

/**
 * Reconstruct state from session entries (branch-aware).
 *
 * Scans all entries on the current session branch in order. Each task tool
 * result and compaction snapshot overwrites the previous, so the last entry
 * on the branch wins. Falls back to file storage if no session data is found.
 *
 * Called on session_switch / session_fork / session_tree events so that
 * navigating the session tree always restores the correct task state for
 * that branch.
 */
export function reconstructFromSession(sessionManager: ReadonlySessionManager, storage: TaskStorage): TaskStore {
	let store: TaskStore | null = null;

	for (const entry of sessionManager.getBranch()) {
		// Source 1: Tool result details from the "task" tool
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult") {
				const toolMsg = msg as ToolResultMessage<TaskToolDetails>;
				if (toolMsg.toolName === "task" && toolMsg.details?.store) {
					store = toolMsg.details.store;
				}
			}
		}

		// Source 2: Custom entries (post-compaction snapshots persisted via appendCustomEntry)
		if (entry.type === "custom" && entry.customType === "task-store-snapshot") {
			const snapshot = entry.data as { store?: TaskStore } | undefined;
			if (snapshot?.store) {
				store = snapshot.store;
			}
		}
	}

	// Prefer session-reconstructed state; fall back to file storage.
	// File storage is the canonical source of truth — session entries only
	// carry lightweight snapshots for branch navigation.
	return store ?? storage.load();
}

// ─── Persistence ─────────────────────────────────────────────────

/**
 * Persist full store to file storage.
 * Writes all task, group, and sprint files plus the index.
 */
export function persistToStorage(store: TaskStore, storage: TaskStorage): void {
	storage.save(store);
}

// ─── Convenience Factory ─────────────────────────────────────────

/**
 * Create a PerFileTaskStorage instance for the given working directory.
 * Exported so callers can hold a typed storage reference and perform
 * granular saves (saveTask, saveGroup, etc.) without re-constructing.
 */
export function createStorage(cwd: string): PerFileTaskStorage {
	return new PerFileTaskStorage(cwd);
}

// ─── Default Store ───────────────────────────────────────────────

/**
 * Re-export createDefaultStore so callers can initialise an empty store
 * without importing from store.ts directly.
 */
export { createDefaultStore };
