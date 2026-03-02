/**
 * Compaction Handler — Preserve task state through auto-compaction
 */

import type { TaskStore, Task } from "../types.js";

export function generateTaskStateSummary(store: TaskStore): string {
	const lines: string[] = [];

	lines.push(`Total: ${store.tasks.length} tasks`);

	// Group by status
	const byStatus: Record<string, Task[]> = {};
	for (const t of store.tasks) {
		(byStatus[t.status] ??= []).push(t);
	}

	for (const [status, tasks] of Object.entries(byStatus)) {
		lines.push(`\n### ${status.toUpperCase()} (${tasks.length})`);
		for (const t of tasks) {
			let line = `- #${t.id} [${t.priority}] ${t.title}`;
			if (t.dependsOn.length > 0) line += ` (depends on: ${t.dependsOn.map((d) => `#${d}`).join(", ")})`;
			lines.push(line);
			if (t.description) lines.push(`  ${t.description.slice(0, 100)}`);
		}
	}

	if (store.activeTaskId) {
		lines.push(`\nActive task: #${store.activeTaskId}`);
	}

	// Sprint info
	const activeSprint = store.sprints.find((s) => s.status === "active");
	if (activeSprint) {
		const sprintTasks = store.tasks.filter((t) => t.sprintId === activeSprint.id);
		const done = sprintTasks.filter((t) => t.status === "done").length;
		lines.push(`\nActive sprint: #S${activeSprint.id} ${activeSprint.name} (${done}/${sprintTasks.length} done)`);
	}

	return lines.join("\n");
}
