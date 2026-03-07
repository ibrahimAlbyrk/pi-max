import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { LanguageConfig } from "./language-configs.js";

// ---------------------------------------------------------------------------
// Minimal LSP type stubs so this file compiles without
// `vscode-languageserver-protocol` being installed.  The actual protocol
// module is lazy-loaded at runtime via createRequire().
// ---------------------------------------------------------------------------

/** Mirrors vscode-languageserver-protocol Diagnostic (subset used here). */
interface LspDiagnostic {
	range: { start: { line: number; character: number } };
	severity?: number;
	message: string;
}

/** Mirrors vscode-languageserver-protocol ProtocolConnection (subset used here). */
interface LspConnection {
	onNotification(type: { method: string }, handler: (...args: any[]) => void): void;
	listen(): void;
	sendRequest(type: { method: string } | string, params?: unknown): Promise<any>;
	sendNotification(type: { method: string } | string, params?: unknown): void;
	dispose(): void;
}

/** Shape of the vscode-languageserver-protocol/node module (subset used here). */
interface LspProtocolModule {
	createProtocolConnection(reader: unknown, writer: unknown): LspConnection;
	StreamMessageReader: new (readable: NodeJS.ReadableStream) => unknown;
	StreamMessageWriter: new (writable: NodeJS.WritableStream) => unknown;
	PublishDiagnosticsNotification: { type: { method: string } };
	InitializeRequest: { type: { method: string } };
	DefinitionRequest: { type: { method: string } };
	ReferencesRequest: { type: { method: string } };
	HoverRequest: { type: { method: string } };
	DidChangeTextDocumentNotification: { type: { method: string } };
	DidOpenTextDocumentNotification: { type: { method: string } };
}

// Lazy-load the protocol module via require() so the app does not crash when
// `vscode-languageserver-protocol` is not installed.  The package is resolved
// on first use (when LspClient.start() is called), not at module load time.
const _require = createRequire(import.meta.url);
let _lsp: LspProtocolModule | undefined;
function lsp(): LspProtocolModule {
	if (!_lsp) {
		_lsp = _require("vscode-languageserver-protocol/node.js") as LspProtocolModule;
	}
	return _lsp;
}

export interface Location {
	file: string;
	line: number; // 0-indexed (internal), converted to 1-indexed in tool output
	character: number; // 0-indexed (internal), converted to 1-indexed in tool output
}

export interface SymbolInfo {
	name: string;
	kind: string; // "function", "class", "type", "interface", "variable", "constant", "method", "property", "enum", "enum member", "parameter", "namespace", "constructor", "module"
}

export interface DiagnosticEntry {
	line: number; // 0-indexed
	character: number; // 0-indexed
	severity: number; // 1=Error, 2=Warning, 3=Information, 4=Hint
	message: string;
}

/**
 * Wraps a single LSP server process and its protocol connection.
 *
 * All line/character values are 0-indexed (LSP protocol native). Conversion
 * to 1-indexed happens in the tool layer, not here.
 */
export class LspClient {
	private process: ChildProcess | null = null;
	private connection: LspConnection | null = null;
	private diagnosticsMap: Map<string, LspDiagnostic[]> = new Map();
	private openDocuments: Map<string, number> = new Map(); // uri → version
	private initialized: boolean = false;
	private initPromise: Promise<void> | null = null;

	constructor(
		private config: LanguageConfig,
		private cwd: string,
	) {}

	// --- Lifecycle ---

	/**
	 * Start the language server and initialize the LSP connection.
	 * Idempotent: returns the existing initPromise if already starting/started.
	 */
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

		this.process.on("exit", (code, signal) => {
			if (this.initialized) {
				console.error(`[lsp] ${this.config.server.name} exited unexpectedly: code=${code}, signal=${signal}`);
			}
			this.initialized = false;
			this.connection = null;
		});

		this.process.on("error", (err) => {
			console.error(`[lsp] ${this.config.server.name} process error: ${err.message}`);
		});

		const proto = lsp();
		const conn = proto.createProtocolConnection(
			new proto.StreamMessageReader(this.process.stdout!),
			new proto.StreamMessageWriter(this.process.stdin!),
		);
		this.connection = conn;

		// Register PublishDiagnosticsNotification handler → update diagnosticsMap
		conn.onNotification(
			proto.PublishDiagnosticsNotification.type,
			(params: { uri: string; diagnostics: LspDiagnostic[] }) => {
				this.diagnosticsMap.set(params.uri, params.diagnostics);
			},
		);

