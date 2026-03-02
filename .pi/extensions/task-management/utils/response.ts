/**
 * Shared response helpers for tool action handlers.
 *
 * Every action handler returns a TaskToolResult with a text summary
 * and a store snapshot in details. We use a lightweight snapshot to
 * reduce context window usage — canonical state lives in file storage.
 */

import type { TaskStore, TaskToolResult } from "../types.js";
import { createLightSnapshot, createBulkSnapshot } from "../store.js";

/**
 * Build a successful tool result with a text summary + lightweight store snapshot.
 */
export function toolResult(store: TaskStore, action: string, text: string): TaskToolResult {
	return {
		content: [{ type: "text", text }],
		details: { store: createLightSnapshot(store), action },
	};
}

/**
 * Build a bulk operation result with a minimal snapshot (only affected tasks + counts).
 * This dramatically reduces context window usage for large bulk operations.
 */
export function bulkResult(store: TaskStore, action: string, text: string, affectedIds: number[]): TaskToolResult {
	return {
		content: [{ type: "text", text }],
		details: { store: createBulkSnapshot(store, affectedIds), action },
	};
}

/**
 * Build an error tool result with an error message + lightweight store snapshot.
 */
export function toolError(store: TaskStore, action: string, message: string): TaskToolResult {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { store: createLightSnapshot(store), action },
	};
}
