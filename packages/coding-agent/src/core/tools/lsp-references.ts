/**
 * lsp_references tool — find all references to a symbol across the workspace.
 *
 * Two exports:
 * - lspReferencesDefinition: ToolDefinition for main agent (has renderCall/renderResult + ExtensionContext)
 * - createLspReferencesTool(cwd): factory returning a plain AgentTool for subagents via tool registry
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

const lspReferencesSchema = Type.Object({
	path: Type.String({ description: "File containing the symbol" }),
	line: Type.Number({ description: "1-indexed line number" }),
	character: Type.Number({ description: "1-indexed character offset" }),
	includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself. Default: true" })),
});

export type LspReferencesInput = Static<typeof lspReferencesSchema>;

export interface LspReferencesDetails {
	referenceCount: number;
	locations: Array<{ file: string; line: number; character: number }>;
}

// ── Shared description ──────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
	"Find all references to a symbol across the workspace. More accurate than grep -- ignores comments, strings, and same-named symbols in different scopes.";

// ── Shared execute logic ────────────────────────────────────────────────────

async function executeLspReferences(
	params: LspReferencesInput,
	cwd: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: LspReferencesDetails }> {
	const manager = getLspManager();
	const absPath = resolve(cwd, params.path);
	const client = manager.getClientForFile(absPath);

	if (!client) {
		return {
			content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
			details: { referenceCount: 0, locations: [] },
		};
	}

	// Default includeDeclaration to true
	const includeDecl = params.includeDeclaration !== false;

	// Convert from 1-indexed (tool API) to 0-indexed (LSP protocol)
	const locations = await client.getReferences(absPath, params.line - 1, params.character - 1, includeDecl);

	if (locations.length === 0) {
		return {
			content: [{ type: "text", text: "No references found." }],
			details: { referenceCount: 0, locations: [] },
		};
	}

	// Convert back to 1-indexed for output
	const formatted = locations.map((loc) => {
		const relPath = relative(cwd, loc.file);
		return `${relPath}:${loc.line + 1}:${loc.character + 1}`;
	});

	return {
		content: [{ type: "text", text: `${locations.length} references:\n${formatted.join("\n")}` }],
		details: {
			referenceCount: locations.length,
			locations: locations.map((loc) => ({
				file: relative(cwd, loc.file),
				line: loc.line + 1,
				character: loc.character + 1,
			})),
		},
	};
}

// ── Tool Definition (main agent — includes renderCall/renderResult) ──────────

export const lspReferencesDefinition: ToolDefinition<typeof lspReferencesSchema, LspReferencesDetails> = {
	name: "lsp_references",
	label: "LSP References",
	description: TOOL_DESCRIPTION,
	parameters: lspReferencesSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return executeLspReferences(params, ctx.cwd);
	},

	renderCall(args, _options, theme) {
		const path = (args?.path as string | undefined) ?? "?";
		const line = args?.line as number | undefined;
		const char = args?.character as number | undefined;
		const pos = line !== undefined && char !== undefined ? `:${line}:${char}` : "";
		return new Text(theme.fg("toolTitle", theme.bold("lsp_references ")) + theme.fg("accent", `${path}${pos}`), 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const count = result.details?.referenceCount ?? 0;
		if (count === 0) {
			return new Text(theme.fg("dim", "No references found."), 0, 0);
		}
		const raw = result.content[0];
		const text = raw?.type === "text" ? raw.text : "";
		if (!expanded) {
			return new Text(theme.fg("success", `${count} reference${count === 1 ? "" : "s"}`), 0, 0);
		}
		return new Text(text, 0, 0);
	},
};

// ── Factory (subagents via tool registry — plain AgentTool) ────────────────

export function createLspReferencesTool(cwd: string): AgentTool<typeof lspReferencesSchema> {
	return {
		name: "lsp_references",
		label: "lsp_references",
		sideEffects: false,
		description: TOOL_DESCRIPTION,
		parameters: lspReferencesSchema,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const manager = getLspManager();

			// Lazy init: if no servers are running, detect and start them for this cwd
			if (!manager.hasActiveServers()) {
				const languages = await detectAndSetup(cwd);
				for (const lang of languages) {
					await manager.startServer(lang.key, lang.config, cwd);
				}
			}

			return executeLspReferences(params, cwd);
		},
	};
}
