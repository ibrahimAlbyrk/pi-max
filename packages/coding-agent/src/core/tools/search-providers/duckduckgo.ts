import { parseHTML } from "linkedom";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.js";

const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Strip HTML tags and decode entities from a string.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extract the actual URL from DuckDuckGo's redirect link.
 * DDG wraps URLs like: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
 */
function extractUrl(href: string): string | null {
	try {
		const match = href.match(/uddg=([^&]+)/);
		if (match) {
			return decodeURIComponent(match[1]);
		}
		// Direct URL (no redirect wrapper)
		if (href.startsWith("http")) {
			return href;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * DuckDuckGo search provider using HTML scraping.
 * No API key required — fetches html.duckduckgo.com and parses results.
 */
export const duckduckgoProvider: SearchProvider = {
	name: "duckduckgo",

	async search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]> {
		const count = options.count ?? 10;

		// Prepend site: filter if specified
		const effectiveQuery = options.site ? `site:${options.site} ${query}` : query;

		const params = new URLSearchParams({ q: effectiveQuery });

		const response = await fetch(`${DDG_URL}?${params.toString()}`, {
			method: "GET",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal,
		});

		if (!response.ok) {
			throw new Error(`DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`);
		}

		const html = await response.text();
		const { document } = parseHTML(html);

		const results: SearchResult[] = [];
		const resultElements = document.querySelectorAll(".result");

		for (const el of resultElements) {
			if (results.length >= count) break;

			// Extract title and URL from the result link
			const titleLink = el.querySelector(".result__a");
			if (!titleLink) continue;

			const title = stripHtml(titleLink.innerHTML);
			const href = titleLink.getAttribute("href") ?? "";
			const url = extractUrl(href);

			if (!url || !title) continue;

			// Extract snippet
			const snippetEl = el.querySelector(".result__snippet");
			const snippet = snippetEl ? stripHtml(snippetEl.innerHTML) : "";

			results.push({ title, url, snippet });
		}

		return results;
	},
};
