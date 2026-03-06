/**
 * Task Feature — Feature setup module
 *
 * Central wiring point that connects all task modules to the agent session.
 * Creates a TaskContext class instance and registers all session hooks.
 *
 * Pattern mirrors BgFeatureSession/LspFeatureSession: a per-feature interface
 * declares only the session methods the task feature requires.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CompactionEntry, ReadonlySessionManager } from "../../session-manager.js";
import { _syncToolStore, setOnStoreChanged } from "../../tools/task.js";
import { appendAutoNote } from "./automation/auto-notes.js";
import { findBestTaskForFiles, findTaskByFileContext } from "./automation/file-correlator.js";
import { detectTestResult } from "./automation/test-detector.js";
import { TurnTracker } from "./automation/turn-tracker.js";
import type { EventEmitter } from "./integration/event-bus.js";
import { TaskEventEmitter } from "./integration/event-bus.js";
import { handleTaskCompletionHooks } from "./integration/extension-hooks.js";
import { generateTaskStateSummary } from "./intelligence/compaction-handler.js";
import { buildTaskContext, determineBudgetLevel } from "./intelligence/context-injector.js";
import { createDefaultStore, createStorage, persistToStorage, reconstructFromSession } from "./state.js";
import { assignAgentToTask, clearAgentAssignment, findTask } from "./store.js";
import { syncPush } from "./sync/file-sync.js";
import {
	type ActivityTracker,
	DEFAULT_AUTOMATION_CONFIG,
	DEFAULT_SYNC_CONFIG,
	type SyncConfig,
	type TaskAutomationConfig,
	type TaskContext,
	type TaskEventChannel,
	type TaskStorage,
	type TaskStore,
} from "./types.js";
import { updateNextTasksComponent } from "./widgets/next-tasks-widget.js";

// ─── Session Interface ────────────────────────────────────────────────────────

/**
 * Minimal interface describing the session hooks required by setupTaskFeature.
 * AgentSession implements all of these — the interface keeps the coupling to
 * the concrete class out of this module.
 */
export interface TaskFeatureSession {
	/** Register a handler called when the session shuts down. */
	onSessionShutdown(handler: () => Promise<void>): void;

	/** Register a handler called when a new agent session starts. */
	onSessionStart(handler: (ctx: { cwd: string }) => Promise<void>): void;

	/**
	 * Register a handler called before the agent starts processing each prompt.
	 * The handler may return custom messages to inject into the LLM context.
	 */
	onBeforeAgentStart(
		handler: (ctx: { cwd: string }) => Promise<
			| {
					messages?: Array<{
						customType: string;
						content: string;
						display: boolean;
						details?: unknown;
						excludeFromContext?: boolean;
					}>;
			  }
			| undefined
		>,
	): void;

	/** Register a handler called when a tool execution starts (before execution). */
	onToolCall(handler: (event: { toolName: string; input: unknown }) => Promise<void>): void;

	/** Register a handler called after a tool execution completes. */
	onToolResult(handler: (event: { toolName: string; input: unknown; result?: unknown }) => Promise<void>): void;

	/** Register a handler called when the agent finishes a run. */
	onAgentEnd(handler: (event: { messages: AgentMessage[] }) => Promise<void>): void;

	/** Register a handler called at the start of each agent turn. */
	onTurnStart(handler: (event: { turnIndex: number }) => Promise<void>): void;

	/** Register a handler called at the end of each agent turn. */
	onTurnEnd(handler: (event: { turnIndex: number }) => Promise<void>): void;

	/**
	 * Register a handler called before session compaction begins.
	 * May return additional context text appended to the compaction instructions.
	 */
	onSessionBeforeCompact(handler: () => Promise<{ additionalContext?: string } | undefined>): void;

	/**
	 * Register a handler called after session compaction completes.
	 * Receives the persisted compaction entry.
	 */
	onSessionCompact(handler: (event: { compactionEntry: CompactionEntry }) => Promise<void>): void;

	/**
	 * Register a handler called when the active session switches.
	 * Receives the switch reason and the previous session file path.
	 */
	onSessionSwitch(
		handler: (event: { reason: string; previousSessionFile: string | undefined }) => Promise<void>,
	): void;

	/**
	 * Register a handler called when the session is forked.
	 * Receives the previous session file path.
	 */
	onSessionFork(handler: (event: { previousSessionFile: string | undefined }) => Promise<void>): void;

	/** Subscribe to an internal session event. Returns an unsubscribe function. */
	onEvent(event: string, handler: (data: unknown) => void): () => void;

	/** Emit an internal session event to all registered handlers. */
	emitEvent(event: string, data: unknown): void;

