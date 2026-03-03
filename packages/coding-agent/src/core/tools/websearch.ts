import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { duckduckgoProvider } from "./search-providers/duckduckgo.js";
import type { SearchProvider, SearchResult } from "./search-providers/types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;

const websearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(
		Type.Number({ description: `Number of results to return (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT})` }),
	),
	site: Type.Optional(
		Type.String({ description: "Restrict search to a specific site (e.g., 'stackoverflow.com', 'github.com')" }),
	),
});

export type WebsearchToolInput = Static<typeof websearchSchema>;

export interface WebsearchToolDetails {
	query: string;
	provider: string;
	resultCount: number;
}

/**
 * Format search results as readable text for the LLM.
 */
function formatResults(query: string, results: SearchResult[], provider: string): string {
	if (results.length === 0) {
		return `No results found for "${query}" (provider: ${provider})`;
	}

	const lines: string[] = [`## Search Results for "${query}"`, ""];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`${i + 1}. **${r.title}**`);
		lines.push(`   ${r.url}`);
		if (r.snippet) {
			lines.push(`   ${r.snippet}`);
		}
		lines.push("");
	}

	lines.push(`---`);
	lines.push(`${results.length} results via ${provider}`);

	return lines.join("\n");
}

/**
 * Resolve the search provider.
 * Default: DuckDuckGo (no API key required).
 */
function resolveProvider(): SearchProvider {
	return duckduckgoProvider;
}

export function createWebsearchTool(): AgentTool<typeof websearchSchema> {
	return {
		name: "websearch",
		label: "websearch",
		sideEffects: false,
		description: `Search the web and return results with titles, URLs, and snippets. No API key required. Use the 'site' parameter to restrict search to a specific domain (e.g., site="github.com"). Combine with webfetch to read full page content from search results.`,
		parameters: websearchSchema,
		execute: async (_toolCallId: string, { query, count, site }: WebsearchToolInput, signal?: AbortSignal) => {
			const effectiveCount = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);
			const provider = resolveProvider();

			// Create abort controller with timeout
			const timeoutController = new AbortController();
			const timeout = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);

			const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

			try {
				const results = await provider.search(query, { count: effectiveCount, site }, combinedSignal);

				const formattedText = formatResults(query, results, provider.name);

				return {
					content: [{ type: "text", text: formattedText }] as TextContent[],
					details: {
						query,
						provider: provider.name,
						resultCount: results.length,
					} as WebsearchToolDetails,
				};
			} catch (error: any) {
				if (error.name === "AbortError" || error.name === "TimeoutError") {
					const isTimeout = timeoutController.signal.aborted;
					const message = isTimeout
						? `Search timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for "${query}"`
						: `Search aborted for "${query}"`;
					return {
						content: [{ type: "text", text: message }] as TextContent[],
						details: { query, provider: provider.name, resultCount: 0 } as WebsearchToolDetails,
					};
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}

/** Default websearch tool */
export const websearchTool = createWebsearchTool();
