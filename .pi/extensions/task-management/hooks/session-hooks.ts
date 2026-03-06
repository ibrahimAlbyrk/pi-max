/**
 * Session Hooks — session lifecycle, turn start/end, shutdown
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SharedContext } from "./shared-context.js";
import { PerFileTaskStorage } from "../storage.js";
import { loadFromStorage, reconstructFromSession } from "../state.js";
import { parseMarkdownTasks } from "../import/parser.js";
import { planMerge, applyMerge } from "../import/merge.js";
import { syncFileExists, syncPullContent, syncPush } from "../sync/file-sync.js";

export function registerSessionHooks(pi: ExtensionAPI, sc: SharedContext): void {

	pi.on("session_start", async (_event, ctx) => {
		sc.storage = new PerFileTaskStorage(ctx.cwd);
		sc.store = loadFromStorage(sc.storage);
		sc.saveToFile(ctx);

		// Auto-import from TASKS.md if no tasks exist
		if (sc.store.tasks.length === 0 && syncFileExists(sc.syncConfig, ctx.cwd)) {
			const content = syncPullContent(sc.syncConfig, ctx.cwd);
			if (content) {
				const parsed = parseMarkdownTasks(content, "auto");
				if (parsed.length > 0) {
					const plan = planMerge([], parsed);
					applyMerge(sc.store, plan);
					sc.saveToFile();
					ctx.ui.notify(`Auto-loaded ${parsed.length} tasks from ${sc.syncConfig.path}`, "info");
				}
			}
		}

		sc.refreshWidgets(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		sc.storage = new PerFileTaskStorage(ctx.cwd);
		sc.store = loadFromStorage(sc.storage);
		sc.saveToFile(ctx);
		sc.refreshWidgets(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!sc.storage) sc.storage = new PerFileTaskStorage(ctx.cwd);
		sc.store = reconstructFromSession(ctx, sc.storage);
		sc.refreshWidgets(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		if (!sc.storage) sc.storage = new PerFileTaskStorage(ctx.cwd);
		sc.store = reconstructFromSession(ctx, sc.storage);
		sc.refreshWidgets(ctx);
	});

	pi.on("turn_start", async (_event, _ctx) => {
		sc.turnTracker.reset();
	});

	pi.on("turn_end", async (_event, ctx) => {
		sc.refreshWidgets(ctx);
	});

	// Phase 5: Sync on exit + widget cleanup
	pi.on("session_shutdown", async (_event, ctx) => {
		if (sc.syncConfig.syncOnExit && sc.store.tasks.length > 0) {
			syncPush(sc.store, { ...sc.syncConfig, enabled: true }, ctx.cwd);
		}
		// Reset persistent widget state for next session
		const { resetNextTasksWidget } = await import("../widgets/next-tasks-widget.js");
		resetNextTasksWidget();
	});
}
