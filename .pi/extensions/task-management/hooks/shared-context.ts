/**
 * Shared mutable context passed to all hook modules.
 *
 * This replaces the many closure variables in index.ts,
 * enabling hook logic to be split across files while sharing state.
 */

import type { TaskStore } from "../types.js";
import type { TaskStorage } from "../storage.js";
import type { TaskAutomationConfig } from "../automation/config.js";
import type { SyncConfig } from "../sync/sync-config.js";
import type { TaskEventEmitter } from "../integration/event-bus.js";
import type { TurnTracker } from "../automation/turn-tracker.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface SharedContext {
	/** Current in-memory store (mutable) */
	store: TaskStore;
	/** File storage backend (null until session_start) */
	storage: TaskStorage | null;
	/** Automation toggles */
	automationConfig: TaskAutomationConfig;
	/** TASKS.md sync settings */
	syncConfig: SyncConfig;
	/** Task event emitter for inter-extension communication */
	taskEvents: TaskEventEmitter;
	/** Per-turn activity tracker */
	turnTracker: TurnTracker;
	/** Whether the editor widget is collapsed */
	widgetCollapsed: boolean;

	// ── Utility functions (bound in index.ts) ────────────────────
	saveToFile: (ctx?: ExtensionContext) => void;
	saveTaskFile: (taskId: number, ctx?: ExtensionContext) => void;
	saveIndex: () => void;
	refreshWidgets: (ctx: ExtensionContext) => void;
}
