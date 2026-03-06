/**
 * Full Export — Complete task dump with groups, notes, dependencies, time
 *
 * Renders tasks grouped by TaskGroup as a Markdown document.
 * Groups are H2 sections, tasks within groups are H3.
 * Ungrouped tasks are listed under a separate section.
 * Includes all metadata for round-trip import fidelity.
 *
 * Pure function: TaskStore → string
 */

import { findGroup, formatElapsed, getGroupTasks } from "../store.js";
import type { Sprint, Task, TaskStore } from "../types.js";

export function generateFullExport(store: TaskStore): string {
	const lines: string[] = [];
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");

	lines.push("# Project Tasks\n");
	lines.push(`> Generated: ${now}\n`);

	// Render groups with their tasks
	for (const group of store.groups) {
		const tasks = getGroupTasks(store, group.id);
		const doneCount = tasks.filter((t) => t.status === "done").length;

		lines.push(`## G${group.id} ${escMd(group.name)} (${doneCount}/${tasks.length} done)\n`);
		if (group.description) {
			lines.push(`${group.description}\n`);
		}

		for (const task of tasks) {
			renderTask(task, store, lines, 3);
		}
		lines.push("---\n");
	}

	// Render ungrouped tasks
	const ungrouped = store.tasks.filter((t) => t.groupId === null);
	if (ungrouped.length > 0) {
		if (store.groups.length > 0) {
			lines.push("## Ungrouped Tasks\n");
		}
		for (const task of ungrouped) {
			renderTask(task, store, lines, store.groups.length > 0 ? 3 : 2);
		}
		if (store.groups.length > 0) {
			lines.push("---\n");
		}
	}

	// Sprints section
	if (store.sprints.length > 0) {
		lines.push("## Sprints\n");
		for (const sprint of store.sprints) {
			renderSprint(sprint, store, lines);
			lines.push("");
		}
	}

	return lines.join("\n");
}

function renderTask(task: Task, store: TaskStore, lines: string[], headingLevel: number): void {
	const hashes = "#".repeat(Math.min(headingLevel, 6));
	const statusLabel = task.status === "done" ? "done ✓" : task.status.replace(/_/g, " ");

	// Heading: ### #5 Initialize repo [medium] — done ✓
	lines.push(`${hashes} #${task.id} ${escMd(task.title)} [${task.priority}] — ${statusLabel}\n`);

	// Description
	if (task.description) {
		lines.push(`${task.description}\n`);
	}

	const meta: string[] = [];

	if (task.assignee) meta.push(`**Assignee:** ${task.assignee}`);

	if (task.status === "done" && task.completedAt) {
		const time = task.actualMinutes != null ? ` (${formatElapsed(task.actualMinutes * 60000)})` : "";
		meta.push(`**Completed:** ${fmtDate(task.completedAt)}${time}`);
	}
	if (task.status === "in_progress" && task.startedAt) {
		meta.push(`**Started:** ${fmtDate(task.startedAt)}`);
	}
	if (task.estimatedMinutes != null) {
		meta.push(`**Estimated:** ${formatElapsed(task.estimatedMinutes * 60000)}`);
	}
	if (task.dependsOn.length > 0) {
		meta.push(`**Depends on:** ${task.dependsOn.map((d) => `#${d}`).join(", ")}`);
	}
	if (task.tags.length > 0) {
		meta.push(`**Tags:** ${task.tags.map((t) => `\`${t}\``).join(", ")}`);
	}
	if (task.groupId != null) {
		const group = findGroup(store, task.groupId);
		if (group) meta.push(`**Group:** G${group.id} ${group.name}`);
	}
	if (task.sprintId != null) {
		const sprint = store.sprints.find((s) => s.id === task.sprintId);
		if (sprint) meta.push(`**Sprint:** ${sprint.name}`);
	}

	if (meta.length > 0) {
		for (const m of meta) lines.push(`- ${m}`);
		lines.push("");
	}

	// Notes
	if (task.notes.length > 0) {
		lines.push("**Notes:**");
		for (const note of task.notes) {
			const time = fmtTime(note.timestamp);
			lines.push(`- [${note.author} ${time}] ${escMd(note.text)}`);
		}
		lines.push("");
	}
}

function renderSprint(sprint: Sprint, store: TaskStore, lines: string[]): void {
	const statusIcon = sprint.status === "active" ? "🟢" : sprint.status === "completed" ? "✅" : "📋";
	lines.push(`### ${statusIcon} ${sprint.name}`);

	lines.push(`- **Status:** ${sprint.status}`);
	if (sprint.startDate) lines.push(`- **Started:** ${fmtDate(sprint.startDate)}`);
	if (sprint.endDate) lines.push(`- **Target:** ${fmtDate(sprint.endDate)}`);
	if (sprint.completedDate) lines.push(`- **Completed:** ${fmtDate(sprint.completedDate)}`);

	const tasks = store.tasks.filter((t) => t.sprintId === sprint.id);
	const done = tasks.filter((t) => t.status === "done").length;
	lines.push(
		`- **Progress:** ${done}/${tasks.length} (${tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0}%)`,
	);

	if (sprint.description) {
		lines.push(`- **Description:** ${sprint.description}`);
	}
}

// ─── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string): string {
	return iso.slice(0, 10);
}

function fmtTime(iso: string): string {
	return iso.slice(11, 16);
}

/** Escape pipe and brackets that could break Markdown tables/links */
function escMd(text: string): string {
	return text.replace(/\|/g, "\\|");
}
