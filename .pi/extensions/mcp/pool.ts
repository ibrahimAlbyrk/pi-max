/**
 * MCP Gateway Extension — Client Pool
 *
 * Manages one MCP Client instance per configured server.
 * Connections are established lazily (on first tool use), automatically
 * closed after an idle period, and fully cleaned up on shutdown.
 *
 * Supported transports:
 *   - stdio: spawns a child process and communicates over stdin/stdout.
 *   - http:  tries StreamableHTTP first; falls back to SSE for legacy servers.
 *
 * Reconnect policy: no automatic reconnect. After an unexpected disconnect the
 * entry moves to "error" state. The next tool call triggers a fresh connect.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { McpConfig, McpServerConfig, PoolEntry, ConnectionState } from "./types.js";
import { DEFAULT_CONNECTION_TIMEOUT, DEFAULT_IDLE_TIMEOUT, DEFAULT_CALL_TIMEOUT } from "./constants.js";

// ─── McpClientPool ────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of MCP client connections.
 *
 * Usage:
 *   const pool = new McpClientPool(mergedConfig);
 *   const result = await pool.callTool("github", "search_repositories", { query: "mcp" });
 *   await pool.disconnectAll(); // on shutdown
 */
export class McpClientPool {
	private readonly config: McpConfig;

	/** Live state entries for every server that has ever been touched */
	private readonly entries = new Map<string, PoolEntry>();

	/**
	 * In-flight connection promises — ensures concurrent getClient() calls for
	 * the same server share a single underlying connect operation.
	 */
	private readonly pendingConnections = new Map<string, Promise<Client>>();

	/** Registered callbacks for tools/list_changed notifications from any server */
	private readonly toolsChangedCallbacks: Array<(serverName: string) => void> = [];

