/**
 * lsp_definition tool — find where a symbol is defined.
 *
 * Two exports:
 * - lspDefinitionDefinition: ToolDefinition for main agent (has renderCall/renderResult + ExtensionContext)
 * - createLspDefinitionTool(cwd): factory returning a plain AgentTool for subagents via tool registry
 *
 * Both share the same LspManager singleton within the Node.js process.
 * Tool API uses 1-indexed line/character; LSP protocol uses 0-indexed (conversion happens here).
 */

import { relative, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { detectAndSetup } from "../features/lsp/language-detector.js";
import { getLspManager } from "../features/lsp/manager.js";

// ── Parameter Schema ────────────────────────────────────────────────────────

const lspDefinitionSchema = Type.Object({
	path: Type.String({ description: "File containing the symbol" }),
	line: Type.Number({ description: "1-indexed line number" }),
	character: Type.Number({ description: "1-indexed character offset" }),
});

export type LspDefinitionInput = Static<typeof lspDefinitionSchema>;

export interface LspDefinitionDetails {
	locations: Array<{ file: string; line: number; character: number }>;
}

// ── Shared description ──────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
	"Find where a symbol is defined. Returns the file path and line. More accurate than grep -- resolves overloads, scopes, and namespaces correctly.";

// ── Shared execute logic ────────────────────────────────────────────────────

async function executeLspDefinition(
	params: LspDefinitionInput,
	cwd: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: LspDefinitionDetails }> {
	const manager = getLspManager();
	const absPath = resolve(cwd, params.path);
	const client = manager.getClientForFile(absPath);

	if (!client) {
		return {
			content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
			details: { locations: [] },
		};
	}

	// Convert from 1-indexed (tool API) to 0-indexed (LSP protocol)
	const locations = await client.getDefinition(absPath, params.line - 1, params.character - 1);

	if (locations.length === 0) {
		return {
			content: [{ type: "text", text: "No definition found." }],
			details: { locations: [] },
		};
	}

	// Convert back to 1-indexed for output
	const formatted = locations.map((loc) => {
		const relPath = relative(cwd, loc.file);
		return `${relPath}:${loc.line + 1}:${loc.character + 1}`;
	});

	return {
		content: [{ type: "text", text: formatted.join("\n") }],
		details: {
			locations: locations.map((loc) => ({
				file: relative(cwd, loc.file),
				line: loc.line + 1,
				character: loc.character + 1,
			})),
		},
	};
}

// ── Tool Definition (main agent — includes renderCall/renderResult) ──────────

export const lspDefinitionDefinition: ToolDefinition<typeof lspDefinitionSchema, LspDefinitionDetails> = {
	name: "lsp_definition",
	label: "LSP Definition",
	description: TOOL_DESCRIPTION,
	parameters: lspDefinitionSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return executeLspDefinition(params, ctx.cwd);
	},

	renderCall(args, _options, theme) {
		const path = (args?.path as string | undefined) ?? "?";
		const line = args?.line as number | undefined;
		const char = args?.character as number | undefined;
		const pos = line !== undefined && char !== undefined ? `:${line}:${char}` : "";
		return new Text(theme.fg("toolTitle", theme.bold("LSP Definition ")) + theme.fg("accent", `${path}${pos}`), 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const locations = result.details?.locations ?? [];
		if (locations.length === 0) {
			return new Text(theme.fg("dim", "No definition found."), 0, 0);
		}
		const raw = result.content[0];
		const text = raw?.type === "text" ? raw.text : "";
		if (!expanded) {
			const first = locations[0];
			const summary = first ? `${first.file}:${first.line}:${first.character}` : (text.split("\n")[0] ?? text);
			return new Text(theme.fg("success", summary), 0, 0);
		}
		return new Text(text, 0, 0);
	},
};

// ── Factory (subagents via tool registry — plain AgentTool) ────────────────

export function createLspDefinitionTool(cwd: string): AgentTool<typeof lspDefinitionSchema> {
	return {
		name: "lsp_definition",
		label: "lsp_definition",
		sideEffects: false,
		description: TOOL_DESCRIPTION,
		parameters: lspDefinitionSchema,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const manager = getLspManager();

			// Lazy init: if no servers are running, detect and start them for this cwd
			if (!manager.hasActiveServers()) {
				const languages = await detectAndSetup(cwd);
				for (const lang of languages) {
					await manager.startServer(lang.key, lang.config, cwd);
				}
			}

			return executeLspDefinition(params, cwd);
		},
	};
}
