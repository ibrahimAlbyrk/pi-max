import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { LspManager } from "../lib/lsp-manager.js";
import { detectAndSetup, detectLanguages, installMissingServers } from "../lib/language-detector.js";

export default function (pi: ExtensionAPI) {
	const manager = new LspManager();
	let sessionCwd = process.cwd();

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		const detected = await detectAndSetup(pi, ctx);
		for (const lang of detected) {
			try {
				await manager.startServer(lang.key, lang.config, ctx.cwd);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`LSP ${lang.config.server.name} failed to start: ${msg}`, "error");
			}
		}
		const status = formatStatus(manager);
		if (status) ctx.ui.setStatus("lsp", status);
	});

	pi.on("session_shutdown", async () => {
		await manager.stopAll();
	});

	// --- Commands ---

	pi.registerCommand("lsp-setup", {
		description: "Detect project languages and install missing LSP servers",
		handler: async (_args, ctx) => {
			// Stop existing servers first
			await manager.stopAll();

			// Detect and prompt for installation
			const all = await detectLanguages(pi, sessionCwd);
			const ready = await installMissingServers(pi, ctx, all);

			// Start ready servers
			for (const lang of ready) {
				try {
					await manager.startServer(lang.key, lang.config, sessionCwd);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`LSP ${lang.config.server.name} failed to start: ${msg}`, "error");
				}
			}

			const status = formatStatus(manager);
			if (status) {
				ctx.ui.setStatus("lsp", status);
				ctx.ui.notify(`LSP active: ${status}`, "info");
			} else {
				ctx.ui.setStatus("lsp", undefined);
				ctx.ui.notify("No LSP servers running.", "warning");
			}
		},
	});

	pi.registerCommand("lsp-status", {
		description: "Show LSP server status",
		handler: async (_args, ctx) => {
			const names = manager.getActiveServerNames();
			if (names.length === 0) {
				ctx.ui.notify("No LSP servers running. Use /lsp-setup to install.", "info");
			} else {
				ctx.ui.notify(`Active LSP servers: ${names.join(", ")}`, "info");
			}
		},
	});

	// --- Document sync on edit/write ---

	pi.on("tool_result", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = (event.input as Record<string, unknown>)?.path;
			if (typeof filePath === "string") {
				await manager.notifyFileChanged(filePath);
			}
		}
	});

	// --- Tool 1: lsp_diagnostics ---

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description:
			"Get compiler errors and warnings for a file or the entire workspace. " +
			"Use after editing code to check for compilation errors. " +
			"Returns diagnostics with file path, line, severity, and message.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "File path to check. Omit for all workspace diagnostics.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			if (!manager.hasActiveServers()) {
				return {
					content: [{ type: "text" as const, text: "No LSP servers running." }],
					details: {},
					isError: true,
				};
			}

			if (params.path) {
				const client = manager.getClientForFile(params.path);
				if (!client) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No LSP server available for ${params.path}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const diags = client.getDiagnosticsForFile(params.path);
				if (diags.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No diagnostics for ${params.path}` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text" as const, text: formatDiagnostics(params.path, diags) }],
					details: {},
				};
			}

			// All workspace diagnostics
			const allDiags = manager.getAllDiagnostics();
			if (allDiags.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No diagnostics in workspace." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text" as const, text: allDiags.join("\n") }],
				details: {},
			};
		},
	});

	// --- Tool 2: lsp_definition ---

	pi.registerTool({
		name: "lsp_definition",
		label: "Go to Definition",
		description:
			"Find where a symbol is defined. Returns the file path and line. " +
			"More accurate than grep -- resolves overloads, scopes, and namespaces correctly.",
		parameters: Type.Object({
			path: Type.String({ description: "File containing the symbol" }),
			line: Type.Number({ description: "1-indexed line number" }),
			character: Type.Number({ description: "1-indexed character offset" }),
		}),
		async execute(_toolCallId, params) {
			const client = manager.getClientForFile(params.path);
			if (!client) {
				return {
					content: [{ type: "text" as const, text: `No LSP server available for ${params.path}` }],
					details: {},
					isError: true,
				};
			}

			const result = await client.getDefinition(params.path, params.line - 1, params.character - 1);
			if (!result || result.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No definition found." }],
					details: {},
				};
			}

			const text = result.map((loc) => `${loc.file}:${loc.line + 1}:${loc.character + 1}`).join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {},
			};
		},
	});

	// --- Tool 3: lsp_references ---

	pi.registerTool({
		name: "lsp_references",
		label: "Find References",
		description:
			"Find all references to a symbol across the workspace. " +
			"More accurate than grep -- ignores comments, strings, and same-named symbols in different scopes.",
		parameters: Type.Object({
			path: Type.String({ description: "File containing the symbol" }),
			line: Type.Number({ description: "1-indexed line number" }),
			character: Type.Number({ description: "1-indexed character offset" }),
			includeDeclaration: Type.Optional(
				Type.Boolean({
					description: "Include the declaration itself. Default: true",
				})
			),
		}),
		async execute(_toolCallId, params) {
			const client = manager.getClientForFile(params.path);
			if (!client) {
				return {
					content: [{ type: "text" as const, text: `No LSP server available for ${params.path}` }],
					details: {},
					isError: true,
				};
			}

			const result = await client.getReferences(
				params.path,
				params.line - 1,
				params.character - 1,
				params.includeDeclaration ?? true
			);

			if (!result || result.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No references found." }],
					details: {},
				};
			}

			const text = result.map((loc) => `${loc.file}:${loc.line + 1}:${loc.character + 1}`).join("\n");
			return {
				content: [{ type: "text" as const, text: `${result.length} references:\n${text}` }],
				details: {},
			};
		},
	});
}

// --- Helpers ---

interface DiagnosticEntry {
	line: number;
	character: number;
	severity: number;
	message: string;
}

function formatDiagnostics(file: string, diags: DiagnosticEntry[]): string {
	return diags
		.map((d) => {
			const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
			return `${file}:${d.line + 1}:${d.character + 1} [${sev}] ${d.message}`;
		})
		.join("\n");
}

function formatStatus(manager: LspManager): string {
	const active = manager.getActiveServerNames();
	if (active.length === 0) return "";
	return active.join(" | ");
}
