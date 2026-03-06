/**
 * Analyzer — Codebase analysis task suggestions
 *
 * Provides context for the LLM to analyze the codebase and suggest
 * new tasks. The actual analysis is done by the LLM using read/grep/find
 * tools — this module just prepares the prompt and current state summary.
 */

import { createLightSnapshot } from "../store.js";
import type { TaskStore, TaskToolResult } from "../types.js";

/**
 * Generate an analysis prompt result that guides the LLM to analyze
 * the codebase and suggest tasks via bulk_create.
 */
export function handleAnalyze(store: TaskStore, prompt?: string): TaskToolResult {
	const analysisPrompt = prompt ?? "Analyze the current codebase and suggest tasks";

	const totalTasks = store.tasks.length;
	const doneTasks = store.tasks.filter((t) => t.status === "done").length;
	const inProgressTasks = store.tasks.filter((t) => t.status === "in_progress").length;
	const blockedTasks = store.tasks.filter((t) => t.status === "blocked").length;
	const todoTasks = store.tasks.filter((t) => t.status === "todo").length;

	const lines: string[] = [
		`Analysis requested: "${analysisPrompt}"`,
		"",
		"Current task state:",
		`  Total: ${totalTasks} tasks`,
		`  Done: ${doneTasks} | In Progress: ${inProgressTasks} | Todo: ${todoTasks} | Blocked: ${blockedTasks}`,
	];

	// Show existing tags for context
	const allTags = new Set<string>();
	for (const t of store.tasks) {
		for (const tag of t.tags) allTags.add(tag);
	}
	if (allTags.size > 0) {
		lines.push(`  Tags in use: ${[...allTags].join(", ")}`);
	}

	// Show active sprint
	const activeSprint = store.sprints.find((s) => s.status === "active");
	if (activeSprint) {
		const sprintTasks = store.tasks.filter((t) => t.sprintId === activeSprint.id);
		const sprintDone = sprintTasks.filter((t) => t.status === "done").length;
		lines.push(`  Active sprint: ${activeSprint.name} (${sprintDone}/${sprintTasks.length} done)`);
	}

	lines.push("");
	lines.push("Instructions:");
	lines.push("1. Analyze the codebase using read/grep/find tools");
	lines.push("2. Identify gaps, missing features, or improvements");
	lines.push("3. Use bulk_create to add suggested tasks");
	lines.push("4. Set appropriate priorities and tags");
	lines.push("5. Add dependencies where tasks depend on existing ones");

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { store: createLightSnapshot(store), action: "analyze" },
	};
}
