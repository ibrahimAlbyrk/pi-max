import { LspClient, type DiagnosticEntry, type Location } from "./lsp-client.js";
import { type LanguageConfig, getLanguageKeyForFile } from "./language-configs.js";

/**
 * Manages multiple LSP server instances (one per language).
 * Routes requests to the appropriate server based on file extension.
 */
export class LspManager {
	/** language key -> LspClient */
	private clients = new Map<string, LspClient>();

	/** Start a server for the given language. */
	async startServer(key: string, config: LanguageConfig, cwd: string): Promise<void> {
		// Don't start duplicate servers for same command (e.g., TS and JS share typescript-language-server)
		for (const [existingKey, client] of this.clients) {
			if (existingKey !== key && client.serverName === config.server.name) {
				// Reuse existing client for this language
				this.clients.set(key, client);
				return;
			}
		}

		const client = new LspClient(config, cwd);
		this.clients.set(key, client);
		await client.start();
	}

	/** Stop all running servers. */
	async stopAll(): Promise<void> {
		// Deduplicate clients (TS/JS may share the same instance)
		const uniqueClients = new Set(this.clients.values());
		const stopPromises = Array.from(uniqueClients).map((c) => c.stop());
		await Promise.allSettled(stopPromises);
		this.clients.clear();
	}

	/** Check if any servers are running. */
	hasActiveServers(): boolean {
		for (const client of this.clients.values()) {
			if (client.isReady()) return true;
		}
		return false;
	}

	/** Get display names of active servers (deduplicated). */
	getActiveServerNames(): string[] {
		const names = new Set<string>();
		for (const client of this.clients.values()) {
			if (client.isReady()) {
				names.add(`${client.serverName} LSP`);
			}
		}
		return Array.from(names);
	}

	/** Get the appropriate LSP client for a file path. */
	getClientForFile(filePath: string): LspClient | undefined {
		const key = getLanguageKeyForFile(filePath);
		if (!key) return undefined;
		const client = this.clients.get(key);
		if (!client || !client.isReady()) return undefined;
		return client;
	}

	/** Notify the appropriate server about a file change. */
	async notifyFileChanged(filePath: string): Promise<void> {
		const client = this.getClientForFile(filePath);
		if (client) {
			await client.notifyFileChanged(filePath);
		}
	}

	/** Get all diagnostics from all servers, formatted as strings. */
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

export type { DiagnosticEntry, Location };
