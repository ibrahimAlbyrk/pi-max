/**
 * MCP Gateway Extension — mcp_search Tool
 *
 * Meta-tool that lets the agent discover tools across all configured MCP servers.
 * Searches the in-memory catalog by qualified name, description, and parameter names.
 * Optionally refreshes the catalog from all servers before searching.
 *
 * Usage: export a factory function so the caller can inject the live catalog instance
 * and a refresh callback — both are unavailable at module load time.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type { ToolCatalog } from "../catalog.js";
import { DEFAULT_SEARCH_LIMIT } from "../constants.js";

// ─── Parameter Schema ─────────────────────────────────────────────────────────

const searchParams = Type.Object({
	query: Type.String({
		description:
			"Search term. Natural language or keyword. " +
			'Examples: "github issues", "send slack message", "database query".',
	}),
	server: Type.Optional(
		Type.String({
			description: "Restrict results to a specific MCP server by name. Omit to search all servers.",
		}),
	),
	refresh: Type.Optional(
		Type.Boolean({
			description:
				"If true, refresh the tool catalog from all MCP servers before searching. " +
				"Use when new tools may have been added or a server was updated. Default: false.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Max results to return. Default: 20.",
			minimum: 1,
		}),
	),
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the mcp_search ToolDefinition.
 *
 * @param catalog   - Live tool catalog shared across the extension.
 * @param onRefresh - Callback that repopulates the catalog from all MCP servers.
 *                    Awaited before searching when params.refresh is true.
 */
export function createSearchTool(
	catalog: ToolCatalog,
	onRefresh: () => Promise<void>,
): ToolDefinition<typeof searchParams, undefined> {
	return {
		name: "mcp_search",
		label: "MCP Search",
		description:
			"Search for tools available on connected MCP servers. " +
			"Returns tool names (for use with mcp_call), descriptions, server names, and parameter lists. " +
			"Use this before calling mcp_call to discover the correct qualified tool name. " +
			"Optionally filter by server name or refresh the catalog.",
		parameters: searchParams,
		sideEffects: false,

		renderCall(args, _options, theme) {
			let text = theme.fg("toolTitle", theme.bold("mcp_search "));
			text += theme.fg("accent", args.query);
			if (args.server) {
				text += theme.fg("muted", ` [server: ${args.server}]`);
			}
			if (args.refresh) {
				text += theme.fg("muted", " (refresh)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const content = result.content[0];
			if (!content || content.type !== "text") {
				return new Text(theme.fg("dim", "No results"), 0, 0);
			}

			const lines = content.text.split("\n").filter((l: string) => l.startsWith("Tool: "));
			const count = lines.length;

			if (count === 0) {
				return new Text(theme.fg("warning", content.text.split("\n")[0]), 0, 0);
			}

			let text = theme.fg("success", `${count} tool${count > 1 ? "s" : ""} found`);

			if (expanded) {
				for (const line of lines) {
					const name = line.replace("Tool: ", "");
					text += "\n  " + theme.fg("dim", name);
				}
			}

			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Step 1 — optional catalog refresh
			if (params.refresh === true) {
				await onRefresh();
			}

			// Step 2 — check for empty catalog (no servers configured / loaded)
			if (catalog.isEmpty()) {
				return {
					content: [{ type: "text" as const, text: "No MCP servers configured." }],
					details: undefined,
				};
			}

			// Step 3 — search
			const results = catalog.search(params.query, {
				server: params.server,
				limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
			});

			// Step 4 — no results case
			if (results.length === 0) {
				const serverNames = catalog.getServerNames();
				const serverList =
					serverNames.length > 0
						? `\n\nAvailable servers: ${serverNames.join(", ")}`
						: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `No matching tools found.${serverList}`,
						},
					],
					details: undefined,
				};
			}

			// Step 5 — format results
			const lines: string[] = [];

			for (const entry of results) {
				lines.push(`Tool: ${entry.qualifiedName}`);
				lines.push(`  Description: ${entry.description || "(no description)"}`);
				lines.push(`  Server: ${entry.serverName}`);
				lines.push(
					`  Parameters: ${
						entry.parameterSummary.length > 0
							? entry.parameterSummary.join(", ")
							: "(none)"
					}`,
				);
				lines.push("");
			}

			// Remove trailing blank line
			if (lines[lines.length - 1] === "") {
				lines.pop();
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: undefined,
			};
		},
	};
}
