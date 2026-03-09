/**
 * MCP Gateway Extension — Tool Catalog
 *
 * In-memory storage of lightweight tool metadata gathered from MCP servers.
 * Provides fuzzy search across qualifiedName, description, and parameterSummary.
 * Persists to and loads from a disk cache at ~/.pi/agent/cache/mcp-catalog.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { DEFAULT_SEARCH_LIMIT } from "./constants.js";
import type { CatalogData, CatalogEntry, CatalogServerMeta } from "./types.js";

// ─── Scoring Constants ────────────────────────────────────────────────────────

/** Score assigned when the query exactly matches the tool name */
const SCORE_NAME_EXACT = 100;
/** Score assigned when the tool name contains the query as a substring */
const SCORE_NAME_SUBSTR = 75;
/** Score assigned when the description contains the query as a substring */
const SCORE_DESC_SUBSTR = 50;
/** Score assigned when any parameter name contains the query as a substring */
const SCORE_PARAM_SUBSTR = 25;

// ─── Disk Cache Path ──────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), ".pi", "agent", "cache", "mcp-catalog.json");

// ─── ToolCatalog ──────────────────────────────────────────────────────────────

/**
 * In-memory tool catalog with fuzzy search and disk persistence.
 *
 * Entries are grouped by server name. All mutations replace the entire set of
 * entries for a given server so the in-memory state always stays consistent.
 */
export class ToolCatalog {
	/** entries[serverName] = array of CatalogEntry for that server */
	private readonly entries: Map<string, CatalogEntry[]> = new Map();

	/** Per-server refresh metadata (last successful refresh timestamp) */
	private readonly serverMeta: Map<string, CatalogServerMeta> = new Map();

	// ─── Mutation ─────────────────────────────────────────────────────────────

	/**
	 * Replace all entries for `serverName` with the supplied list.
	 * Also records the current time as `lastRefreshedAt` for this server.
	 */
	setEntries(serverName: string, entries: CatalogEntry[]): void {
		this.entries.set(serverName, entries);
		this.serverMeta.set(serverName, {
			lastRefreshedAt: new Date().toISOString(),
		});
	}

	/**
	 * Remove all entries and metadata for `serverName`.
	 * No-op if the server is not present.
	 */
	removeServer(serverName: string): void {
		this.entries.delete(serverName);
		this.serverMeta.delete(serverName);
	}

	// ─── Query ────────────────────────────────────────────────────────────────

	/** Returns true when no servers have entries in the catalog. */
	isEmpty(): boolean {
		for (const list of this.entries.values()) {
			if (list.length > 0) return false;
		}
		return true;
	}

	/** Returns the names of all servers that have at least one catalog entry. */
	getServerNames(): string[] {
		const names: string[] = [];
		for (const [serverName, list] of this.entries) {
			if (list.length > 0) names.push(serverName);
		}
		return names;
	}

