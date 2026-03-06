/**
 * Built-in /lsp-setup and /lsp-status slash command registration.
 *
 * Call registerLspCommands(pi) once after the extension runner is set up.
 * Only registerCommand is used — no shortcuts are needed for LSP commands.
 */

import { execCommand } from "../../exec.js";
import type { ExtensionAPI } from "../../extensions/types.js";
import { detectLanguages, installMissingServers } from "./language-detector.js";
import { getLspManager } from "./manager.js";

/**
 * Register /lsp-setup and /lsp-status slash commands via the extension API.
 *
 * /lsp-setup
 *   Stop existing servers, detect project languages, interactively install
 *   missing servers, start ready servers, and update the status bar.
 *
 * /lsp-status
 *   Show which LSP servers are currently active.
 */
export function registerLspCommands(pi: ExtensionAPI): void {
	const manager = getLspManager();

	// ── /lsp-setup ─────────────────────────────────────────────────────────

	pi.registerCommand("lsp-setup", {
		description: "Detect project languages and install missing LSP servers",

		async handler(_args, ctx) {
			// Stop any currently running servers before re-detecting
			await manager.stopAll();

			// Detect all supported languages in the project
			const languages = await detectLanguages(ctx.cwd);

			if (languages.length === 0) {
				ctx.ui.notify("No supported languages detected in project", "info");
				return;
			}

			// Interactive installation — wire callbacks to ctx.ui
			const readyLanguages = await installMissingServers(
				languages,
				(title, message) => ctx.ui.confirm(title, message),
				(message, type) => ctx.ui.notify(message, type),
				async (cmd) => {
					// Split the install command string into program + args for execCommand.
					// e.g. "npm install -g typescript-language-server typescript"
					const parts = cmd.trim().split(/\s+/);
					const program = parts[0]!;
					const args = parts.slice(1);
					return execCommand(program, args, ctx.cwd);
				},
			);

			// Start all servers that are now ready
			for (const lang of readyLanguages) {
				await manager.startServer(lang.key, lang.config, ctx.cwd);
			}

			// Update status bar and notify the user
			if (manager.hasActiveServers()) {
				const names = manager.getActiveServerNames();
				ctx.ui.setStatus("lsp", names.join(" | "));
				ctx.ui.notify(`LSP servers active: ${names.join(", ")}`, "info");
			} else {
				ctx.ui.setStatus("lsp", undefined);
				ctx.ui.notify("No LSP servers could be started", "warning");
			}
		},
	});

	// ── /lsp-status ────────────────────────────────────────────────────────

	pi.registerCommand("lsp-status", {
		description: "Show LSP server status",

		async handler(_args, ctx) {
			const names = manager.getActiveServerNames();

			if (names.length === 0) {
				ctx.ui.notify("No active LSP servers. Run /lsp-setup to configure.", "info");
			} else {
				ctx.ui.notify(`Active: ${names.join(", ")}`, "info");
			}
		},
	});
}
