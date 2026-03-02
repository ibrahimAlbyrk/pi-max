/**
 * Task History Export — Full history of a single task
 *
 * Exports all status changes, notes, time entries as a standalone Markdown document.
 * Useful for traceability and project audits.
 */

import type { Task, TaskStore } from "../types.js";
import { formatElapsed } from "../store.js";

export function generateTaskHistory(task: Task, store: TaskStore): string {
	const lines: string[] = [];

	lines.push(`# Task #${task.id}: ${task.title}\n`);

	// Overview
	lines.push("## Overview\n");
	lines.push(`| Field | Value |`);
	lines.push(`|-------|-------|`);
	lines.push(`| Status | ${task.status.replace(/_/g, " ")} |`);
	lines.push(`| Priority | ${task.priority} |`);
	lines.push(`| Created | ${fmtDateTime(task.createdAt)} |`);
	if (task.startedAt) lines.push(`| Started | ${fmtDateTime(task.startedAt)} |`);
	if (task.completedAt) lines.push(`| Completed | ${fmtDateTime(task.completedAt)} |`);
	if (task.estimatedMinutes != null) lines.push(`| Estimated | ${formatElapsed(task.estimatedMinutes * 60000)} |`);
	if (task.actualMinutes != null) lines.push(`| Actual | ${formatElapsed(task.actualMinutes * 60000)} |`);
	if (task.assignee) lines.push(`| Assignee | ${task.assignee} |`);
	if (task.tags.length > 0) lines.push(`| Tags | ${task.tags.join(", ")} |`);
	lines.push("");

	// Description
	if (task.description) {
		lines.push("## Description\n");
		lines.push(task.description);
		lines.push("");
	}

	// Parent
	if (task.parentId != null) {
		const parent = store.tasks.find((t) => t.id === task.parentId);
		if (parent) {
			lines.push(`## Parent\n`);
			lines.push(`- #${parent.id}: ${parent.title} (${parent.status})`);
			lines.push("");
		}
	}

	// Subtasks
	const subtasks = store.tasks.filter((t) => t.parentId === task.id);
	if (subtasks.length > 0) {
		lines.push("## Subtasks\n");
		for (const sub of subtasks) {
			const check = sub.status === "done" ? "[x]" : "[ ]";
			lines.push(`- ${check} #${sub.id} ${sub.title} [${sub.priority}] — ${sub.status}`);
		}
		lines.push("");
	}

	// Dependencies
	if (task.dependsOn.length > 0) {
		lines.push("## Dependencies\n");
		for (const depId of task.dependsOn) {
			const dep = store.tasks.find((t) => t.id === depId);
			if (dep) {
				const icon = dep.status === "done" ? "✅" : "⏳";
				lines.push(`- ${icon} #${dep.id}: ${dep.title} (${dep.status})`);
			} else {
				lines.push(`- ❓ #${depId}: (not found)`);
			}
		}
		lines.push("");
	}

	// Blocks
	const blocks = store.tasks.filter((t) => t.dependsOn.includes(task.id));
	if (blocks.length > 0) {
		lines.push("## Blocks\n");
		for (const b of blocks) {
			lines.push(`- #${b.id}: ${b.title} (${b.status})`);
		}
		lines.push("");
	}

	// Sprint
	if (task.sprintId != null) {
		const sprint = store.sprints.find((s) => s.id === task.sprintId);
		if (sprint) {
			lines.push("## Sprint\n");
			lines.push(`- ${sprint.name} (${sprint.status})`);
			lines.push("");
		}
	}

	// Notes (chronological log)
	if (task.notes.length > 0) {
		lines.push("## Activity Log\n");
		lines.push("| Time | Author | Note |");
		lines.push("|------|--------|------|");
		for (const note of task.notes) {
			const time = fmtDateTime(note.timestamp);
			const text = note.text.replace(/\|/g, "\\|").replace(/\n/g, " ");
			lines.push(`| ${time} | ${note.author} | ${text} |`);
		}
		lines.push("");
	}

	// Timeline
	lines.push("## Timeline\n");
	const events: { time: string; event: string }[] = [];
	events.push({ time: task.createdAt, event: "Created" });
	if (task.startedAt) events.push({ time: task.startedAt, event: "Started" });
	for (const note of task.notes) {
		events.push({ time: note.timestamp, event: `Note by ${note.author}` });
	}
	if (task.completedAt) events.push({ time: task.completedAt, event: "Completed" });

	events.sort((a, b) => a.time.localeCompare(b.time));
	for (const e of events) {
		lines.push(`- \`${fmtDateTime(e.time)}\` — ${e.event}`);
	}
	lines.push("");

	return lines.join("\n");
}

function fmtDateTime(iso: string): string {
	return iso.slice(0, 16).replace("T", " ");
}
