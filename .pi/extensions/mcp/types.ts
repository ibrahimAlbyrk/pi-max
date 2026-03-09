/**
 * MCP Gateway Extension — Type Definitions
 *
 * All internal types used across the extension.
 * This is the foundation module — no internal dependencies.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ─── Transport Configuration ──────────────────────────────────────────────────

/** stdio transport — spawns a local process */
export interface StdioTransportConfig {
	transport: "stdio";
	/** Executable to run (e.g. "npx", "node", "python") */
	command: string;
	/** Arguments to pass to the executable */
	args: string[];
}

/** HTTP transport — connects to a remote MCP server */
export interface HttpTransportConfig {
	transport: "http";
	/** HTTP endpoint URL (e.g. "https://mcp.sentry.io/sse") */
	url: string;
	/** HTTP headers to include in every request */
	headers?: Record<string, string>;
}

/** Discriminated union of supported transport types */
export type TransportConfig = StdioTransportConfig | HttpTransportConfig;

// ─── Server Configuration ─────────────────────────────────────────────────────

/** A single MCP server definition (merged from config files before transport split) */
export type McpServerConfig = TransportConfig & {
	/** Unique identifier for this server (used as key in config, prefix in qualified names) */
	name: string;
	/** Environment variables to pass to the server process or HTTP requests */
	env?: Record<string, string>;
	/** If true, this server is ignored entirely */
	disabled?: boolean;
	/** Connection timeout in ms. Overrides the global default. */
	connectionTimeout?: number;
	/** Idle disconnect timeout in ms. Overrides the global default. */
	idleTimeout?: number;
};

// ─── Global Defaults ──────────────────────────────────────────────────────────

/** Default values that apply to all servers unless overridden per-server */
export interface McpDefaults {
	/** Connection timeout in ms. Default: 30 000 */
	connectionTimeout?: number;
	/** Idle disconnect timeout in ms. Default: 300 000 */
	idleTimeout?: number;
	/** Maximum result payload size in bytes. Default: 51 200 (50 KB) */
	maxResultSize?: number;
}

// ─── Full Config ──────────────────────────────────────────────────────────────

/** Parsed and merged mcp.json configuration (project-local overrides global) */
export interface McpConfig {
	/** Active server definitions, keyed by server name */
	servers: Record<string, McpServerConfig>;
	/** Global defaults for all servers */
	defaults: McpDefaults;
}

// ─── Connection Pool ──────────────────────────────────────────────────────────

/** Lifecycle state of a single MCP server connection */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** One entry in the client pool — tracks a single server's runtime state */
export interface PoolEntry {
	/** Name of the MCP server this entry belongs to */
	serverName: string;
	/** Current connection state */
	state: ConnectionState;
	/** Live MCP client instance when state is "connected", otherwise null */
	client: Client | null;
	/** Error message from last failed connection attempt */
	errorMessage: string | null;
	/** Node.js timer handle for the idle-disconnect timeout, or null if not running */
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Timestamp (Date.now()) of the last successful tool call on this connection */
	lastUsedAt: number | null;
}

// ─── Tool Catalog ─────────────────────────────────────────────────────────────

/** Lightweight metadata for a single tool, stored in the in-memory catalog */
export interface CatalogEntry {
	/** Name of the MCP server that owns this tool */
	serverName: string;
	/** Tool name as reported by the MCP server (e.g. "search_repositories") */
	toolName: string;
	/** Unique qualified name used in mcp_call: "serverName__toolName" */
	qualifiedName: string;
	/** Tool description as returned by the MCP server */
	description: string;
	/** List of parameter names (names only — no type or schema information) */
	parameterSummary: string[];
}

/** Per-server metadata stored alongside the catalog entries on disk */
export interface CatalogServerMeta {
	/** ISO timestamp of the last successful refresh for this server */
	lastRefreshedAt: string;
}

/** Full catalog data — both the in-memory working set and the disk-cache format */
export interface CatalogData {
	/** All catalog entries, grouped by server name */
	entries: Record<string, CatalogEntry[]>;
	/** Per-server refresh metadata */
	serverMeta: Record<string, CatalogServerMeta>;
}