		conn.listen();

		await conn.sendRequest(proto.InitializeRequest.type, {
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

		conn.sendNotification("initialized", {});
		this.initialized = true;
	}

	/**
	 * Graceful shutdown: send shutdown/exit, wait up to 3s, then SIGKILL.
	 */
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
			await new Promise<void>((res) => {
				const timeout = setTimeout(() => {
					this.process?.kill("SIGKILL");
					res();
				}, 3000);
				this.process!.on("exit", () => {
					clearTimeout(timeout);
					res();
				});
				this.process!.kill();
			});
			this.process = null;
		}

		this.initPromise = null;
		this.diagnosticsMap.clear();
		this.openDocuments.clear();
	}

	/** Returns true when the server is initialized and the connection is live. */
	isReady(): boolean {
		return this.initialized && this.connection !== null;
	}

	// --- Document Sync ---

	/**
	 * Notify the server that a file has changed (open or update).
	 * If not initialized, returns immediately.
	 */
	async notifyFileChanged(filePath: string): Promise<void> {
		if (!this.initialized || !this.connection) return;

		const fullPath = resolve(filePath);
		const uri = `file://${fullPath}`;

		let content: string;
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			return; // File may have been deleted — silently skip
		}

		const proto = lsp();
		if (this.openDocuments.has(uri)) {
			const version = (this.openDocuments.get(uri) ?? 0) + 1;
			this.openDocuments.set(uri, version);
			this.connection.sendNotification(proto.DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		} else {
			this.openDocuments.set(uri, 1);
			this.connection.sendNotification(proto.DidOpenTextDocumentNotification.type, {
				textDocument: {
					uri,
					languageId: this.config.languageId,
					version: 1,
					text: content,
				},
			});
		}
	}

	/**
	 * Ensure a file is open in the server.
	 * Calls notifyFileChanged() if the file is not already tracked.
	 */
	async ensureOpen(filePath: string): Promise<void> {
		const fullPath = resolve(filePath);
		const uri = `file://${fullPath}`;
		if (!this.openDocuments.has(uri)) {
			await this.notifyFileChanged(filePath);
		}
	}

	// --- Queries ---

	/**
	 * Get diagnostics for a specific file. Returns 0-indexed line/character.
	 */
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

	/**
	 * Get all diagnostics across all tracked files.
	 * Returns formatted strings: "{file}:{line+1}:{char+1} [{severity}] {message}"
	 */
	getAllDiagnostics(): string[] {
		const lines: string[] = [];
		for (const [uri, diags] of this.diagnosticsMap) {
			const file = uriToPath(uri);
			for (const d of diags) {
				const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint";
				lines.push(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}`);
			}
		}
		return lines;
	}

	/**
	 * Get definition locations for a symbol at the given 0-indexed position.
	 * Returns Location[] with 0-indexed line/character.
	 */
	async getDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
		if (!this.connection || !this.initialized) return [];

		await this.ensureOpen(filePath);

		const result = await this.connection.sendRequest(lsp().DefinitionRequest.type, {
			textDocument: { uri: `file://${resolve(filePath)}` },
			position: { line, character },
		});

		if (!result) return [];

		const items = Array.isArray(result) ? result : [result];
		return items.map((item) => {
			// Handle both Location and LocationLink shapes
			const uri: string = "targetUri" in item ? item.targetUri : item.uri;
			const range = "targetSelectionRange" in item ? item.targetSelectionRange : item.range;
			return {
				file: uriToPath(uri),
				line: range.start.line,
				character: range.start.character,
			};
		});
	}

	/**
	 * Find all references to a symbol at the given 0-indexed position.
	 * Returns Location[] with 0-indexed line/character.
	 */
	async getReferences(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration: boolean,
	): Promise<Location[]> {
		if (!this.connection || !this.initialized) return [];

		await this.ensureOpen(filePath);

		const result = await this.connection.sendRequest(lsp().ReferencesRequest.type, {
			textDocument: { uri: `file://${resolve(filePath)}` },
			position: { line, character },
			context: { includeDeclaration },
		});

		if (!result) return [];

		return result.map((loc: { uri: string; range: { start: { line: number; character: number } } }) => ({
			file: uriToPath(loc.uri),
			line: loc.range.start.line,
			character: loc.range.start.character,
		}));
	}

	/**
	 * Get hover information for a symbol at the given 0-indexed position.
	 * Returns the raw hover text content (code block content extracted from markdown).
	 */
	async getHover(filePath: string, line: number, character: number): Promise<string | null> {
		if (!this.connection || !this.initialized) return null;

		await this.ensureOpen(filePath);

		const result = await this.connection.sendRequest(lsp().HoverRequest.type, {
			textDocument: { uri: `file://${resolve(filePath)}` },
			position: { line, character },
		});

		if (!result || !result.contents) return null;

		const contents = result.contents;
		if (typeof contents === "string") return contents;
		if ("value" in contents) return contents.value;
		if (Array.isArray(contents)) {
			return contents.map((c: string | { value: string }) => (typeof c === "string" ? c : c.value)).join("\n");
		}
		return null;
	}

	/**
	 * Get symbol info (name + kind) for a symbol at the given 0-indexed position.
	 * Uses hover to determine the symbol kind, then extracts the name.
	 */
	async getSymbolInfo(filePath: string, line: number, character: number): Promise<SymbolInfo | null> {
		const hoverContent = await this.getHover(filePath, line, character);
		if (!hoverContent) return null;
		return parseSymbolInfo(hoverContent);
	}

	// --- Accessors ---

	/** Server display name (e.g., "typescript-language-server"). */
	get serverName(): string {
		return this.config.server.name;
	}

	/** LSP language identifier (e.g., "typescript"). */
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