	/**
	 * Append an arbitrary custom entry to the current session.
	 * Used for persisting snapshots alongside the conversation.
	 */
	appendEntry(customType: string, data: unknown): void;

	/** Session manager for branch-aware state reconstruction. */
	readonly sessionManager: ReadonlySessionManager;

	/**
	 * Returns current context window size and estimated token usage.
	 * Used for budget-aware task context injection in before_agent_start.
	 */
	getContextInfo(): { contextWindow: number; estimatedTokens: number };
}

// ─── TaskContext Class ────────────────────────────────────────────────────────

/**
 * Concrete implementation of the TaskContext interface.
 *
 * Holds all mutable state for the task feature: store, storage backend,
 * automation/sync config, event channel, and turn tracker.
 * Utility methods delegate to storage for granular or full saves.
 */
class TaskContextImpl implements TaskContext {
	store: TaskStore;
	storage: TaskStorage | null;
	automationConfig: TaskAutomationConfig;
	syncConfig: SyncConfig;
	taskEvents: TaskEventChannel;
	turnTracker: ActivityTracker;
	widgetCollapsed: boolean;

	constructor(emitter: EventEmitter) {
		this.store = createDefaultStore();
		this.storage = null;
		this.automationConfig = { ...DEFAULT_AUTOMATION_CONFIG };
		this.syncConfig = { ...DEFAULT_SYNC_CONFIG };
		this.taskEvents = new TaskEventEmitter(emitter);
		this.turnTracker = new TurnTracker();
		this.widgetCollapsed = false;
	}

	/** Persist the full store to file storage. No-op if storage not initialized. */
	saveToFile(): void {
		if (this.storage) {
			persistToStorage(this.store, this.storage);
		}
	}

	/** Save a single task file + update index. Falls back to index-only if task not found. */
	saveTaskFile(taskId: number): void {
		if (!this.storage) return;
		const task = this.store.tasks.find((t) => t.id === taskId);
		if (task) {
			this.storage.saveTask(task, this.store);
		} else {
			this.storage.saveIndex(this.store);
		}
	}

	/** Save only the index (for meta-only changes like activeTaskId). */
	saveIndex(): void {
		if (this.storage) {
			this.storage.saveIndex(this.store);
		}
	}
}

// ─── Feature Setup ────────────────────────────────────────────────────────────

/**
 * Wire all task management lifecycle hooks into an agent session.
 *
 * Creates a TaskContext instance and registers handlers for:
 *   session_start/shutdown      — load/save state
 *   session_switch/fork         — reload/reconstruct state on branch change
 *   before_agent_start          — inject task context into LLM system prompt
 *   session_before_compact      — append task state to compaction summary
 *   session_compact             — persist store snapshot post-compaction
 *   tool_call / tool_result     — track files/bash, auto-start, test detection
 *   agent_end                   — auto-notes generation
 *   turn_start / turn_end       — reset tracker, refresh UI
 *   subagent:tasks-assigned     — update agent assignment on tasks
 *   subagent:tasks-unassigned   — clear agent assignment from tasks
 *   task:completed              — git checkpoint + sprint/unblock detection
 *
 * Called from AgentSession constructor after other feature setups.
 */
