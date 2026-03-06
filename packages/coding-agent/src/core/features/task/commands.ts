/**
 * Built-in task slash commands, keyboard shortcuts, and widget registration.
 *
 * Call registerTaskCommands(pi) once after the extension runner is set up.
 * Only registerCommand and registerShortcut are used from ExtensionAPI.
 *
 * Pattern mirrors registerBgCommands in features/bg/commands.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../../extensions/types.js";
import { getTaskStorage, getTaskStore } from "../../tools/task.js";
import { registerBoardCommand, runBoardLoop } from "./commands/board-command.js";
import { registerExportCommand } from "./commands/export-command.js";
import { registerImportCommand } from "./commands/import-command.js";
import { registerSprintCommand } from "./commands/sprint-command.js";
import { registerSyncCommand } from "./commands/sync-command.js";
import { registerTaskDetailCommand } from "./commands/task-detail-command.js";
import { registerTaskHistoryCommand } from "./commands/task-history-command.js";
import { registerTasksCommand, showTaskListOverlay } from "./commands/tasks-command.js";
import { assignAgentToTask, clearAgentAssignment } from "./store.js";
import type { SyncConfig, TaskStore } from "./types.js";
import { createNextTasksComponent, updateNextTasksComponent } from "./widgets/next-tasks-widget.js";

/**
 * Module-level cwd tracker — set by command/shortcut handlers before getStore().
 * Safe because JavaScript is single-threaded (no concurrent handler execution).
 */
let _activeCwd = process.cwd();

/** Widget collapsed state — toggled by alt+t */
let _widgetCollapsed = false;

// Module-level sync config (persisted per-session, not per-file)
let _syncConfig: SyncConfig = {
	enabled: false,
	path: "TASKS.md",
	format: "summary" as const,
	autoSync: false,
	syncOnExit: false,
};

/**
 * Store accessor closure. Returns the task store for the active cwd.
 * The cwd is updated by each command/shortcut handler before calling getStore().
 */
function getStore(): TaskStore {
	return getTaskStore(_activeCwd);
}

function onMutate(): void {
	// After import/sync mutations, the store is already updated in-place
	// via the tool's store entry. No special action needed.
}

/**
 * Register all task management slash commands, keyboard shortcuts.
 *
 * Called from agent-session.ts via:
 *   extensionRunner.registerBuiltinExtension("<builtin-task>", registerTaskCommands)
 */
