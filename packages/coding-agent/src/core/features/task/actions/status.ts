/**
 * Status Actions — set_status, start, complete, block, unblock, bulk_set_status
 *
 * Migrated from .pi/extensions/task-management/actions/status.ts
 */

import { getUnmetDependencies } from "../dependencies/dep-ops.js";
import { findTask, formatElapsed } from "../store.js";
import type { TaskActionParams, TaskStatus, TaskStore, TaskToolResult } from "../types.js";
import { getMissingIds, resolveBulkTargets } from "../utils/bulk-targets.js";
import { bulkResult, toolError as error, toolResult as result } from "../utils/response.js";

// ─── Transition Validation ───────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	todo: ["in_progress", "deferred", "blocked"],
	in_progress: ["in_review", "done", "blocked", "todo"],
	in_review: ["done", "in_progress", "blocked"],
	blocked: ["todo", "in_progress"],
	deferred: ["todo"],
	done: ["todo"], // reopen
};

function validateTransition(from: TaskStatus, to: TaskStatus): string | null {
	if (from === to) return null;

	const valid = VALID_TRANSITIONS[from];
	if (!valid?.includes(to)) {
		return `Unusual transition: ${from} → ${to}. Typically allowed transitions from "${from}" are: ${valid?.join(", ") ?? "none"}.`;
	}

	if (from === "done" && to === "todo") {
		return "Reopening a completed task.";
	}

	return null;
}

// ─── Dependency Warning Helper ───────────────────────────────────
// getUnmetDependencies imported from ../dependencies/dep-ops.js

// ─── Set Status ──────────────────────────────────────────────────

export function handleSetStatus(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "set_status", "Task ID is required");
	}
	if (!params.status) {
		return error(store, "set_status", "Status is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "set_status", `Task #${params.id} not found`);
	}

	const oldStatus = task.status;

	// Block set_status → done. Force use of `complete` which handles timestamps properly.
	if (params.status === "done") {
		return error(
			store,
			"set_status",
			`Use \`complete\` action instead of set_status to mark task #${task.id} as done. This ensures timestamps and metrics are recorded correctly.`,
		);
	}

	const warning = validateTransition(oldStatus, params.status);

	task.status = params.status;

	// Auto-set startedAt when entering in_progress for the first time
	if (params.status === "in_progress" && !task.startedAt) {
		task.startedAt = new Date().toISOString();
	}

	let text = `#${task.id}: ${oldStatus} → ${task.status}`;
	if (warning) text += `\nWarning: ${warning}`;

	return result(store, "set_status", text);
}

// ─── Start ───────────────────────────────────────────────────────

export function handleStart(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "start", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "start", `Task #${params.id} not found`);
	}

	if (task.status !== "todo" && task.status !== "deferred") {
		return error(
			store,
			"start",
			`Cannot start task #${task.id} — current status is "${task.status}" (expected "todo" or "deferred")`,
		);
	}

	const oldStatus = task.status;
	task.status = "in_progress";
	task.startedAt = new Date().toISOString();
	store.activeTaskId = task.id;

	// Warn about unmet dependencies (informational — does not block start)
	const unmet = getUnmetDependencies(store, task.id);
	let text = `Started #${task.id}: ${task.title} (${oldStatus} → in_progress)`;
	if (unmet.length > 0) {
		text += `\nWarning: Unmet dependencies:\n${unmet.map((u) => `  - ${u}`).join("\n")}`;
	}

	return result(store, "start", text);
}

// ─── Complete ────────────────────────────────────────────────────

export function handleComplete(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "complete", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "complete", `Task #${params.id} not found`);
	}

	if (task.status === "done") {
		return error(store, "complete", `Task #${task.id} is already done`);
	}
	if (task.status === "blocked") {
		return error(store, "complete", `Cannot complete task #${task.id} — it is blocked. Unblock it first.`);
	}

	const oldStatus = task.status;

	// Auto-set startedAt if the task was never explicitly started
	if (!task.startedAt) {
		task.startedAt = new Date().toISOString();
	}

	task.status = "done";
	task.completedAt = new Date().toISOString();

	// Calculate actual time spent from startedAt → completedAt
	task.actualMinutes = Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 60000);

	// Clear active task pointer if this task was the active one
	if (store.activeTaskId === task.id) {
		store.activeTaskId = null;
	}

	let text = `Completed #${task.id}: ${task.title} (${oldStatus} → done)`;
	if (task.actualMinutes !== null) {
		text += `\nTime spent: ${formatElapsed(task.actualMinutes * 60000)}`;
	}

	return result(store, "complete", text);
}