/**
 * Extract code content from markdown hover response.
 * TypeScript LSP returns hover as: ```typescript\n<code>\n```
 */
function extractCodeFromMarkdown(markdown: string): string {
	const codeBlockMatch = markdown.match(/```\w*\n([\s\S]*?)```/);
	if (codeBlockMatch) return codeBlockMatch[1].trim();
	return markdown.trim();
}

/**
 * Parse hover content to extract symbol name and kind.
 *
 * TypeScript LSP hover patterns:
 * - "function stream(...)"         → function
 * - "class LspClient"              → class
 * - "interface StreamOptions"      → interface
 * - "type Api = ..."               → type
 * - "const DEFAULT_TIMEOUT: ..."   → constant
 * - "let foo: string"              → variable
 * - "var bar: number"              → variable
 * - "(method) getDefinition(...)"  → method
 * - "(property) connection: ..."   → property
 * - "(parameter) options: ..."     → parameter
 * - "enum SymbolKind"              → enum
 * - "enum member Function = ..."   → enum member
 * - "namespace providers"          → namespace
 * - "constructor LspClient(...)"   → constructor
 * - "module ..."                   → module
 */
export function parseSymbolInfo(hoverContent: string): SymbolInfo | null {
	const code = extractCodeFromMarkdown(hoverContent);
	const firstLine = code.split("\n")[0]?.trim();
	if (!firstLine) return null;

	// Strip "(alias) " or "(type alias) " prefix — TS LSP wraps re-exported symbols:
	// "(alias) interface Context" → parse as "interface Context"
	// "(alias) type Api = ..." → parse as "type Api = ..."
	// "(alias) function bar(...)" → parse as "function bar(...)"
	const stripped = firstLine.replace(/^\((?:type\s+)?alias\)\s+/, "");

	// Pattern: "(kind) name" — e.g. (method) getDefinition, (property) connection
	const parenMatch = stripped.match(/^\((\w[\w\s]*)\)\s+(?:[\w.]+\.)?(\w+)/);
	if (parenMatch) {
		return { kind: parenMatch[1], name: parenMatch[2] };
	}

	// Pattern: "keyword name" — e.g. function stream, class LspClient, const FOO
	const keywordMatch = stripped.match(
		/^(function|class|interface|type|const|let|var|enum|namespace|module|constructor)\s+(\w+)/,
	);
	if (keywordMatch) {
		const rawKind = keywordMatch[1];
		const kind = rawKind === "const" ? "constant" : rawKind === "let" || rawKind === "var" ? "variable" : rawKind;
		return { kind, name: keywordMatch[2] };
	}

	// Pattern: "import Name" — e.g. import Api
	const importMatch = stripped.match(/^import\s+(\w+)/);
	if (importMatch) {
		return { kind: "import", name: importMatch[1] };
	}

	return null;
}