export function registerTaskCommands(pi: ExtensionAPI): void {
	// ── Slash Commands ────────────────────────────────────────────────────
	//
	// Each register*Command function calls pi.registerCommand() internally.
	// The command handlers receive ctx.cwd — we hook into pi.on("tool_call")
	// to track cwd. But since commands also get ctx, we track cwd via a
	// session_start hook.
	//
	// However, registerBuiltinExtension provides a minimal API. Instead,
	// we rely on _activeCwd being set via session_start or first command.

	// Track cwd via session_start + mount widget above editor.
	// ExtensionHandler<SessionStartEvent> = (event, ctx: ExtensionContext) => ...
	pi.on("session_start", (_event, ctx) => {
		_activeCwd = ctx.cwd;

		// Mount NextTasks widget above the editor
		if (ctx.hasUI) {
			ctx.ui.setWidget(
				"task-next",
				(tui, theme) => {
					const store = getStore();
					// Use createNextTasksComponent to set the module-level singleton
					// so updateNextTasksComponent (alt+t toggle) works correctly.
					return createNextTasksComponent(() => tui.requestRender(), theme, store, _widgetCollapsed);
				},
				{ placement: "aboveEditor" },
			);
		}
	});

	registerTasksCommand(pi, getStore);
	registerTaskDetailCommand(pi, getStore);
	registerBoardCommand(pi, getStore, onMutate);
	registerSprintCommand(pi, getStore);
	registerExportCommand(pi, getStore);
	registerImportCommand(pi, getStore, onMutate);
	registerSyncCommand(
		pi,
		getStore,
		() => _syncConfig,
		(config: SyncConfig) => {
			_syncConfig = config;
		},
		onMutate,
	);
	registerTaskHistoryCommand(pi, getStore);

	// ── Archive command ─────────────────────────────────────────────────────

	pi.registerCommand("archive", {
		description: "Archive done tasks and completed sprints",
		handler: async (_args, ctx) => {
			_activeCwd = ctx.cwd;
			const store = getStore();
			const storage = getTaskStorage(ctx.cwd);

			const doneTasks = store.tasks.filter((t) => t.status === "done");
			const completedSprints = store.sprints.filter((s) => s.status === "completed");

			if (doneTasks.length === 0 && completedSprints.length === 0) {
				ctx.ui.notify("Nothing to archive", "info");
				return;
			}

			storage.archiveTasks(doneTasks, store);
			if (completedSprints.length > 0) {
				storage.archiveSprints(completedSprints, store);
			}

			// Remove archived items from store
			const doneIds = new Set(doneTasks.map((t) => t.id));
			const sprintIds = new Set(completedSprints.map((s) => s.id));
			store.tasks = store.tasks.filter((t) => !doneIds.has(t.id));
			store.sprints = store.sprints.filter((s) => !sprintIds.has(s.id));
			storage.save(store);

			ctx.ui.notify(`Archived ${doneTasks.length} task(s) and ${completedSprints.length} sprint(s)`, "info");
		},
	});

	// ── Automation toggle command ────────────────────────────────────────────

	pi.registerCommand("automation", {
		description: "Toggle automation: /automation [autostart|autocomplete|autonote] [on|off]",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Automation config toggling — use the task tool for now", "info");
		},
	});

	// ── Keyboard Shortcuts ──────────────────────────────────────────────────

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open task list overlay",
		async handler(ctx) {
			if (!ctx.hasUI) return;
			_activeCwd = ctx.cwd;
			const store = getStore();
			if (store.tasks.length === 0) {
				ctx.ui.notify("No tasks yet.", "info");
				return;
			}
			// Cast to CommandContext — at runtime shortcuts receive the same context object
			await showTaskListOverlay(store.tasks, ctx as ExtensionCommandContext, store);
		},
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Open Kanban board",
		async handler(ctx) {
			if (!ctx.hasUI) return;
			_activeCwd = ctx.cwd;
			const store = getStore();
			if (store.tasks.length === 0) {
				ctx.ui.notify("No tasks yet.", "info");
				return;
			}
			await runBoardLoop(store, ctx as ExtensionCommandContext, onMutate);
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Toggle task widget collapse",
		handler(_ctx) {
			_widgetCollapsed = !_widgetCollapsed;
			const store = getStore();
			updateNextTasksComponent(store, _widgetCollapsed);
		},
	});

	// ── Bridge pi.events → task store (for subagent-system extension) ────

	pi.events.on("subagent:tasks-assigned", (data: unknown) => {
		const event = data as
			| { taskIds?: number[]; agent?: { agentId?: string; agentName?: string; agentColor?: string } }
			| null
			| undefined;
		if (!event?.taskIds || !event.agent) return;
		const { agentId, agentName, agentColor } = event.agent;
		if (!agentId || !agentName || !agentColor) return;

		const store = getStore();
		let changed = false;
		for (const taskId of event.taskIds) {
			if (assignAgentToTask(store, taskId, { agentId, agentName, agentColor })) {
				changed = true;
			}
		}
		if (changed) {
			const storage = getTaskStorage(_activeCwd);
			storage.save(store);
			updateNextTasksComponent(store, _widgetCollapsed);
		}
	});

	pi.events.on("subagent:tasks-unassigned", (data: unknown) => {
		const event = data as { agentId?: string } | null | undefined;
		if (!event?.agentId) return;

		const store = getStore();
		const cleared = clearAgentAssignment(store, event.agentId);
		if (cleared.length > 0) {
			const storage = getTaskStorage(_activeCwd);
			storage.save(store);
			updateNextTasksComponent(store, _widgetCollapsed);
		}
	});
}
