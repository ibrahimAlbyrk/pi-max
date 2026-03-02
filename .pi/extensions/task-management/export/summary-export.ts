/**
 * Summary Export — Quick project overview as Markdown
 *
 * Includes: status table, active sprint progress bar, grouped task lists, backlog.
 * Pure function: TaskStore → string
 */

import type { TaskStore, Task, TaskStatus } from "../types.js";
import { formatElapsed } from "../store.js";
import { STATUS_ICONS } from "../rendering/icons.js";

export function generateSummaryExport(store: TaskStore): string {
	const lines: string[] = [];
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");

	// Header
	const activeSprint = store.sprints.find((s) => s.status === "active");
	const sprintLabel = activeSprint
		? ` | Sprint: ${activeSprint.name} (${sprintProgress(store, activeSprint.id)}% complete)`
		: "";
	lines.push(`# Project Tasks\n`);
	lines.push(`> Generated: ${now}${sprintLabel}\n`);

	// Status table
	const counts = countByStatus(store.tasks);
	lines.push("## Progress\n");
	lines.push("| Status | Count |");
	lines.push("|--------|-------|");
	for (const [status, icon] of Object.entries(STATUS_ICONS) as [TaskStatus, string][]) {
		const count = counts[status] ?? 0;
		if (count > 0) {
			const label = status === "done" ? "Done" : status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			lines.push(`| ${icon} ${label} | ${count} |`);
		}
	}
	lines.push(`| **Total** | **${store.tasks.length}** |`);
	lines.push("");

	// Active sprint section
	if (activeSprint) {
		const sprintTasks = store.tasks.filter((t) => t.sprintId === activeSprint.id);
		const done = sprintTasks.filter((t) => t.status === "done").length;
		const pct = sprintTasks.length > 0 ? Math.round((done / sprintTasks.length) * 100) : 0;
		const barFill = Math.round(pct / 5);
		const bar = "█".repeat(barFill) + "░".repeat(20 - barFill);

		lines.push(`## Active Sprint: ${activeSprint.name}\n`);
		lines.push(`Progress: ${bar} ${done}/${sprintTasks.length}\n`);

		// Group sprint tasks by status
		for (const status of ["in_progress", "todo", "blocked", "in_review"] as TaskStatus[]) {
			const group = sprintTasks.filter((t) => t.status === status);
			if (group.length === 0) continue;
			const label = status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			lines.push(`### ${label}`);
			for (const t of group) {
				lines.push(formatTaskLine(t, store));
			}
			lines.push("");
		}
	}

	// Backlog (tasks not in any sprint, not done)
	const backlog = store.tasks.filter((t) => !t.sprintId && t.status !== "done");
	if (backlog.length > 0) {
		lines.push("## Backlog\n");
		for (const t of backlog) {
			lines.push(formatTaskLine(t, store));
		}
		lines.push("");
	}

	return lines.join("\n");
}

function formatTaskLine(task: Task, store: TaskStore): string {
	const checkbox = task.status === "done" ? "[x]" : "[ ]";
	const priority = `[${task.priority}]`;
	const assignee = task.assignee ? ` — @${task.assignee}` : "";

	let extra = "";
	if (task.status === "in_progress" && task.startedAt) {
		const elapsed = Date.now() - new Date(task.startedAt).getTime();
		extra = ` (${formatElapsed(elapsed)} elapsed)`;
	}
	if (task.status === "blocked") {
		const blockers = task.dependsOn
			.map((id) => store.tasks.find((t) => t.id === id))
			.filter((t) => t && t.status !== "done")
			.map((t) => `#${t!.id}`);
		if (blockers.length > 0) extra = ` — blocked by ${blockers.join(", ")}`;
	}

	return `- ${checkbox} #${task.id} ${priority} ${task.title}${assignee}${extra}`;
}

function countByStatus(tasks: Task[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const t of tasks) {
		counts[t.status] = (counts[t.status] ?? 0) + 1;
	}
	return counts;
}

function sprintProgress(store: TaskStore, sprintId: number): number {
	const tasks = store.tasks.filter((t) => t.sprintId === sprintId);
	if (tasks.length === 0) return 0;
	const done = tasks.filter((t) => t.status === "done").length;
	return Math.round((done / tasks.length) * 100);
}
