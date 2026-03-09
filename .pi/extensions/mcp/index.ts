/**
 * MCP Gateway Extension — Entry Point
 *
 * Registers mcp_search and mcp_call with pi, wires session lifecycle handlers,
 * and drives the background tool-catalog refresh on session start.
 *
 * Architecture note — pool/config timing:
 *   The extension factory runs synchronously. Pool and config are not available
 *   until session_start fires. Tools are registered in the factory (as pi
 *   requires) using closure variables that are filled in on session_start.
 *   mcp_search receives the catalog instance directly because ToolCatalog needs
 *   no arguments and can be created eagerly. mcp_call uses a wrapper execute
 *   that delegates to a freshly wired call-tool once the session is ready.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { ToolCatalog } from "./catalog.js";
import { McpClientPool } from "./pool.js";
import { loadConfig, saveConfig } from "./config.js";
import { createSearchTool } from "./tools/search.js";
import { createCallTool } from "./tools/call.js";
import { createMcpCommand } from "./commands/mcp.js";
import { buildMcpSystemPrompt } from "./prompt.js";
import { QUALIFIED_NAME_SEPARATOR } from "./constants.js";
import type { CatalogEntry, McpConfig, ParameterInfo } from "./types.js";

export default function (pi: ExtensionAPI) {
	// ── Shared session state ───────────────────────────────────────────────────

	// catalog is created eagerly; it starts empty and is populated after session_start.
	const catalog = new ToolCatalog();

	// pool and config are null until session_start assigns them.
	let pool: McpClientPool | null = null;
	let config: McpConfig | null = null;

	// Cached call-tool wired to the live pool + config; rebuilt on each session_start.
	let cachedCallTool: ReturnType<typeof createCallTool> | null = null;

	// In-flight background refresh promise.
	// - Non-null while performCatalogRefresh() is running.
	// - Used to coalesce concurrent refresh requests.
	// - mcp_search waits on this if the catalog is still empty.
	let refreshPromise: Promise<void> | null = null;

	// Set to true in session_shutdown so in-flight background work can abort early.
	let isShuttingDown = false;

	// Notification function captured from ctx.ui in session_start.
	// Allows background async code to surface messages to the user.
	let notify: ((msg: string, type: "info" | "warning" | "error") => void) | null = null;

	// ── Catalog helpers ────────────────────────────────────────────────────────

	/** Convert raw MCP Tool descriptors into lightweight CatalogEntry objects. */
	function buildCatalogEntries(serverName: string, tools: Tool[]): CatalogEntry[] {
		return tools.map((tool): CatalogEntry => {
			const properties = tool.inputSchema?.properties as
				| Record<string, Record<string, unknown>>
				| undefined;
			const requiredSet = new Set(
				Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [],
			);
			const parameterSummary = properties ? Object.keys(properties) : [];
			const parameters: ParameterInfo[] = properties
				? Object.entries(properties).map(([name, schema]) => ({
						name,
						type: typeof schema?.type === "string" ? schema.type : "unknown",
						description: typeof schema?.description === "string" ? schema.description : "",
						required: requiredSet.has(name),
					}))
				: [];
			return {
				serverName,
				toolName: tool.name,
				qualifiedName: `${serverName}${QUALIFIED_NAME_SEPARATOR}${tool.name}`,
				description: tool.description ?? "",
				parameterSummary,
				parameters,
			};
		});
	}

	/**
	 * Connect to every enabled server, fetch their tool lists, populate the
	 * in-memory catalog, then immediately disconnect (metadata-only fetch).
	 *
	 * Errors for individual servers are reported as warnings; the remaining
	 * servers' entries are still collected. Disk-save and user notification
	 * happen after all servers are processed.
	 */
	async function performCatalogRefresh(): Promise<void> {
		const currentPool = pool;
		const currentConfig = config;
		if (!currentPool || !currentConfig) return;

		const activeServerNames = Object.keys(currentConfig.servers).filter(
			(name) => currentConfig.servers[name].disabled !== true,
		);

		if (activeServerNames.length === 0) return;

		let successCount = 0;
		let totalToolCount = 0;

		await Promise.allSettled(
			activeServerNames.map(async (serverName) => {
				if (isShuttingDown) return;
				try {
					const tools = await currentPool.listTools(serverName);
					const entries = buildCatalogEntries(serverName, tools);
					catalog.setEntries(serverName, entries);
					successCount++;
					totalToolCount += entries.length;

					// Disconnect after catalog fetch — unless lazyConnect is false,
					// meaning the user wants a persistent connection.
					if (currentConfig.servers[serverName].lazyConnect !== false) {
						await currentPool.disconnect(serverName);
					}
				} catch (err) {
					notify?.(
						`MCP: Failed to connect to '${serverName}': ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			}),
		);

		if (isShuttingDown) return;

		// Persist the updated catalog so subsequent sessions can use it immediately.
		await catalog.saveToDisk();

		if (successCount > 0) {
			notify?.(
				`MCP: catalog refreshed (${totalToolCount} tools from ${successCount} servers)`,
				"info",
			);
		}
	}

	/**
	 * Start a catalog refresh, or return the already in-flight promise so that
	 * concurrent callers share a single underlying operation.
	 *
	 * Passed to createSearchTool as the `onRefresh` callback.
	 */
	async function doRefresh(): Promise<void> {
		if (refreshPromise !== null) {
			// A refresh is already running — wait for it instead of starting another.
			return refreshPromise;
		}
		refreshPromise = performCatalogRefresh().finally(() => {
			refreshPromise = null;
		});
		return refreshPromise;
	}

	// ── Tool registrations ─────────────────────────────────────────────────────
	// Both tools are registered synchronously in the factory. They delegate to
	// pool/catalog only when execute() is actually invoked — well after session_start
	// has populated the closure variables.

	// mcp_search — catalog is created eagerly, so we can pass it directly now.
	// We wrap execute to wait for the startup background refresh if the catalog
	// is still empty when the first search arrives (spec section 8.3).
	const baseSearchTool = createSearchTool(catalog, doRefresh);
	pi.registerTool({
		name: baseSearchTool.name,
		label: baseSearchTool.label,
		description: baseSearchTool.description,
		parameters: baseSearchTool.parameters,
		sideEffects: baseSearchTool.sideEffects,
		renderCall: baseSearchTool.renderCall,
		renderResult: baseSearchTool.renderResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// If the catalog is still empty and a startup refresh is in flight, wait.
			if (catalog.isEmpty() && refreshPromise !== null) {
				try {
					await refreshPromise;
				} catch {
					// Ignore; the catalog may still have entries from disk or partial refresh.
				}
			}
			return baseSearchTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// mcp_call — pool and config are not available until session_start.
	// Use an empty placeholder to extract the tool's shape (name/label/description/
	// parameters/sideEffects), then override execute to delegate to the live
	// cachedCallTool once the session is ready.
	const emptyConfig: McpConfig = { servers: {}, defaults: {} };
	const callToolShape = createCallTool(new McpClientPool(emptyConfig), emptyConfig);
	pi.registerTool({
		name: callToolShape.name,
		label: callToolShape.label,
		description: callToolShape.description,
		parameters: callToolShape.parameters,
		sideEffects: callToolShape.sideEffects,
		renderCall: callToolShape.renderCall,
		renderResult: callToolShape.renderResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!cachedCallTool) {
				// This can only happen if execute is called before session_start fires,
				// which should not occur in normal pi operation.
				throw new Error("No MCP servers configured.");
			}
			return cachedCallTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// ── /mcp command ───────────────────────────────────────────────────────────

	const mcpCommand = createMcpCommand({
		getConfig: () => config,
		getPool: () => pool,
		getCatalog: () => catalog,
		async saveAndReload(ctx: ExtensionCommandContext, newConfig: McpConfig, scope: "local" | "global") {
			saveConfig(ctx.cwd, newConfig, scope);
			await ctx.reload();
		},
		async reconnectServer(serverName: string) {
			if (!pool) throw new Error("No active connection pool");
			await pool.disconnect(serverName);
			await pool.getClient(serverName);
		},
	});
	pi.registerCommand("mcp", mcpCommand);

	// ── Event handlers ─────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		isShuttingDown = false;

		// Capture the notification function so background operations can surface messages.
		notify = (msg, type) => ctx.ui.notify(msg, type);

		// 1. Load and merge project-local and global mcp.json configuration files.
		const { config: loadedConfig, warnings } = loadConfig(ctx.cwd);
		config = loadedConfig;

		// 2. Surface any configuration warnings to the user immediately.
		for (const warning of warnings) {
			ctx.ui.notify(`MCP: ${warning}`, "warning");
		}

		// 3. Create the connection pool wired to this session's server configuration.
		pool = new McpClientPool(config);

		// 4. Build the call tool wrapper that references the live pool and config.
		cachedCallTool = createCallTool(pool, config);

		// 5. Auto-refresh catalog entries when a connected server reports tool changes.
		//    The pool calls these callbacks when it receives notifications/tools/list_changed.
		pool.onToolsChanged(async (serverName) => {
			if (!pool || isShuttingDown) return;
			try {
				const tools = await pool.listTools(serverName);
				const entries = buildCatalogEntries(serverName, tools);
				catalog.setEntries(serverName, entries);
				await catalog.saveToDisk();
			} catch (err) {
				notify?.(
					`MCP: Failed to refresh tools for '${serverName}': ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		});

		// 6. Load the persisted disk cache — stale data is still useful while the
		//    background refresh runs. Errors are silently ignored by ToolCatalog.
		await catalog.loadFromDisk();

		// 7. Kick off background catalog refresh — not awaited so session_start returns
		//    quickly. mcp_search will wait on refreshPromise if the catalog is still empty.
		void doRefresh();
	});

	pi.on("before_agent_start", async (event) => {
		if (!config) return;

		const mcpPromptText = buildMcpSystemPrompt(config);
		if (!mcpPromptText) return;

		// Chain on top of whatever system prompt was already set by pi or other extensions.
		return { systemPrompt: event.systemPrompt + "\n\n" + mcpPromptText };
	});

	pi.on("session_shutdown", async () => {
		isShuttingDown = true;

		// Close all active MCP server connections (stdio: kill processes, HTTP: terminate sessions).
		if (pool) {
			try {
				await pool.disconnectAll();
			} catch {
				// Ignore errors during shutdown — processes may have already exited.
			}
			pool = null;
		}

		// Persist any catalog updates accumulated during this session.
		// Errors are silently ignored; disk persistence is best-effort.
		try {
			await catalog.saveToDisk();
		} catch {
			// intentionally silent
		}

		// Clear session-scoped state.
		cachedCallTool = null;
		config = null;
		notify = null;
	});
}
