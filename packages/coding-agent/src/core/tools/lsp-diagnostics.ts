/**
 * lsp_diagnostics tool — get compiler errors/warnings for a file or workspace.
 *
 * Two exports:
 * - lspDiagnosticsDefinition: ToolDefinition for main agent (has renderCall/renderResult + ExtensionContext)
 * - createLspDiagnosticsTool(cwd): factory returning a plain AgentTool for subagents via tool registry
 *
 * Both share the same LspManager singleton within the Node.js process.
 */

import { relative, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { DiagnosticEntry } from "../features/lsp/client.js";
import { detectAndSetup } from "../features/lsp/language-detector.js";
import { getLspManager } from "../features/lsp/manager.js";

// ── Parameter Schema ────────────────────────────────────────────────────────

const lspDiagnosticsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "File path to check. Omit for all workspace diagnostics." })),
});

export type LspDiagnosticsInput = Static<typeof lspDiagnosticsSchema>;

export interface LspDiagnosticsDetails {
	file?: string;
	diagnosticCount: number;
}

// ── Shared description ──────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
	"Get compiler errors and warnings for a file or the entire workspace. Use after editing code to check for compilation errors. Returns diagnostics with file path, line, severity, and message.";

// ── Helpers ─────────────────────────────────────────────────────────────────

function severityLabel(severity: number): string {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		default:
			return "hint";
	}
}

function formatDiagnostics(filePath: string, diags: DiagnosticEntry[]): string {
	return diags
		.map((d) => `${filePath}:${d.line + 1}:${d.character + 1} [${severityLabel(d.severity)}] ${d.message}`)
		.join("\n");
}

// ── Shared execute logic ────────────────────────────────────────────────────

async function executeLspDiagnostics(
	params: LspDiagnosticsInput,
	cwd: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: LspDiagnosticsDetails }> {
	const manager = getLspManager();

	if (!manager.hasActiveServers()) {
		return {
			content: [{ type: "text", text: "No LSP servers active. Run /lsp-setup to configure." }],
			details: { diagnosticCount: 0 },
		};
	}

	if (params.path) {
		// Single file diagnostics
		const absPath = resolve(cwd, params.path);
		const client = manager.getClientForFile(absPath);
		if (!client) {
			return {
				content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
				details: { file: params.path, diagnosticCount: 0 },
			};
		}

		await client.ensureOpen(absPath);
		// Small delay to allow diagnostics to arrive from server
		await new Promise<void>((r) => setTimeout(r, 500));

		const diags = client.getDiagnosticsForFile(absPath);
		if (diags.length === 0) {
			return {
				content: [{ type: "text", text: "No diagnostics found." }],
				details: { file: params.path, diagnosticCount: 0 },
			};
		}

		const relPath = relative(cwd, absPath);
		const formatted = formatDiagnostics(relPath, diags);
		return {
			content: [{ type: "text", text: formatted }],
			details: { file: params.path, diagnosticCount: diags.length },
		};
	} else {
		// Workspace diagnostics
		const allDiags = manager.getAllDiagnostics();
		if (allDiags.length === 0) {
			return {
				content: [{ type: "text", text: "No diagnostics found." }],
				details: { diagnosticCount: 0 },
			};
		}

		return {
			content: [{ type: "text", text: allDiags.join("\n") }],
			details: { diagnosticCount: allDiags.length },
		};
	}
}

// ── Tool Definition (main agent — includes renderCall/renderResult) ──────────

export const lspDiagnosticsDefinition: ToolDefinition<typeof lspDiagnosticsSchema, LspDiagnosticsDetails> = {
	name: "lsp_diagnostics",
	label: "LSP Diagnostics",
	description: TOOL_DESCRIPTION,
	parameters: lspDiagnosticsSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return executeLspDiagnostics(params, ctx.cwd);
	},

	renderCall(args, _options, theme) {
		const path = (args?.path as string | undefined) ?? "workspace";
		return new Text(theme.fg("toolTitle", theme.bold("LSP Diagnostics ")) + theme.fg("accent", path), 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		if (result.details?.diagnosticCount === 0) {
			return new Text(theme.fg("success", "No diagnostics found."), 0, 0);
		}
		const raw = result.content[0];
		const text = raw?.type === "text" ? raw.text : "";
		if (!expanded) {
			const count = result.details?.diagnosticCount ?? 0;
			const file = result.details?.file ? ` in ${result.details.file}` : "";
			return new Text(theme.fg("error", `${count} diagnostic${count === 1 ? "" : "s"}${file}`), 0, 0);
		}
		// Colorize each line based on severity keyword
		const lines = text.split("\n").map((line) => {
			if (line.includes("[error]")) return theme.fg("error", line);
			if (line.includes("[warning]")) return theme.fg("warning", line);
			if (line.includes("[info]")) return theme.fg("muted", line);
			return theme.fg("dim", line);
		});
		return new Text(lines.join("\n"), 0, 0);
	},
};

// ── Factory (subagents via tool registry — plain AgentTool) ────────────────

export function createLspDiagnosticsTool(cwd: string): AgentTool<typeof lspDiagnosticsSchema> {
	return {
		name: "lsp_diagnostics",
		label: "lsp_diagnostics",
		sideEffects: false,
		description: TOOL_DESCRIPTION,
		parameters: lspDiagnosticsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const manager = getLspManager();

			// Lazy init: if no servers are running, detect and start them for this cwd
			if (!manager.hasActiveServers()) {
				const languages = await detectAndSetup(cwd);
				for (const lang of languages) {
					await manager.startServer(lang.key, lang.config, cwd);
				}
			}

			return executeLspDiagnostics(params, cwd);
		},
	};
}
