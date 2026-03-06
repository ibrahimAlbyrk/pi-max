import { LspClient } from "./client.js";
import { getLanguageKeyForFile, type LanguageConfig } from "./language-configs.js";

/**
 * Manages multiple LSP server instances (one per language).
 * Routes requests to the appropriate server based on file extension.
 * Handles server deduplication: TS and JS share typescript-language-server.
 */
export class LspManager {
	/** language key → LspClient */
	private clients: Map<string, LspClient> = new Map();

	// --- Server Lifecycle ---

	/**
	 * Start a server for the given language key.
	 * Deduplication: if another language already has a client using the same
	 * server (by server.name, which matches server.command for all configs),
	 * reuse that client instance instead of spawning a new one.
	 */
	async startServer(key: string, config: LanguageConfig, cwd: string): Promise<void> {
		// Check for an existing client that uses the same underlying server command
		for (const [existingKey, client] of this.clients) {
			if (existingKey !== key && client.serverName === config.server.name) {
				// Reuse the existing client (e.g. "javascript" reuses "typescript" client)
				this.clients.set(key, client);
				return;
			}
		}

		const client = new LspClient(config, cwd);
		this.clients.set(key, client);
		await client.start();
	}

	/**
	 * Stop all running servers.
	 * Deduplicates shared client instances before stopping.
	 */
	async stopAll(): Promise<void> {
		const unique = new Set(this.clients.values());
		await Promise.allSettled(Array.from(unique).map((c) => c.stop()));
		this.clients.clear();
	}

	/**
	 * Synchronous SIGKILL variant of stopAll().
	 * Intended for use in process.on("exit") handlers where async is not allowed.
	 * Sends stop signals in a fire-and-forget manner.
	 */
	killAll(): void {
		const unique = new Set(this.clients.values());
		for (const client of unique) {
			void client.stop();
		}
		this.clients.clear();
	}

	// --- Queries ---

	/**
	 * Get the LSP client for a given file path.
	 * Returns undefined if no ready server handles this file type.
	 */
	getClientForFile(filePath: string): LspClient | undefined {
		const key = getLanguageKeyForFile(filePath);
		if (!key) return undefined;
		const client = this.clients.get(key);
		if (!client || !client.isReady()) return undefined;
		return client;
	}

	/** Returns true if at least one server is initialized and ready. */
	hasActiveServers(): boolean {
		for (const client of this.clients.values()) {
			if (client.isReady()) return true;
		}
		return false;
	}

	/**
	 * Returns deduplicated display names for all ready servers.
	 * Example: ["typescript-language-server LSP", "pylsp LSP"]
	 */
	getActiveServerNames(): string[] {
		const names = new Set<string>();
		for (const client of this.clients.values()) {
			if (client.isReady()) {
				names.add(`${client.serverName} LSP`);
			}
		}
		return Array.from(names);
	}

	// --- Document Sync ---

	/**
	 * Notify the appropriate server that a file has changed.
	 * No-op if no ready server handles this file type.
	 */
	async notifyFileChanged(filePath: string): Promise<void> {
		const client = this.getClientForFile(filePath);
		if (client) {
			await client.notifyFileChanged(filePath);
		}
	}

	// --- Diagnostics ---

	/**
	 * Collect all diagnostics from all unique ready servers.
	 * Returns formatted strings: "{file}:{line}:{char} [{severity}] {message}"
	 */
	getAllDiagnostics(): string[] {
		const lines: string[] = [];
		const seen = new Set<LspClient>();
		for (const client of this.clients.values()) {
			if (!client.isReady() || seen.has(client)) continue;
			seen.add(client);
			lines.push(...client.getAllDiagnostics());
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: LspManager | null = null;

/** Get or create the global LspManager singleton. */
export function getLspManager(): LspManager {
	if (!_manager) {
		_manager = new LspManager();
	}
	return _manager;
}

/**
 * Dispose the global LspManager singleton, stopping all servers.
 * Sets the singleton to null so a new one can be created if needed.
 */
export function disposeLspManager(): Promise<void> {
	if (_manager) {
		const m = _manager;
		_manager = null;
		return m.stopAll();
	}
	return Promise.resolve();
}