export function setupTaskFeature(session: TaskFeatureSession): void {
	// ── Create shared context ────────────────────────────────────────────────

	const emitter: EventEmitter = {
		emit: (event: string, data: unknown) => session.emitEvent(event, data),
	};

	const ctx = new TaskContextImpl(emitter);

	/** Refresh the NextTasks widget with current store state. */
	const refreshWidget = () => {
		updateNextTasksComponent(ctx.store, ctx.widgetCollapsed);
	};

	// ── Session lifecycle ────────────────────────────────────────────────────

	// session_start: load store from .pi/tasks/, initialize storage
	session.onSessionStart(async (sessionCtx) => {
		try {
			ctx.storage = createStorage(sessionCtx.cwd);
			ctx.store = ctx.storage.load();
			ctx.saveToFile(); // Persist any migration changes immediately

			// Sync the tool's store entry so feature hooks and tool/commands/widget
			// share the SAME in-memory store instance.
			_syncToolStore(sessionCtx.cwd, ctx.store, ctx.storage);

			// Register widget refresh callback so tool mutations update the widget
			setOnStoreChanged(refreshWidget);
		} catch (err) {
			console.error("[task] session_start failed:", err);
			ctx.store = createDefaultStore();
		}
	});

	// session_shutdown: sync on exit if enabled, then save final state
	session.onSessionShutdown(async () => {
		try {
			if (ctx.syncConfig.syncOnExit && ctx.store.tasks.length > 0 && ctx.storage) {
				syncPush(
					ctx.store,
					{ ...ctx.syncConfig, enabled: true },
					ctx.storage.basePath.replace(/[\\/]\.pi[\\/]tasks$/, ""),
				);
			}
		} catch (err) {
			console.error("[task] sync on exit failed:", err);
		}
	});

	// session_switch: fresh load from file (switching to a different session)
	session.onSessionSwitch(async (_event) => {
		if (ctx.storage) {
			try {
				ctx.store = ctx.storage.load();
				_syncToolStore(ctx.storage.basePath.replace(/[\\/]\.pi[\\/]tasks$/, ""), ctx.store, ctx.storage);
			} catch (err) {
				console.error("[task] session_switch reload failed:", err);
				ctx.store = createDefaultStore();
			}
		}
	});

	// session_fork: reconstruct from session branch (branch navigation)
	session.onSessionFork(async (_event) => {
		if (ctx.storage) {
			try {
				ctx.store = reconstructFromSession(session.sessionManager, ctx.storage);
				_syncToolStore(ctx.storage.basePath.replace(/[\\/]\.pi[\\/]tasks$/, ""), ctx.store, ctx.storage);
			} catch (err) {
				console.error("[task] session_fork reconstruction failed:", err);
				ctx.store = ctx.storage.load();
			}
		}
	});

	// ── Agent start — context injection ─────────────────────────────────────

	// before_agent_start: inject task context into LLM context
	session.onBeforeAgentStart(async (_ctx) => {
		try {
			const info = session.getContextInfo();
			const budgetLevel = determineBudgetLevel(info.contextWindow, info.estimatedTokens);
			const taskContextText = buildTaskContext(ctx.store, budgetLevel);
			if (!taskContextText) return undefined;

			return {
				messages: [
					{
						customType: "task-context",
						content: taskContextText,
						display: false,
						excludeFromContext: false,
					},
				],
			};
		} catch (err) {
			console.error("[task] before_agent_start context injection failed:", err);
			return undefined;
		}
	});

	// ── Compaction safety ────────────────────────────────────────────────────

	// session_before_compact: add task state summary to compaction instructions
	session.onSessionBeforeCompact(async () => {
		try {
			if (ctx.store.tasks.length === 0) return undefined;
			const summary = generateTaskStateSummary(ctx.store);
			return { additionalContext: `\n\n## Task Management State\n\n${summary}` };
		} catch (err) {
			console.error("[task] session_before_compact failed:", err);
			return undefined;
		}
	});

	// session_compact: persist full store snapshot alongside compaction entry
	session.onSessionCompact(async (_event) => {
		try {
			session.appendEntry("task-store-snapshot", { store: ctx.store });
		} catch (err) {
			console.error("[task] session_compact snapshot failed:", err);
		}
	});

	// ── Tool tracking ────────────────────────────────────────────────────────

	// tool_call: track file edits in turn tracker, auto-start task on file edit
	session.onToolCall(async (event) => {
		try {
			const input = event.input as Record<string, unknown> | null | undefined;
			const filePath = typeof input?.path === "string" ? input.path : null;

			if (event.toolName === "edit" || event.toolName === "write") {
				if (filePath) {
					ctx.turnTracker.trackFile(filePath, event.toolName === "edit" ? "edit" : "write");

					// Auto-start: if a matching todo task is found, start it automatically
					if (ctx.automationConfig.autoStartOnFileEdit && ctx.storage) {
						const matchingTask = findTaskByFileContext(ctx.store, filePath);
						if (matchingTask && matchingTask.status === "todo") {
							matchingTask.status = "in_progress";
							matchingTask.startedAt = new Date().toISOString();
							ctx.store.activeTaskId = matchingTask.id;
							ctx.saveTaskFile(matchingTask.id);
							ctx.taskEvents.autoStarted(matchingTask, filePath);
							ctx.taskEvents.started(matchingTask);
							refreshWidget();
						}
					}
				}
			} else if (event.toolName === "read") {
				if (filePath) {
					ctx.turnTracker.trackFile(filePath, "read");
				}
			} else {
				ctx.turnTracker.trackToolCall();
			}
		} catch (err) {
			console.error("[task] tool_call handler failed:", err);
		}
	});

	// tool_result: track bash output + test detection, auto-complete on test pass
	session.onToolResult(async (event) => {
		try {
			if (event.toolName === "bash") {
				const input = event.input as Record<string, unknown> | null | undefined;
				const command = typeof input?.command === "string" ? input.command : "";

				// Extract text output from tool result
				const resultData = event.result as { content?: Array<{ type: string; text?: string }> } | null | undefined;
				const output = resultData?.content?.find((c) => c.type === "text")?.text ?? "";

				const testResult = detectTestResult(command, output);
				ctx.turnTracker.trackBash(command, output, testResult.isTestRun);

				// Auto-complete: if all tests pass and there's an active in-progress task, complete it
				if (
					ctx.automationConfig.autoCompleteOnTestPass &&
					testResult.allPassed &&
					ctx.store.activeTaskId &&
					ctx.storage
				) {
					const activeTask = findTask(ctx.store, ctx.store.activeTaskId);
					if (activeTask && activeTask.status === "in_progress") {
						const oldStatus = activeTask.status;
						activeTask.status = "done";
						activeTask.completedAt = new Date().toISOString();
						ctx.saveTaskFile(activeTask.id);
						ctx.taskEvents.statusChanged(activeTask, oldStatus, "done");
						refreshWidget();
					}
				}
			}
		} catch (err) {
			console.error("[task] tool_result handler failed:", err);
		}
	});

	// ── Turn lifecycle ───────────────────────────────────────────────────────

	// turn_start: reset per-turn activity tracker
	session.onTurnStart(async (_event) => {
		ctx.turnTracker.reset();
	});

	// turn_end: no-op in core (widgets live in interactive mode layer)
	session.onTurnEnd(async (_event) => {
		// Widget refresh happens in the interactive mode layer (not available here)
	});

	// ── Agent end — auto-notes ───────────────────────────────────────────────

	// agent_end: generate auto-notes from turn activity + assistant messages
	session.onAgentEnd(async (event) => {
		try {
			if (!ctx.automationConfig.autoNoteOnAgentEnd || !ctx.storage) return;
			if (!ctx.turnTracker.hasActivity()) return;

			// Find the best task to attach the note to
			const modifiedFiles = ctx.turnTracker.getModifiedFiles();
			let targetTask = null;

			if (modifiedFiles.length > 0) {
				const match = findBestTaskForFiles(ctx.store, modifiedFiles);
				targetTask = match?.task ?? null;
			}

			// Fall back to active task if no file match
			if (!targetTask && ctx.store.activeTaskId) {
				targetTask = findTask(ctx.store, ctx.store.activeTaskId) ?? null;
			}

			if (!targetTask || targetTask.status === "done") return;

			// Cast messages for structural compatibility with auto-notes module
			const messages = event.messages as unknown as Array<{ role: string; content: unknown }>;
			const noteAdded = appendAutoNote(
				targetTask,
				messages as Parameters<typeof appendAutoNote>[1],
				ctx.turnTracker,
			);
			if (noteAdded) {
				ctx.saveTaskFile(targetTask.id);
			}
		} catch (err) {
			console.error("[task] agent_end auto-notes failed:", err);
		}
	});

	// ── Inter-feature events ─────────────────────────────────────────────────

	// task:completed → run completion hooks (git checkpoint, sprint check, unblock detection)
	session.onEvent("task:completed", (data: unknown) => {
		try {
			const completedData = data as { task?: { id?: number } } | null | undefined;
			const taskId = completedData?.task?.id;
			if (taskId === undefined) return;
			const task = findTask(ctx.store, taskId);
			if (!task) return;
			handleTaskCompletionHooks(emitter, ctx.store, task);
			refreshWidget();
		} catch (err) {
			console.error("[task] task:completed hook failed:", err);
		}
	});

	// subagent:tasks-assigned → set agent assignment on specified tasks
	session.onEvent("subagent:tasks-assigned", (data: unknown) => {
		try {
			const event = data as
				| { taskIds?: number[]; agent?: { agentId?: string; agentName?: string; agentColor?: string } }
				| null
				| undefined;
			if (!event?.taskIds || !event.agent) return;
			const { agentId, agentName, agentColor } = event.agent;
			if (!agentId || !agentName || !agentColor) return;

			let changed = false;
			for (const taskId of event.taskIds) {
				const updated = assignAgentToTask(ctx.store, taskId, { agentId, agentName, agentColor });
				if (updated) changed = true;
			}
			if (changed && ctx.storage) {
				ctx.saveToFile();
				refreshWidget();
			}
		} catch (err) {
			console.error("[task] subagent:tasks-assigned handler failed:", err);
		}
	});

	// subagent:tasks-unassigned → clear agent assignment from all tasks belonging to this agent
	session.onEvent("subagent:tasks-unassigned", (data: unknown) => {
		try {
			const event = data as { agentId?: string } | null | undefined;
			if (!event?.agentId) return;

			const cleared = clearAgentAssignment(ctx.store, event.agentId);
			if (cleared.length > 0 && ctx.storage) {
				// Granular save: only update changed tasks
				for (const taskId of cleared) {
					ctx.saveTaskFile(taskId);
				}
				refreshWidget();
			}
		} catch (err) {
			console.error("[task] subagent:tasks-unassigned handler failed:", err);
		}
	});
}
