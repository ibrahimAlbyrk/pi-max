import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Readability } from "@mozilla/readability";
import { type Static, Type } from "@sinclair/typebox";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; PiCLI/1.0; +https://github.com/badlogic/pi-mono)";

const webfetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch (must start with http:// or https://)" }),
	selector: Type.Optional(
		Type.String({ description: "CSS selector to extract a specific section (e.g., 'article', '#content', '.main')" }),
	),
	raw: Type.Optional(
		Type.Boolean({ description: "If true, return raw HTML instead of converting to markdown. Default: false" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return (default: 2000)" })),
});

export type WebfetchToolInput = Static<typeof webfetchSchema>;

export interface WebfetchToolDetails {
	url: string;
	statusCode: number;
	contentType?: string;
	title?: string;
	truncation?: TruncationResult;
}

/**
 * Create a turndown service configured for clean markdown output.
 */
function createTurndownService(): TurndownService {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});

	// Remove script, style, nav, footer, aside elements
	turndown.addRule("removeNoise", {
		filter: ["script", "style", "nav", "footer", "aside", "noscript", "iframe", "svg"],
		replacement: () => "",
	});

	return turndown;
}

/** Minimum character threshold for Readability output to be considered useful.
 * Set high enough to catch cases where Readability only extracts nav/boilerplate
 * but misses the actual article content (common with JS-rendered pages). */
const READABILITY_MIN_LENGTH = 1000;

/**
 * Try to extract content from Next.js __NEXT_DATA__ script tag.
 * Many modern sites (Next.js SSR/SSG) store the actual page content as JSON
 * in a script tag, while the visible HTML is rendered client-side.
 */
function tryExtractNextData(document: any): { content: string; title?: string } | null {
	const scriptEl = document.querySelector("#__NEXT_DATA__");
	if (!scriptEl) return null;

	try {
		const data = JSON.parse(scriptEl.textContent);
		const pageProps = data?.props?.pageProps;
		if (!pageProps) return null;

		// Common patterns for content in Next.js data
		const content =
			pageProps.postData?.content ??
			pageProps.post?.content ??
			pageProps.article?.content ??
			pageProps.content ??
			pageProps.markdownContent ??
			pageProps.body ??
			pageProps.postData?.body ??
			pageProps.post?.body;

		if (!content || typeof content !== "string" || content.length < READABILITY_MIN_LENGTH) return null;

		const title = pageProps.postData?.title ?? pageProps.post?.title ?? pageProps.article?.title ?? pageProps.title;

		return { content, title: typeof title === "string" ? title : undefined };
	} catch {
		return null;
	}
}

/**
 * Try to extract content from JSON-LD structured data.
 * Many sites embed article content in application/ld+json script tags.
 */
function tryExtractJsonLd(document: any): { content: string; title?: string } | null {
	const scripts = document.querySelectorAll('script[type="application/ld+json"]');
	for (const script of scripts) {
		try {
			const data = JSON.parse(script.textContent);
			const items = Array.isArray(data) ? data : [data];
			for (const item of items) {
				if (
					item.articleBody &&
					typeof item.articleBody === "string" &&
					item.articleBody.length >= READABILITY_MIN_LENGTH
				) {
					return { content: item.articleBody, title: item.headline ?? item.name };
				}
			}
		} catch {
			// Ignore malformed JSON-LD
		}
	}
	return null;
}

/**
 * Validate and normalize URL.
 */
function validateUrl(url: string): string {
	// Add protocol if missing
	if (!url.startsWith("http://") && !url.startsWith("https://")) {
		url = `https://${url}`;
	}

	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`Unsupported protocol: ${parsed.protocol}`);
		}
		return parsed.href;
	} catch (e: any) {
		throw new Error(`Invalid URL: ${url} — ${e.message}`);
	}
}