// ─── Block ───────────────────────────────────────────────────────

export function handleBlock(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "block", "Task ID is required");
	}
	if (!params.text?.trim()) {
		return error(store, "block", "Block reason (text) is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "block", `Task #${params.id} not found`);
	}

	if (task.status === "done") {
		return error(store, "block", `Cannot block a completed task (#${task.id})`);
	}

	const oldStatus = task.status;
	task.status = "blocked";

	task.notes.push({
		timestamp: new Date().toISOString(),
		author: "agent",
		text: `Blocked: ${params.text.trim()}`,
	});

	return result(
		store,
		"block",
		`Blocked #${task.id}: ${task.title} (${oldStatus} → blocked)\nReason: ${params.text.trim()}`,
	);
}

// ─── Unblock ─────────────────────────────────────────────────────

export function handleUnblock(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "unblock", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "unblock", `Task #${params.id} not found`);
	}

	if (task.status !== "blocked") {
		return error(store, "unblock", `Task #${task.id} is not blocked (current status: "${task.status}")`);
	}

	// Restore to in_progress if the task was previously started, otherwise revert to todo
	const newStatus: TaskStatus = task.startedAt ? "in_progress" : "todo";
	task.status = newStatus;

	task.notes.push({
		timestamp: new Date().toISOString(),
		author: "agent",
		text: "Unblocked",
	});

	return result(store, "unblock", `Unblocked #${task.id}: ${task.title} (blocked → ${newStatus})`);
}

// ─── Bulk Set Status ─────────────────────────────────────────────

export function handleBulkSetStatus(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (!params.status) {
		return error(store, "bulk_set_status", "status is required");
	}

	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return error(store, "bulk_set_status", `No tasks found (${selectionLabel})`);
	}

	const targetStatus = params.status;
	const now = new Date().toISOString();
	const changed: { id: number; title: string; from: string; to: string }[] = [];
	const skipped: { id: number; reason: string }[] = [];

	for (const task of targets) {
		// Skip tasks already in the target status
		if (task.status === targetStatus) {
			skipped.push({ id: task.id, reason: `already ${targetStatus}` });
			continue;
		}

		// Skip blocked tasks being bulk-completed (must unblock first)
		if (task.status === "blocked" && targetStatus === "done") {
			skipped.push({ id: task.id, reason: "blocked — unblock first" });
			continue;
		}

		const oldStatus = task.status;
		task.status = targetStatus;

		// Auto-timestamps
		if (targetStatus === "in_progress" && !task.startedAt) {
			task.startedAt = now;
		}
		if (targetStatus === "done") {
			if (!task.startedAt) task.startedAt = now;
			task.completedAt = now;
			task.actualMinutes = Math.round(
				(new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 60000,
			);
			if (store.activeTaskId === task.id) store.activeTaskId = null;
		}

		changed.push({ id: task.id, title: task.title, from: oldStatus, to: targetStatus });
	}

	if (changed.length === 0) {
		const reasons = skipped.map((s) => `#${s.id}: ${s.reason}`);
		return error(store, "bulk_set_status", `No tasks changed (${selectionLabel}).\n${reasons.join("\n")}`);
	}

	const notFound = getMissingIds(store, params);
	const lines = [`${changed.length} task(s) → ${targetStatus} (${selectionLabel}):`];
	for (const c of changed) {
		lines.push(`  ✓ #${c.id} ${c.title} (${c.from} → ${c.to})`);
	}
	if (skipped.length > 0) {
		lines.push(`Skipped ${skipped.length}: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(
		store,
		"bulk_set_status",
		lines.join("\n"),
		changed.map((c) => c.id),
	);
}
