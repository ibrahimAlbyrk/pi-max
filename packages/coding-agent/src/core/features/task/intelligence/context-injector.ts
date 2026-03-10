/**
 * Context Injector — Inject task state into LLM system prompt
 *
 * Budget scaling based on remaining context tokens:
 *   - Full  (30k+ remaining): Active task details, upcoming tasks, group progress, sprint info
 *   - Medium (10k-30k):       Active task + next 3 tasks only
 *   - Minimal (<10k):         Just active task ID and title
 *
 * When no active task: strongly prompts the LLM to start one with `task start #id`.
 */

import { findGroup, getGroupTasks } from "../store.js";
import type { TaskStore } from "../types.js";

/** Priority sort order (lower = higher priority). */
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Build a task context string to inject into the LLM system prompt.
 * Returns null when there are no actionable tasks.
 */
export function buildTaskContext(store: TaskStore, budgetLevel: "minimal" | "medium" | "full"): string | null {
	// All tasks are actionable (groups are separate entities)
	const activeTasks = store.tasks.filter((t) => ["todo", "in_progress", "in_review", "blocked"].includes(t.status));

	if (activeTasks.length === 0) return null;

	const activeTask = store.activeTaskId ? store.tasks.find((t) => t.id === store.activeTaskId) : null;

	const lines: string[] = [];

	if (activeTask) {
		// ── Active task present ──────────────────────────────────
		lines.push(`🔧 Currently working on: #${activeTask.id} — ${activeTask.title}`);
		lines.push(`   Status: ${activeTask.status} | Priority: ${activeTask.priority}`);

		if (budgetLevel !== "minimal" && activeTask.description) {
			lines.push(`   Description: ${activeTask.description}`);
		}

		// Show blocked dependencies
		if (activeTask.dependsOn.length > 0 && budgetLevel !== "minimal") {
			const unmetDeps = activeTask.dependsOn.filter((depId) => {
				const dep = store.tasks.find((t) => t.id === depId);
				return dep && dep.status !== "done";
			});
			if (unmetDeps.length > 0) {
				lines.push(`   ⚠️ Waiting on: ${unmetDeps.map((d) => `#${d}`).join(", ")}`);
			}
		}

		// Group progress (if task belongs to a group)
		if (budgetLevel !== "minimal" && activeTask.groupId !== null) {
			const group = findGroup(store, activeTask.groupId);
			if (group) {
				const groupTasks = getGroupTasks(store, group.id);
				const done = groupTasks.filter((t) => t.status === "done").length;
				lines.push(`   Group: G${group.id} ${group.name} (${done}/${groupTasks.length} done)`);
			}
		}

		lines.push("");
		lines.push(`When done with this task, call: task complete #${activeTask.id}`);
	} else {
		// ── No active task — guide LLM to pick one ──────────────
		lines.push("⚠️ NO ACTIVE TASK — You should start one before doing work.");
		lines.push("");

		// Find best candidates: in_progress first, then ready todos
		const inProgress = activeTasks.filter((t) => t.status === "in_progress");
		const readyTodos = activeTasks
			.filter((t) => {
				if (t.status !== "todo") return false;
				// Only "ready" if all dependencies are done
				if (t.dependsOn.length === 0) return true;
				return t.dependsOn.every((depId) => {
					const dep = store.tasks.find((d) => d.id === depId);
					return dep?.status === "done";
				});
			})
			.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

		if (inProgress.length > 0) {
			lines.push("These tasks are already in_progress — resume one:");
			for (const t of inProgress.slice(0, 3)) {
				lines.push(`  → task start #${t.id}  — ${t.title} [${t.priority}]`);
			}
		}

		if (readyTodos.length > 0) {
			lines.push(inProgress.length > 0 ? "" : "");
			lines.push("Ready to start (dependencies met):");
			for (const t of readyTodos.slice(0, 5)) {
				lines.push(`  → task start #${t.id}  — ${t.title} [${t.priority}]`);
			}
		}

		if (inProgress.length === 0 && readyTodos.length === 0) {
			lines.push("All remaining tasks are blocked. Check dependencies:");
			const blocked = activeTasks.filter((t) => t.status === "blocked").slice(0, 3);
			for (const t of blocked) {
				lines.push(`  - #${t.id} ${t.title} (blocked by: ${t.dependsOn.map((d) => `#${d}`).join(", ")})`);
			}
		}

		lines.push("");
		lines.push("IMPORTANT: Call `task start #<id>` to set the active task before working.");
	}

	// ── Upcoming tasks (when active task exists) ────────────────
	if (activeTask && budgetLevel !== "minimal") {
		const maxUpcoming = budgetLevel === "full" ? 7 : 3;
		const upcoming = activeTasks
			.filter((t) => t.id !== store.activeTaskId)
			.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2))
			.slice(0, maxUpcoming);

		if (upcoming.length > 0) {
			lines.push("Upcoming tasks:");
			for (const t of upcoming) {
				const deps = t.dependsOn.length > 0 ? ` (depends on: ${t.dependsOn.map((d) => `#${d}`).join(", ")})` : "";
				lines.push(`  - #${t.id} [${t.priority}] ${t.title} (${t.status})${deps}`);
			}
			lines.push("");
		}
	}

	// ── Sprint info ─────────────────────────────────────────────
	if (budgetLevel === "full" && store.activeSprintId) {
		const sprint = store.sprints.find((s) => s.id === store.activeSprintId);
		if (sprint) {
			const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id);
			const done = sprintTasks.filter((t) => t.status === "done").length;
			lines.push(`Active sprint: ${sprint.name} (${done}/${sprintTasks.length} done)`);
			lines.push("");
		}
	}

	// ── Archive hint ────────────────────────────────────────────
	const doneTasks = store.tasks.filter((t) => t.status === "done");
	if (doneTasks.length >= 5) {
		lines.push(`💡 ${doneTasks.length} done tasks in working set. Run \`task archive\` to clean up.`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Determine the appropriate budget level based on remaining context tokens.
 */
export function determineBudgetLevel(contextWindow: number, currentTokens: number): "minimal" | "medium" | "full" {
	const remaining = contextWindow - currentTokens;
	if (remaining < 10000) return "minimal";
	if (remaining < 30000) return "medium";
	return "full";
}
