/**
 * Full Export — Complete task dump with hierarchy, notes, dependencies, time
 *
 * Renders tasks as a hierarchical Markdown document. Root tasks are H2,
 * children are H3/H4, preserving the parent-child tree.
 * Includes all metadata for round-trip import fidelity.
 *
 * Pure function: TaskStore → string
 */

import type { TaskStore, Task, Sprint } from "../types.js";
import { formatElapsed } from "../store.js";

const STATUS_MARK: Record<string, string> = {
	done: "✓", in_progress: "⏳", todo: "○",
	blocked: "⊘", in_review: "◉", deferred: "◌",
};

export function generateFullExport(store: TaskStore): string {
	const lines: string[] = [];
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");

	lines.push("# Project Tasks\n");
	lines.push(`> Generated: ${now}\n`);

	// Render tasks as a tree
	const rootTasks = store.tasks.filter((t) => t.parentId === null);

	for (const task of rootTasks) {
		renderTask(task, store, lines, 2); // H2 for root
		lines.push("---\n");
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
	const mark = STATUS_MARK[task.status] ?? "○";
	const statusLabel = task.status === "done" ? "done ✓" : task.status.replace(/_/g, " ");

	// Heading: ## #5 Initialize repo [medium] — done ✓
	lines.push(`${hashes} #${task.id} ${escMd(task.title)} [${task.priority}] — ${statusLabel}\n`);

	// Metadata
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

	// Render children recursively
	const children = store.tasks.filter((t) => t.parentId === task.id);
	for (const child of children) {
		renderTask(child, store, lines, headingLevel + 1);
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
	lines.push(`- **Progress:** ${done}/${tasks.length} (${tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0}%)`);

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