	/**
	 * Fuzzy search across the catalog.
	 *
	 * Matches are case-insensitive substring checks across:
	 *   1. qualifiedName  (tool name portion only for exact/substr, full string for substr)
	 *   2. description
	 *   3. parameterSummary (individual parameter names)
	 *
	 * Results are sorted descending by score and capped at `limit`.
	 *
	 * @param query  - The search term (natural language or keyword).
	 * @param options.server - When provided, restrict results to this server name.
	 * @param options.limit  - Maximum number of results. Defaults to DEFAULT_SEARCH_LIMIT.
	 */
	search(
		query: string,
		options?: { server?: string; limit?: number }
	): CatalogEntry[] {
		const lower = query.toLowerCase();
		const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
		const serverFilter = options?.server;

		const scored: Array<{ entry: CatalogEntry; score: number }> = [];

		for (const [serverName, list] of this.entries) {
			if (serverFilter !== undefined && serverName !== serverFilter) continue;

			for (const entry of list) {
				const score = scoreEntry(entry, lower);
				if (score > 0) {
					scored.push({ entry, score });
				}
			}
		}

		// Sort descending by score, then alphabetically by qualifiedName for stability
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.entry.qualifiedName.localeCompare(b.entry.qualifiedName);
		});

		return scored.slice(0, limit).map((s) => s.entry);
	}

	// ─── Disk Persistence ─────────────────────────────────────────────────────

	/**
	 * Load catalog entries from the disk cache into memory.
	 *
	 * Existing in-memory entries are merged: entries from disk are loaded per
	 * server, but already-present servers (loaded from a live refresh) are kept.
	 *
	 * Silently ignores all errors (missing file, malformed JSON, permission issues).
	 */
	async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(CACHE_PATH, "utf-8");
			const data = JSON.parse(raw) as CatalogData;

			if (
				!data ||
				typeof data !== "object" ||
				typeof data.entries !== "object" ||
				typeof data.serverMeta !== "object"
			) {
				return;
			}

			for (const [serverName, list] of Object.entries(data.entries)) {
				// Do not overwrite entries that were already set by a live refresh
				if (this.entries.has(serverName)) continue;
				if (!Array.isArray(list)) continue;

				const valid = list.filter(isCatalogEntry);
				this.entries.set(serverName, valid);
			}

			for (const [serverName, meta] of Object.entries(data.serverMeta)) {
				if (this.serverMeta.has(serverName)) continue;
				if (isServerMeta(meta)) {
					this.serverMeta.set(serverName, meta);
				}
			}
		} catch {
			// Silently ignore: missing file, JSON parse error, permission denied, etc.
		}
	}

	/**
	 * Persist the current in-memory catalog to the disk cache.
	 *
	 * Creates the cache directory if it does not exist.
	 * Silently ignores all errors.
	 */
	async saveToDisk(): Promise<void> {
		try {
			const data: CatalogData = {
				entries: Object.fromEntries(this.entries),
				serverMeta: Object.fromEntries(this.serverMeta),
			};

			const json = JSON.stringify(data, null, 2);

			await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
			await fs.writeFile(CACHE_PATH, json, "utf-8");
		} catch {
			// Silently ignore: read-only filesystem, permission denied, etc.
		}
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a relevance score for a single catalog entry against a lower-cased query.
 * Returns 0 when there is no match at all.
 */
function scoreEntry(entry: CatalogEntry, lowerQuery: string): number {
	// Extract just the tool name portion from the qualified name for name matching.
	// qualifiedName format: "serverName__toolName" (first __ is the separator)
	const separatorIdx = entry.qualifiedName.indexOf("__");
	const toolNamePart =
		separatorIdx !== -1
			? entry.qualifiedName.slice(separatorIdx + 2).toLowerCase()
			: entry.qualifiedName.toLowerCase();

	let score = 0;

	// Tool name exact match
	if (toolNamePart === lowerQuery) {
		score = Math.max(score, SCORE_NAME_EXACT);
	}
	// Tool name substring match (but not exact — already scored above)
	else if (toolNamePart.includes(lowerQuery)) {
		score = Math.max(score, SCORE_NAME_SUBSTR);
	}
	// Also check the full qualified name for substring (covers "serverName" portion)
	else if (entry.qualifiedName.toLowerCase().includes(lowerQuery)) {
		score = Math.max(score, SCORE_NAME_SUBSTR);
	}

	// Description substring match
	if (entry.description.toLowerCase().includes(lowerQuery)) {
		score = Math.max(score, SCORE_DESC_SUBSTR);
	}

	// Parameter name substring match
	for (const param of entry.parameterSummary) {
		if (param.toLowerCase().includes(lowerQuery)) {
			score = Math.max(score, SCORE_PARAM_SUBSTR);
			break; // One match is enough to assign the score
		}
	}

	return score;
}

/** Runtime type-guard for `CatalogEntry`. */
function isCatalogEntry(value: unknown): value is CatalogEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const hasBase =
		typeof v["serverName"] === "string" &&
		typeof v["toolName"] === "string" &&
		typeof v["qualifiedName"] === "string" &&
		typeof v["description"] === "string" &&
		Array.isArray(v["parameterSummary"]) &&
		(v["parameterSummary"] as unknown[]).every((p) => typeof p === "string");
	if (!hasBase) return false;
	// Backfill parameters for old disk-cache entries that lack it
	if (!Array.isArray(v["parameters"])) {
		(v as Record<string, unknown>)["parameters"] = [];
	}
	return true;
}

/** Runtime type-guard for `CatalogServerMeta`. */
function isServerMeta(value: unknown): value is CatalogServerMeta {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v["lastRefreshedAt"] === "string";
}
