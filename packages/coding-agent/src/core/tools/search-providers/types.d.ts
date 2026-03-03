/**
 * Search provider interface for pluggable search backends.
 */
export interface SearchProvider {
	/** Provider name (e.g., "duckduckgo", "brave") */
	readonly name: string;
	/**
	 * Perform a web search.
	 * @param query - Search query string
	 * @param options - Search options
	 * @param signal - Abort signal for cancellation
	 * @returns Array of search results
	 */
	search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]>;
}
export interface SearchOptions {
	/** Number of results to return (default: 10) */
	count?: number;
	/** Restrict search to a specific site (e.g., "stackoverflow.com") */
	site?: string;
}
export interface SearchResult {
	/** Result title */
	title: string;
	/** Result URL */
	url: string;
	/** Short description/snippet */
	snippet: string;
}
//# sourceMappingURL=types.d.ts.map
