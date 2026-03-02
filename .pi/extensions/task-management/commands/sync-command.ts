/**
 * /sync Command — Synchronize tasks with TASKS.md
 *
 * Usage:
 *   /sync              → push (write TASKS.md)
 *   /sync push         → write current state to TASKS.md
 *   /sync pull         → read TASKS.md and merge into store
 *   /sync config       → toggle sync settings
 *   /sync auto on      → enable auto-sync
 *   /sync auto off     → disable auto-sync
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskStore } from "../types.js";
import type { SyncConfig } from "../sync/sync-config.js";
import { syncPush, syncPullContent } from "../sync/file-sync.js";
import { parseMarkdownTasks } from "../import/parser.js";
import { planMerge, applyMerge, formatMergePlan } from "../import/merge.js";

export function registerSyncCommand(
	pi: ExtensionAPI,
	getStore: () => TaskStore,
	getSyncConfig: () => SyncConfig,
	setSyncConfig: (config: SyncConfig) => void,
	onMutate: () => void,
): void {
	pi.registerCommand("sync", {
		description: "Sync tasks: /sync [push|pull|config|auto on|off]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();
			const config = getSyncConfig();
			const action = (args || "push").trim();

			if (action === "push" || action === "") {
				// Push: write to file
				const prevEnabled = config.enabled;
				config.enabled = true; // temporarily enable for this push
				syncPush(store, config, ctx.cwd);
				config.enabled = prevEnabled;
				ctx.ui.notify(
					`Synced ${store.tasks.length} tasks → ${config.path} (${config.format})`,
					"info",
				);
				return;
			}

			if (action === "pull") {
				// Pull: read file and merge
				const content = syncPullContent(config, ctx.cwd);
				if (!content) {
					ctx.ui.notify(`File not found: ${config.path}`, "error");
					return;
				}

				const parsed = parseMarkdownTasks(content, "auto");
				if (parsed.length === 0) {
					ctx.ui.notify("No tasks found in file.", "warning");
					return;
				}

				const plan = planMerge(store.tasks, parsed);
				const total = plan.creates.length + plan.updates.length;

				if (total === 0) {
					ctx.ui.notify("Already in sync — no changes.", "info");
					return;
				}

				if (ctx.hasUI) {
					const preview = formatMergePlan(plan);
					const confirm = await ctx.ui.confirm(`Merge ${total} changes?`, preview);
					if (!confirm) return;
				}

				const result = applyMerge(store, plan);
				onMutate();
				ctx.ui.notify(
					`Pulled: ${result.created} new, ${result.updated} updated`,
					"info",
				);
				return;
			}

			if (action === "config") {
				if (!ctx.hasUI) return;

				const format = await ctx.ui.select("Export format:", ["summary", "full"]);
				if (format) config.format = format as "summary" | "full";

				const autoSync = await ctx.ui.confirm("Enable auto-sync?", "Write TASKS.md after every task change");
				config.autoSync = autoSync ?? false;
				config.enabled = config.autoSync;

				const syncExit = await ctx.ui.confirm("Sync on exit?", "Write TASKS.md when session ends");
				config.syncOnExit = syncExit ?? false;

				setSyncConfig({ ...config });
				ctx.ui.notify(
					`Sync config: format=${config.format}, auto=${config.autoSync}, exit=${config.syncOnExit}`,
					"info",
				);
				return;
			}

			if (action.startsWith("auto")) {
				const parts = action.split(/\s+/);
				const on = parts[1] !== "off";
				config.autoSync = on;
				config.enabled = on;
				setSyncConfig({ ...config });
				ctx.ui.notify(`Auto-sync: ${on ? "enabled" : "disabled"}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /sync [push|pull|config|auto on|off]", "warning");
		},
	});
}
