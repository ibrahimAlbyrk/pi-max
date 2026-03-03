import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createProtocolConnection,
	StreamMessageReader,
	StreamMessageWriter,
	InitializeRequest,
	DidOpenTextDocumentNotification,
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	PublishDiagnosticsNotification,
	DefinitionRequest,
	ReferencesRequest,
	type ProtocolConnection,
	type Diagnostic,
} from "vscode-languageserver-protocol/node.js";
import type { LanguageConfig } from "./language-configs.js";

export interface Location {
	file: string;
	line: number;
	character: number;
}

export interface DiagnosticEntry {
	line: number;
	character: number;
	severity: number;
	message: string;
}

/**
 * Wraps a single LSP server process and its protocol connection.
 */
export class LspClient {
	private process: ChildProcess | null = null;
	private connection: ProtocolConnection | null = null;
	private diagnosticsMap = new Map<string, Diagnostic[]>();
	private openDocuments = new Map<string, number>(); // uri -> version
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	constructor(
		private config: LanguageConfig,
		private cwd: string
	) {}

	/** Start the language server and initialize the LSP connection. */
	async start(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this._start();
		return this.initPromise;
	}

	private async _start(): Promise<void> {
		this.process = spawn(this.config.server.command, this.config.server.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		// Handle unexpected exit
		this.process.on("exit", (code, signal) => {
			if (this.initialized) {
				console.error(`[lsp-tools] ${this.config.server.name} exited: code=${code}, signal=${signal}`);
			}
			this.initialized = false;
			this.connection = null;
		});

		this.process.on("error", (err) => {
			console.error(`[lsp-tools] ${this.config.server.name} error: ${err.message}`);
		});

		this.connection = createProtocolConnection(
			new StreamMessageReader(this.process.stdout!),
			new StreamMessageWriter(this.process.stdin!)
		);

		// Collect diagnostics pushed by the server
		this.connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
			this.diagnosticsMap.set(params.uri, params.diagnostics);
		});

		this.connection.listen();

		// Initialize handshake
		await this.connection.sendRequest(InitializeRequest.type, {
			processId: process.pid,
			rootUri: `file://${this.cwd}`,
			capabilities: {
				textDocument: {
					synchronization: {
						didSave: true,
						dynamicRegistration: false,
					},
					publishDiagnostics: {
						relatedInformation: true,
					},
				},
				workspace: {
					workspaceFolders: true,
				},
			},
			workspaceFolders: [{ uri: `file://${this.cwd}`, name: "workspace" }],
		});

		this.connection.sendNotification("initialized", {});
		this.initialized = true;
	}

	/** Graceful shutdown. */
	async stop(): Promise<void> {
		this.initialized = false;

		if (this.connection) {
			try {
				await this.connection.sendRequest("shutdown");
				this.connection.sendNotification("exit");
			} catch {
				// Server may already be gone
			}
			this.connection.dispose();
			this.connection = null;
		}

		if (this.process) {
			// Wait for process to exit (with timeout)
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					this.process?.kill("SIGKILL");
					resolve();
				}, 3000);
				this.process!.on("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
				// In case exit notification didn't work
				this.process!.kill();
			});
			this.process = null;
		}

		this.initPromise = null;
		this.diagnosticsMap.clear();
		this.openDocuments.clear();
	}

	/** Whether the server is initialized and ready. */
	isReady(): boolean {
		return this.initialized && this.connection !== null;
	}

	// -----------------------------------------------------------------------
	// Document synchronization
	// -----------------------------------------------------------------------

	/** Notify the server about a file change (open or update). */
	async notifyFileChanged(filePath: string): Promise<void> {
		if (!this.connection || !this.initialized) return;

		const fullPath = resolve(filePath);
		const uri = `file://${fullPath}`;

		let content: string;
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			return; // File may have been deleted
		}

		if (this.openDocuments.has(uri)) {
			// Already open -- send change
			const version = (this.openDocuments.get(uri) || 0) + 1;
			this.openDocuments.set(uri, version);
			this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		} else {
			// First time -- open
			this.openDocuments.set(uri, 1);
			this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
				textDocument: {
					uri,
					languageId: this.config.languageId,
					version: 1,
					text: content,
				},
			});
		}
	}

	/** Ensure a file is open in the server. */
	async ensureOpen(filePath: string): Promise<void> {
		const fullPath = resolve(filePath);
		const uri = `file://${fullPath}`;
		if (!this.openDocuments.has(uri)) {
			await this.notifyFileChanged(filePath);
		}
	}

	// -----------------------------------------------------------------------
	// Diagnostics
	// -----------------------------------------------------------------------

	/** Get diagnostics for a specific file. */
	getDiagnosticsForFile(filePath: string): DiagnosticEntry[] {
		const fullPath = resolve(filePath);
		const uri = `file://${fullPath}`;
		const diags = this.diagnosticsMap.get(uri);
		if (!diags) return [];
		return diags.map((d) => ({
			line: d.range.start.line,
			character: d.range.start.character,
			severity: d.severity ?? 3,
			message: d.message,
		}));
	}

	/** Get all diagnostics across all open files. Returns formatted strings. */
	getAllDiagnostics(): string[] {
		const lines: string[] = [];
		for (const [uri, diags] of this.diagnosticsMap) {
			const file = uriToPath(uri);
			for (const d of diags) {
				const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
				lines.push(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}`);
			}
		}
		return lines;
	}

	// -----------------------------------------------------------------------
	// Go to Definition
	// -----------------------------------------------------------------------

	/** Get definition locations for a symbol at the given position. */
	async getDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
		if (!this.connection || !this.initialized) return [];

		await this.ensureOpen(filePath);

		const result = await this.connection.sendRequest(DefinitionRequest.type, {
			textDocument: { uri: `file://${resolve(filePath)}` },
			position: { line, character },
		});

		if (!result) return [];

		const items = Array.isArray(result) ? result : [result];
		return items.map((item: any) => {
			const uri = item.uri || item.targetUri;
			const range = item.range || item.targetSelectionRange;
			return {
				file: uriToPath(uri),
				line: range.start.line,
				character: range.start.character,
			};
		});
	}

	// -----------------------------------------------------------------------
	// Find References
	// -----------------------------------------------------------------------

	/** Find all references to a symbol at the given position. */
	async getReferences(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration: boolean
	): Promise<Location[]> {
		if (!this.connection || !this.initialized) return [];

		await this.ensureOpen(filePath);

		const result = await this.connection.sendRequest(ReferencesRequest.type, {
			textDocument: { uri: `file://${resolve(filePath)}` },
			position: { line, character },
			context: { includeDeclaration },
		});

		if (!result) return [];

		return result.map((loc) => ({
			file: uriToPath(loc.uri),
			line: loc.range.start.line,
			character: loc.range.start.character,
		}));
	}

	/** Server display name. */
	get serverName(): string {
		return this.config.server.name;
	}

	/** Language key (e.g., "csharp", "typescript"). */
	get languageId(): string {
		return this.config.languageId;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uriToPath(uri: string): string {
	return uri.replace(/^file:\/\//, "");
}
