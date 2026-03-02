/**
 * Context Injector — Inject task state into LLM system prompt
 *
 * v2 improvements:
 *   - When no active task: strongly prompt LLM to pick one with `task start #id`
 *   - When active task: include concrete next-step hints
 *   - Include recent turn activity context if available
 *   - Better budget scaling
 */

import type { TaskStore, Task } from "../types.js";
import { isGroupContainer } from "../store.js";
import { PRIORITY_ORDER } from "../ui/helpers.js";

export function buildTaskContext(
	store: TaskStore,
	budgetLevel: "minimal" | "medium" | "full",
): string | null {
	// Only consider leaf tasks — group containers are not actionable
	const activeTasks = store.tasks.filter((t) =>
		!isGroupContainer(store, t.id) &&
		["todo", "in_progress", "in_review", "blocked"].includes(t.status),
	);

	if (activeTasks.length === 0) return null;

	const activeTask = store.activeTaskId
		? store.tasks.find((t) => t.id === store.activeTaskId)
		: null;

	const lines: string[] = ["[TASK MANAGEMENT — OPERATIONAL PROTOCOL]"];

	// ── Workflow directives (always injected, concise) ───────────
	lines.push("");
	lines.push("RULES:");
	lines.push("• Before ANY implementation work, create tasks with bulk_create (one call, not loops).");
	lines.push("• Use negative parentId in bulk_create for hierarchy: -1=1st item, -2=2nd, etc.");
	lines.push("  Example: [{title:\"Auth\"}, {title:\"Login\", parentId:-1}, {title:\"JWT\", parentId:-1}]");
	lines.push("• One task at a time: start → work → complete → next.");
	lines.push("• Each task = one concrete deliverable. If multi-step, split into subtasks.");
	lines.push("• When multiple operations are needed, batch them (bulk_create, not repeated create).");
	lines.push("");

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

		// Sub-tasks progress
		if (budgetLevel !== "minimal") {
			const subtasks = store.tasks.filter((t) => t.parentId === activeTask.id);
			if (subtasks.length > 0) {
				const done = subtasks.filter((t) => t.status === "done").length;
				lines.push(`   Sub-tasks: ${done}/${subtasks.length} done`);
				const nextSub = subtasks.find((t) => t.status === "todo" || t.status === "in_progress");
				if (nextSub) {
					lines.push(`   Next sub-task: #${nextSub.id} — ${nextSub.title}`);
				}
			}
		}

		lines.push("");
		lines.push("When done with this task, call: task complete #" + activeTask.id);

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
				const deps = t.dependsOn.length > 0
					? ` (depends on: ${t.dependsOn.map((d) => `#${d}`).join(", ")})`
					: "";
				lines.push(`  - #${t.id} [${t.priority}] ${t.title} (${t.status})${deps}`);
			}
			lines.push("");
		}
	}

	// ── Sprint info ─────────────────────────────────────────────
	if (budgetLevel === "full" && store.activeSprintId) {
		const sprint = store.sprints.find((s) => s.id === store.activeSprintId);
		if (sprint) {
			const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id && !isGroupContainer(store, t.id));
			const done = sprintTasks.filter((t) => t.status === "done").length;
			lines.push(`Active sprint: ${sprint.name} (${done}/${sprintTasks.length} done)`);
			lines.push("");
		}
	}

	// ── Archive hint ────────────────────────────────────────────
	const doneTasks = store.tasks.filter((t) => t.status === "done" && !isGroupContainer(store, t.id));
	if (doneTasks.length >= 5) {
		lines.push(`💡 ${doneTasks.length} done tasks in working set. Run \`task archive\` to clean up.`);
		lines.push("");
	}

	return lines.join("\n");
}

export function determineBudgetLevel(
	contextWindow: number,
	currentTokens: number,
): "minimal" | "medium" | "full" {
	const remaining = contextWindow - currentTokens;
	if (remaining < 10000) return "minimal";
	if (remaining < 30000) return "medium";
	return "full";
}