export function createWebfetchTool(): AgentTool<typeof webfetchSchema> {
	return {
		name: "webfetch",
		label: "webfetch",
		sideEffects: false,
		description: `Fetch a web page and return its content as clean markdown. Strips navigation, ads, and boilerplate. Supports CSS selectors to extract specific sections. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: webfetchSchema,
		execute: async (_toolCallId: string, { url, selector, raw, limit }: WebfetchToolInput, signal?: AbortSignal) => {
			const validatedUrl = validateUrl(url);

			// Create abort controller with timeout
			const timeoutController = new AbortController();
			const timeout = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);

			// Combine user signal with timeout
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

			try {
				const response = await fetch(validatedUrl, {
					headers: {
						"User-Agent": DEFAULT_USER_AGENT,
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
						"Accept-Language": "en-US,en;q=0.5",
					},
					signal: combinedSignal,
					redirect: "follow",
				});

				if (!response.ok) {
					return {
						content: [
							{ type: "text", text: `HTTP ${response.status} ${response.statusText} for ${validatedUrl}` },
						],
						details: { url: validatedUrl, statusCode: response.status } as WebfetchToolDetails,
					};
				}

				const contentType = response.headers.get("content-type") ?? "";
				const html = await response.text();

				// If content is not HTML, return as-is (e.g., JSON, plain text)
				if (!contentType.includes("html") && !contentType.includes("xml")) {
					const truncation = truncateHead(html, { maxLines: limit ?? DEFAULT_MAX_LINES });
					let outputText = truncation.content;
					if (truncation.truncated) {
						outputText += `\n\n[Content truncated at ${formatSize(truncation.outputBytes)}. Use limit=${(limit ?? DEFAULT_MAX_LINES) * 2} for more.]`;
					}
					return {
						content: [{ type: "text", text: outputText }],
						details: {
							url: validatedUrl,
							statusCode: response.status,
							contentType,
							truncation: truncation.truncated ? truncation : undefined,
						} as WebfetchToolDetails,
					};
				}

				// Parse HTML with linkedom
				const { document } = parseHTML(html);

				let title: string | undefined;
				let outputText: string;

				if (raw) {
					// Return raw HTML
					title = document.querySelector("title")?.textContent ?? undefined;

					if (selector) {
						const selected = document.querySelector(selector);
						if (!selected) {
							return {
								content: [{ type: "text", text: `No element found matching selector: ${selector}` }],
								details: {
									url: validatedUrl,
									statusCode: response.status,
									contentType,
									title,
								} as WebfetchToolDetails,
							};
						}
						outputText = selected.innerHTML;
					} else {
						outputText = html;
					}
				} else {
					// Use Readability to extract article content, then convert to markdown
					let htmlToConvert: string | null = null;
					let directMarkdown: string | null = null;

					if (selector) {
						const selected = document.querySelector(selector);
						if (!selected) {
							return {
								content: [{ type: "text", text: `No element found matching selector: ${selector}` }],
								details: { url: validatedUrl, statusCode: response.status, contentType } as WebfetchToolDetails,
							};
						}
						htmlToConvert = selected.innerHTML;
						title = document.querySelector("title")?.textContent ?? undefined;
					} else {
						// Try Readability first
						const { document: readabilityDoc } = parseHTML(html);
						const reader = new Readability(readabilityDoc as any);
						const article = reader.parse();

						const readabilityUseful =
							article?.textContent && article.textContent.length >= READABILITY_MIN_LENGTH;

						if (readabilityUseful && article?.content) {
							htmlToConvert = article.content;
							title = article.title ?? undefined;
						} else {
							// Readability failed or returned too little content.
							// Try structured data fallbacks (Next.js __NEXT_DATA__, JSON-LD)
							const nextData = tryExtractNextData(document);
							if (nextData) {
								directMarkdown = nextData.content;
								title = nextData.title;
							} else {
								const jsonLd = tryExtractJsonLd(document);
								if (jsonLd) {
									directMarkdown = jsonLd.content;
									title = jsonLd.title;
								} else {
									// Last resort: use body HTML
									htmlToConvert = document.body?.innerHTML ?? html;
									title = document.querySelector("title")?.textContent ?? undefined;
								}
							}
						}
					}

					if (directMarkdown) {
						// Content already in markdown/text form (from __NEXT_DATA__ or JSON-LD)
						outputText = directMarkdown;
					} else {
						// Convert HTML to markdown
						const turndown = createTurndownService();
						outputText = turndown.turndown(htmlToConvert ?? "");
					}

					// Add title header if available
					if (title) {
						outputText = `# ${title}\n\n${outputText}`;
					}
				}

				// Apply truncation
				const truncation = truncateHead(outputText, { maxLines: limit ?? DEFAULT_MAX_LINES });
				let finalText = truncation.content;

				if (truncation.truncated) {
					finalText += `\n\n[Content truncated at ${formatSize(truncation.outputBytes)}. Use selector to target specific content, or limit=${(limit ?? DEFAULT_MAX_LINES) * 2} for more.]`;
				}

				// Add source URL as footer
				finalText += `\n\n---\nSource: ${validatedUrl}`;

				return {
					content: [{ type: "text", text: finalText }] as TextContent[],
					details: {
						url: validatedUrl,
						statusCode: response.status,
						contentType,
						title,
						truncation: truncation.truncated ? truncation : undefined,
					} as WebfetchToolDetails,
				};
			} catch (error: any) {
				if (error.name === "AbortError" || error.name === "TimeoutError") {
					const isTimeout = timeoutController.signal.aborted;
					const message = isTimeout
						? `Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for ${validatedUrl}`
						: `Request aborted for ${validatedUrl}`;
					return {
						content: [{ type: "text", text: message }],
						details: { url: validatedUrl, statusCode: 0 } as WebfetchToolDetails,
					};
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}

/** Default webfetch tool */
export const webfetchTool = createWebfetchTool();
