/**
 * MCP Gateway Extension — Constants
 *
 * Default values for timeouts, size limits, and naming conventions.
 */

// ─── Qualified Name ───────────────────────────────────────────────────────────

/**
 * Separator used to build qualified tool names: "serverName__toolName".
 * Double underscore is chosen because single underscores are common in MCP tool
 * names, while double underscores are not.
 */
export const QUALIFIED_NAME_SEPARATOR = "__";

// ─── Connection Timeouts (section 5.3) ───────────────────────────────────────

/** Default maximum time to wait for a server connection to be established, in ms (30 s) */
export const DEFAULT_CONNECTION_TIMEOUT = 30_000;

/** Default idle time before an unused connection is closed automatically, in ms (5 min) */
export const DEFAULT_IDLE_TIMEOUT = 300_000;

// ─── Call Timeout (section 9.5) ──────────────────────────────────────────────

/** Maximum time to wait for a single mcp_call to complete, in ms (60 s) */
export const DEFAULT_CALL_TIMEOUT = 60_000;

// ─── Result Size (section 18) ────────────────────────────────────────────────

/** Maximum result payload size before truncation, in bytes (50 KB) */
export const DEFAULT_MAX_RESULT_SIZE = 50 * 1024;

// ─── Catalog Search (section 7.5) ────────────────────────────────────────────

/** Default maximum number of results returned by a single mcp_search query */
export const DEFAULT_SEARCH_LIMIT = 5;
