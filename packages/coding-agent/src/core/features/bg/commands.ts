/**
 * Built-in /bg slash command and shift+down keyboard shortcut registration.
 *
 * Call registerBgCommands(pi) once after the extension runner is set up.
 * Only registerCommand and registerShortcut are used — all other ExtensionAPI
 * methods are not called from this module.
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "../../extensions/types.js";
import { getProcessManager } from "./manager.js";
import { showProcessPanel } from "./panel.js";

/**
 * Register the /bg slash command and shift+down keyboard shortcut
 * via the extension API.
 *
 * /bg [stop <name>|stopall|clean]
 *   no args   → open ProcessPanel
 *   stop <n>  → stop named process
 *   stopall   → stop all processes
 *   clean     → remove dead processes
 *
 * shift+down → open ProcessPanel
 */
export function registerBgCommands(pi: ExtensionAPI): void {
	const manager = getProcessManager();

	// ── /bg command ────────────────────────────────────────────────────────

	pi.registerCommand("bg", {
		description: "Background processes: /bg [stop <name>|stopall|clean]",

		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const parts = prefix.trim().split(/\s+/);
			const first = parts[0] ?? "";

			if (parts.length <= 1) {
				// Top-level subcommand completions
				return (["stop", "stopall", "clean"] as const)
					.filter((s) => s.startsWith(first))
					.map((s) => ({ label: s, value: `${s} `, description: subcommandDescription(s) }));
			}

			if (parts[0] === "stop") {
				// Process name completions for "stop <name>"
				const namePrefix = parts[1] ?? "";
				return manager
					.list()
					.filter((p) => p.status === "running" && p.name.startsWith(namePrefix))
					.map((p) => ({
						label: p.name,
						value: `stop ${p.name}`,
						description: p.command,
					}));
			}

			return null;
		},

		async handler(args, ctx) {
			const trimmed = (args ?? "").trim();
			const parts = trimmed ? trimmed.split(/\s+/) : [];
			const sub = parts[0] ?? "";

			switch (sub) {
				case "stop": {
					const name = parts[1];
					if (!name) {
						ctx.ui.notify("Usage: /bg stop <name>", "warning");
						return;
					}
					const result = await manager.stop(name);
					ctx.ui.notify(
						result.success ? `Stopped "${name}"` : (result.error ?? "Unknown error"),
						result.success ? "info" : "error",
					);
					return;
				}

				case "stopall": {
					const count = manager.runningCount;
					await manager.stopAll();
					ctx.ui.notify(`Stopped ${count} process(es)`, "info");
					return;
				}

				case "clean": {
					const removed = manager.cleanup();
					ctx.ui.notify(`Cleaned up ${removed} dead process(es)`, "info");
					return;
				}

				default: {
					// No args (or unrecognised) → open panel if UI available
					if (ctx.hasUI) {
						await showProcessPanel(manager, ctx);
					} else {
						const processes = manager.list();
						ctx.ui.notify(
							processes.length === 0
								? "No background processes"
								: processes
										.map((p) => `${p.status === "running" ? "▶" : "■"} ${p.name} (${p.status})`)
										.join("\n"),
							"info",
						);
					}
				}
			}
		},
	});

	// ── shift+down shortcut ────────────────────────────────────────────────

	pi.registerShortcut("shift+down", {
		description: "Open background processes panel",
		async handler(ctx) {
			if (!ctx.hasUI) return;
			await showProcessPanel(manager, ctx);
		},
	});
}

// ── Helpers ────────────────────────────────────────────────────────────────

function subcommandDescription(sub: "stop" | "stopall" | "clean"): string {
	switch (sub) {
		case "stop":
			return "Stop a process";
		case "stopall":
			return "Stop all processes";
		case "clean":
			return "Remove dead processes";
	}
}
