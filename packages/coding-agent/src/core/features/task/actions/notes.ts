/**
 * Notes Action — add_note
 *
 * Migrated from .pi/extensions/task-management/actions/notes.ts
 */

import { findTask } from "../store.js";
import type { TaskActionParams, TaskStore, TaskToolResult } from "../types.js";
import { toolError as error, toolResult as result } from "../utils/response.js";

// ─── Add Note ────────────────────────────────────────────────────

export function handleAddNote(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "add_note", "Task ID is required");
	}
	if (!params.text?.trim()) {
		return error(store, "add_note", "Note text is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "add_note", `Task #${params.id} not found`);
	}

	// Use assignee param as author when provided, otherwise default to "agent"
	const author: "user" | "agent" = params.assignee === "user" ? "user" : "agent";

	task.notes.push({
		timestamp: new Date().toISOString(),
		author,
		text: params.text.trim(),
	});

	return result(store, "add_note", `Added note to #${task.id} (by ${author}): ${params.text.trim()}`);
}