	constructor(config: McpConfig) {
		this.config = config;
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	/**
	 * Returns a connected MCP Client for `serverName`.
	 *
	 * If the server is currently disconnected or in an error state, a new
	 * connection is established before returning. Concurrent callers for the
	 * same server share one connection attempt.
	 *
	 * @throws If the server is not in the configuration or connection fails.
	 */
	async getClient(serverName: string): Promise<Client> {
		const entry = this.getOrCreateEntry(serverName);

		// Fast path: already connected.
		if (entry.state === "connected" && entry.client !== null) {
			return entry.client;
		}

		// Coalesce concurrent getClient() calls into a single connection attempt.
		const existing = this.pendingConnections.get(serverName);
		if (existing !== undefined) {
			return existing;
		}

		const promise = this.connectEntry(serverName, entry).finally(() => {
			this.pendingConnections.delete(serverName);
		});

		this.pendingConnections.set(serverName, promise);
		return promise;
	}

	/**
	 * Invoke a tool on `serverName`, lazy-connecting if needed.
	 *
	 * Resets the idle-disconnect timer on every successful call.
	 * Throws on connection failure, timeout, or protocol error.
	 */
	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const client = await this.getClient(serverName);
		const entry = this.getOrCreateEntry(serverName);

		const abortController = new AbortController();
		const timeoutHandle = setTimeout(() => {
			abortController.abort(new Error(`MCP tool call timed out after ${DEFAULT_CALL_TIMEOUT}ms`));
		}, DEFAULT_CALL_TIMEOUT);

		try {
			const raw = await client.callTool({ name: toolName, arguments: args }, undefined, {
				signal: abortController.signal,
			});

			// Reset idle timer after every successful call.
			entry.lastUsedAt = Date.now();
			this.resetIdleTimer(serverName, entry);

			// The SDK may return CallToolResult or CompatibilityCallToolResult.
			// Modern MCP servers always return the former; cast accordingly.
			return raw as CallToolResult;
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	/**
	 * List tools available on `serverName`, lazy-connecting if needed.
	 */
	async listTools(serverName: string): Promise<Tool[]> {
		const client = await this.getClient(serverName);
		const response = await client.listTools();
		return response.tools;
	}

	/**
	 * Current connection state of `serverName`.
	 * Returns `"disconnected"` for servers that have never been touched.
	 */
	getStatus(serverName: string): ConnectionState {
		return this.entries.get(serverName)?.state ?? "disconnected";
	}

	/**
	 * Snapshot of every server's connection state that has been touched during
	 * this pool's lifetime.
	 */
	getAllStatuses(): Map<string, ConnectionState> {
		const out = new Map<string, ConnectionState>();
		for (const [name, entry] of this.entries) {
			out.set(name, entry.state);
		}
		return out;
	}

	/**
	 * Gracefully close the connection to `serverName` and return its state to
	 * `"disconnected"`. No-op if the server is not known to the pool.
	 */
	async disconnect(serverName: string): Promise<void> {
		const entry = this.entries.get(serverName);
		if (entry === undefined) return;

		this.clearIdleTimer(entry);

		if (entry.client !== null) {
			try {
				await entry.client.close();
			} catch {
				// Ignore close errors — we're tearing down regardless.
			}
		}

		entry.state = "disconnected";
		entry.client = null;
		entry.errorMessage = null;
	}

	/**
	 * Close every active connection, cancel all idle timers, and wait for all
	 * disconnect operations to settle.
	 */
	async disconnectAll(): Promise<void> {
		const names = Array.from(this.entries.keys());
		await Promise.allSettled(names.map((name) => this.disconnect(name)));
	}

	/**
	 * Register a callback that is invoked whenever any connected server sends a
	 * `notifications/tools/list_changed` notification.
	 *
	 * The callback receives the server name of the sender. Multiple callbacks
	 * can be registered; they are called in registration order.
	 */
	onToolsChanged(callback: (serverName: string) => void): void {
		this.toolsChangedCallbacks.push(callback);
	}

	// ─── Private: entry management ────────────────────────────────────────────

	private getOrCreateEntry(serverName: string): PoolEntry {
		let entry = this.entries.get(serverName);
		if (entry === undefined) {
			entry = {
				serverName,
				state: "disconnected",
				client: null,
				errorMessage: null,
				idleTimer: null,
				lastUsedAt: null,
			};
			this.entries.set(serverName, entry);
		}
		return entry;
	}

	// ─── Private: connection lifecycle ────────────────────────────────────────

	/**
	 * Transition `entry` from any state to `connected` by establishing a new
	 * MCP client connection. Updates entry state on both success and failure.
	 */
	private async connectEntry(serverName: string, entry: PoolEntry): Promise<Client> {
		const serverConfig = this.config.servers[serverName];
		if (serverConfig === undefined) {
			throw new Error(`Unknown MCP server: '${serverName}'. Verify mcp.json configuration.`);
		}

		entry.state = "connecting";
		entry.errorMessage = null;

		const connectionTimeout =
			serverConfig.connectionTimeout ?? this.config.defaults.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;

		try {
			const client = await this.createAndConnect(serverName, serverConfig, connectionTimeout);

			entry.state = "connected";
			entry.client = client;
			entry.errorMessage = null;

			// Detect unexpected disconnections (process crash, network drop).
			// No automatic reconnect — state moves to "error"; next tool call retries.
			client.onclose = () => {
				if (entry.state === "connected") {
					this.clearIdleTimer(entry);
					entry.state = "error";
					entry.client = null;
					entry.errorMessage = "Connection closed unexpectedly";
				}
			};

			return client;
		} catch (err) {
			entry.state = "error";
			entry.client = null;
			entry.errorMessage = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/**
	 * Create an MCP Client, select the appropriate transport, and run the MCP
	 * initialization handshake — all within `timeoutMs`.
	 *
	 * For HTTP transport, StreamableHTTP is attempted first. On failure (and
	 * when the timeout has not expired), a fresh client is tried over SSE for
	 * compatibility with older servers.
	 */
	private async createAndConnect(serverName: string, serverConfig: McpServerConfig, timeoutMs: number): Promise<Client> {
		const abortController = new AbortController();
		const timeoutHandle = setTimeout(() => {
			abortController.abort(
				new Error(`Connection to MCP server '${serverName}' timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);

		try {
			if (serverConfig.transport === "stdio") {
				const client = this.buildClient(serverName);
				const transport = new StdioClientTransport({
					command: serverConfig.command,
					args: serverConfig.args,
					env: serverConfig.env,
					// "ignore" so child-process stderr does not leak into the user's terminal.
					stderr: "ignore",
				});
				await client.connect(transport, { signal: abortController.signal });
				return client;
			}

			// HTTP transport — StreamableHTTP with SSE fallback.
			const headers: Record<string, string> = { ...(serverConfig.headers ?? {}) };
			const url = new URL(serverConfig.url);

			const primaryClient = this.buildClient(serverName);
			const primaryTransport = new StreamableHTTPClientTransport(url, {
				requestInit: { headers },
			});

			try {
				await primaryClient.connect(primaryTransport, { signal: abortController.signal });
				return primaryClient;
			} catch (primaryErr) {
				// Only attempt SSE fallback if the connection failed for a protocol
				// reason, not because of a timeout (signal already aborted).
				if (abortController.signal.aborted) {
					throw primaryErr;
				}

				// Create a fresh client so no state from the failed attempt leaks.
				const fallbackClient = this.buildClient(serverName);
				const sseTransport = new SSEClientTransport(url, {
					requestInit: { headers },
				});

				try {
					await fallbackClient.connect(sseTransport, { signal: abortController.signal });
					return fallbackClient;
				} catch {
					// Both transports failed — surface the original StreamableHTTP error.
					throw primaryErr;
				}
			}
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	/**
	 * Construct a new MCP Client pre-configured with the pool's capabilities and
	 * a `tools/list_changed` handler that notifies pool subscribers.
	 */
	private buildClient(serverName: string): Client {
		return new Client(
			{ name: "pi-mcp-gateway", version: "1.0.0" },
			{
				capabilities: {},
				listChanged: {
					tools: {
						// The catalog handles its own refresh via the `onToolsChanged` callback;
						// we do not need the SDK to auto-fetch the updated tool list.
						autoRefresh: false,
						onChanged: (_error: Error | null, _items: Tool[] | null) => {
							this.notifyToolsChanged(serverName);
						},
					},
				},
			},
		);
	}

	// ─── Private: idle timeout ────────────────────────────────────────────────

	/**
	 * (Re-)start the idle timer for `serverName`. Clears any previously
	 * running timer first. When the timer fires, the server is disconnected and
	 * its state is returned to `"disconnected"` so the next call re-connects.
	 */
	private resetIdleTimer(serverName: string, entry: PoolEntry): void {
		this.clearIdleTimer(entry);

		const serverConfig = this.config.servers[serverName];

		// Persistent connections (lazyConnect: false) skip idle timeout entirely.
		if (serverConfig?.lazyConnect === false) return;

		const idleTimeout = serverConfig?.idleTimeout ?? this.config.defaults.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

		entry.idleTimer = setTimeout(() => {
			this.disconnect(serverName).catch(() => {
				// Ignore errors during idle-triggered disconnects.
			});
		}, idleTimeout);
	}

	private clearIdleTimer(entry: PoolEntry): void {
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
	}

	// ─── Private: notifications ───────────────────────────────────────────────

	private notifyToolsChanged(serverName: string): void {
		for (const callback of this.toolsChangedCallbacks) {
			try {
				callback(serverName);
			} catch {
				// Callbacks must not propagate errors into the pool.
			}
		}
	}
}
