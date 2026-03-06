/**
 * Compaction Handler — Preserve task state through auto-compaction
 *
 * Generates a text summary of the task store for inclusion in the
 * compaction summary, ensuring task state is not lost when the session
 * context is compressed.
 */

import type { Task, TaskStore } from "../types.js";

/**
 * Generate a human-readable summary of the full task store suitable for
 * inclusion in a compaction summary entry.
 *
 * Groups tasks by status and includes active task + sprint markers so
 * the LLM can reconstruct context after compaction.
 */
export function generateTaskStateSummary(store: TaskStore): string {
	const lines: string[] = [];

	lines.push(`Total: ${store.tasks.length} tasks`);

	// Group by status
	const byStatus: Record<string, Task[]> = {};
	for (const t of store.tasks) {
		if (byStatus[t.status] === undefined) byStatus[t.status] = [];
		byStatus[t.status].push(t);
	}

	for (const [status, tasks] of Object.entries(byStatus)) {
		lines.push(`\n### ${status.toUpperCase()} (${tasks.length})`);
		for (const t of tasks) {
			let line = `- #${t.id} [${t.priority}] ${t.title}`;
			if (t.dependsOn.length > 0) {
				line += ` (depends on: ${t.dependsOn.map((d) => `#${d}`).join(", ")})`;
			}
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
