# Built-in LSP Tools Feature — Implementation Spec

**Status:** Draft
**Migrating from:** `.pi/extensions/lsp-tools/` (6 files, ~1,776 LOC)
**Target location:** `packages/coding-agent/src/core/tools/lsp-*.ts` + `packages/coding-agent/src/core/features/lsp/`
**Related report:** [extensions-to-builtin.report.md](../reports/extensions-to-builtin.report.md)
**Pattern reference:** [builtin-bg.spec.md](./builtin-bg.spec.md)

---

## 1. Overview

The LSP tools feature provides Language Server Protocol integration, giving the LLM agent (and subagents) the ability to:

1. **`lsp_diagnostics` tool** — Get compiler errors and warnings for a file or the entire workspace
2. **`lsp_definition` tool** — Find where a symbol is defined (resolves overloads, scopes, namespaces)
3. **`lsp_references` tool** — Find all references to a symbol across the workspace
4. **LspManager** — Multi-language LSP server lifecycle manager with server deduplication
5. **LspClient** — Per-server protocol connection handling (initialize, document sync, requests)
6. **Language detection** — Auto-detect project languages and install missing servers
7. **Document sync** — Notify LSP servers when files are edited/written by the agent
8. **Slash commands** — `/lsp-setup` (interactive install) and `/lsp-status` (show active servers)

### Supported Languages

**Tier 1 (Auto-installable):**
- TypeScript/JavaScript (shared: `typescript-language-server`)
- Python (`pylsp`)
- Go (`gopls`)
- Rust (`rust-analyzer`)
- C# (`OmniSharp`)

**Tier 2 (Manual installation):**
- Java (`jdtls`), C/C++ (`clangd`), Ruby (`solargraph`), PHP (`intelephense`), Swift (`sourcekit-lsp`), Kotlin (`kotlin-language-server`)

---

## 2. Architecture

### 2.1 File Structure

```
packages/coding-agent/src/
├── core/
│   ├── tools/
│   │   ├── lsp-diagnostics.ts       # lsp_diagnostics tool definition + factory
│   │   ├── lsp-definition.ts        # lsp_definition tool definition + factory
│   │   ├── lsp-references.ts        # lsp_references tool definition + factory
│   │   └── index.ts                 # Updated: add 3 LSP tools to _toolRegistry
│   └── features/
│       └── lsp/
│           ├── index.ts             # Feature entry: exports setup function + singleton
│           ├── manager.ts           # LspManager: multi-language server orchestration
│           ├── client.ts            # LspClient: per-server protocol connection
│           ├── language-configs.ts  # LanguageConfig definitions (Tier 1 + Tier 2)
│           └── language-detector.ts # Language detection + server installation
```

### 2.2 Integration Points

```
AgentSession constructor
    │
    ├─ _customTools.push(lspDiagnosticsDefinition)    # 3 ToolDefinitions
    ├─ _customTools.push(lspDefinitionDefinition)
    ├─ _customTools.push(lspReferencesDefinition)
    │
    ├─ lspFeature.setup(session)                       # Hook registration
    │   ├─ session_start → detectAndSetup() → manager.startServer()
    │   ├─ session_shutdown → manager.stopAll()
    │   └─ tool_result (edit/write) → manager.notifyFileChanged()
    │
    └─ Interactive mode
        ├─ /lsp-setup command registration
        ├─ /lsp-status command registration
        └─ Status bar: "typescript LSP | python LSP"
```

### 2.3 Dependency Chain

```
lsp-diagnostics.ts ─┐
lsp-definition.ts  ─┼─→ getLspManager() → LspManager
lsp-references.ts  ─┘         │
                               ├─→ LspClient (per language)
                               │       └─→ vscode-languageserver-protocol
                               │               └─→ vscode-jsonrpc
                               └─→ language-configs.ts (static config data)
```

---

## 3. New Dependencies

These must be added to `packages/coding-agent/package.json`:

```json
{
  "dependencies": {
    "vscode-languageserver-protocol": "^3.17.5",
    "vscode-jsonrpc": "^8.2.1"
  }
}
```

**Size impact:**
- `vscode-languageserver-protocol`: ~828KB (includes `vscode-languageserver-types`)
- `vscode-jsonrpc`: ~328KB
- **Total:** ~1.15MB added to node_modules

These are the **only** new npm dependencies for the entire extensions-to-builtin migration.

---

## 4. Component Specifications

### 4.1 LanguageConfig (`features/lsp/language-configs.ts`)

Static configuration data for all supported languages. No runtime state.

```typescript
export interface LanguageConfig {
  name: string;                       // Display name: "TypeScript"
  detect: {
    extensions: string[];             // File extensions: [".ts", ".tsx"]
    markerFiles?: string[];           // Marker files: ["tsconfig.json"]
  };
  runtime: {
    command: string;                  // Runtime check: "node"
    versionArgs: string[];            // Version args: ["--version"]
    installHint: string;              // Install instructions URL
  };
  server: {
    name: string;                     // Server display name: "typescript-language-server"
    command: string;                  // Server executable
    args: string[];                   // Server startup args: ["--stdio"]
    checkCommand: string;             // Version check: "typescript-language-server --version"
    installCommand: string;           // Auto-install: "npm install -g typescript-language-server typescript"
    autoInstallable: boolean;         // Can be installed automatically
    manualInstallHint?: string;       // Manual instructions for Tier 2
  };
  languageId: string;                 // LSP language ID: "typescript"
}

export const TIER1_CONFIGS: Record<string, LanguageConfig>;
// csharp, typescript, javascript, python, go, rust

export const TIER2_CONFIGS: Record<string, LanguageConfig>;
// java, cpp, ruby, php, swift, kotlin

export const ALL_CONFIGS: Record<string, LanguageConfig>;
// { ...TIER1_CONFIGS, ...TIER2_CONFIGS }

// File extension → language key mapping (built once at module load)
export function getLanguageKeyForFile(filePath: string): string | undefined;
export function getLanguageIdForFile(filePath: string): string | undefined;
```

**Key detail:** TypeScript and JavaScript share the same server (`typescript-language-server`). The configs are separate entries but map to the same `server.command`. LspManager handles deduplication.

### 4.2 LspClient (`features/lsp/client.ts`)

Per-server protocol connection. Manages the lifecycle of a single LSP server process.

```typescript
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  PublishDiagnosticsNotification,
  DefinitionRequest,
  ReferencesRequest,
  type ProtocolConnection,
  type Diagnostic,
} from "vscode-languageserver-protocol/node.js";

export interface Location {
  file: string;
  line: number;      // 0-indexed (internal), converted to 1-indexed in tool output
  character: number;  // 0-indexed (internal), converted to 1-indexed in tool output
}

export interface DiagnosticEntry {
  line: number;       // 0-indexed
  character: number;  // 0-indexed
  severity: number;   // 1=Error, 2=Warning, 3=Information, 4=Hint
  message: string;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: ProtocolConnection | null = null;
  private diagnosticsMap: Map<string, Diagnostic[]> = new Map();
  private openDocuments: Map<string, number> = new Map();  // uri → version
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(private config: LanguageConfig, private cwd: string) {}

  // --- Lifecycle ---

  async start(): Promise<void>;
  // Idempotent: returns existing initPromise if already starting/started.
  // 1. Spawn server process: spawn(config.server.command, config.server.args, {
  //      cwd, stdio: ["pipe", "pipe", "pipe"]
  //    })
  // 2. Create ProtocolConnection from stdout/stdin
  // 3. Register PublishDiagnosticsNotification handler → update diagnosticsMap
  // 4. connection.listen()
  // 5. Send InitializeRequest with capabilities:
  //    - textDocument.synchronization (didSave, no dynamic registration)
  //    - textDocument.publishDiagnostics (relatedInformation)
  //    - workspace.workspaceFolders
  // 6. Send "initialized" notification
  // 7. Set initialized = true

  async stop(): Promise<void>;
  // 1. Set initialized = false
  // 2. Send shutdown request + exit notification via connection
  // 3. connection.dispose()
  // 4. Wait up to 3s for process exit, then SIGKILL
  // 5. Clear all state (initPromise, diagnosticsMap, openDocuments)

  isReady(): boolean;
  // Returns initialized && connection !== null

  // --- Document Sync ---

  async notifyFileChanged(filePath: string): Promise<void>;
  // If not initialized → return
  // Resolve to absolute path → file:// URI
  // Read file content (return on read failure)
  // If URI already open: increment version, send DidChangeTextDocumentNotification
  // If new: set version=1, send DidOpenTextDocumentNotification

  async ensureOpen(filePath: string): Promise<void>;
  // Calls notifyFileChanged() if not already in openDocuments

  // --- Queries ---

  getDiagnosticsForFile(filePath: string): DiagnosticEntry[];
  // Resolve path → URI, lookup in diagnosticsMap, map to DiagnosticEntry

  getAllDiagnostics(): string[];
  // Iterate diagnosticsMap, format each: "{file}:{line+1}:{char+1} [{severity}] {message}"
  // severity: 1→"error", 2→"warning", 3→"info", 4→"hint"

  async getDefinition(filePath: string, line: number, character: number): Promise<Location[]>;
  // ensureOpen(filePath)
  // Send DefinitionRequest with 0-indexed position
  // Handle response: single Location | Location[] | LocationLink[]
  // Extract uri (or targetUri) and range (or targetSelectionRange)
  // Return Location[] with 0-indexed line/character

  async getReferences(
    filePath: string, line: number, character: number,
    includeDeclaration: boolean
  ): Promise<Location[]>;
  // ensureOpen(filePath)
  // Send ReferencesRequest with 0-indexed position + context.includeDeclaration
  // Return Location[] with 0-indexed line/character

  // --- Accessors ---

  get serverName(): string;   // config.server.name
  get languageId(): string;   // config.languageId
}
```

**Important indexing note:** The LSP protocol uses 0-indexed line/character. The tool APIs expose 1-indexed values to the LLM. Conversion happens in the tool layer, not in LspClient.

### 4.3 LspManager (`features/lsp/manager.ts`)

Manages multiple LspClient instances. Handles server deduplication (TS/JS share one server).

```typescript
export class LspManager {
  private clients: Map<string, LspClient> = new Map();  // language key → client

  // --- Server Lifecycle ---

  async startServer(key: string, config: LanguageConfig, cwd: string): Promise<void>;
  // Deduplication: if another language key already has a client with the same
  // server.command, reuse that client instance.
  // Example: "javascript" reuses the client from "typescript" since both use
  // typescript-language-server.
  // Otherwise: create new LspClient, call client.start(), store in map.

  async stopAll(): Promise<void>;
  // Deduplicate clients (Map values may have shared references)
  // Promise.allSettled() on all unique client.stop() calls
  // Clear clients map

  // --- Queries ---

  getClientForFile(filePath: string): LspClient | undefined;
  // getLanguageKeyForFile(filePath) → lookup in clients map
  // Return client only if client.isReady()

  hasActiveServers(): boolean;
  // Any client where isReady() === true

  getActiveServerNames(): string[];
  // Deduplicated list of ready server names: ["typescript-language-server LSP", "pylsp LSP"]

  // --- Document Sync ---

  async notifyFileChanged(filePath: string): Promise<void>;
  // getClientForFile(filePath) → client.notifyFileChanged(filePath)

  // --- Diagnostics ---

  getAllDiagnostics(): string[];
  // Iterate all unique ready clients, collect client.getAllDiagnostics()
  // Return combined array
}
```

**Singleton pattern:**

```typescript
let _manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!_manager) {
    _manager = new LspManager();
  }
  return _manager;
}

export function disposeLspManager(): Promise<void> {
  if (_manager) {
    const m = _manager;
    _manager = null;
    return m.stopAll();
  }
  return Promise.resolve();
}
```

### 4.4 Language Detector (`features/lsp/language-detector.ts`)

Detects project languages and manages server installation.

```typescript
export interface DetectedLanguage {
  key: string;              // "typescript", "python", etc.
  config: LanguageConfig;
  status: "ready" | "installable" | "missing-runtime" | "manual";
}

// --- Detection ---

export async function detectLanguages(cwd: string): Promise<DetectedLanguage[]>;
// For each language in ALL_CONFIGS:
//   1. Scan for source files (find -maxdepth 3, excluding node_modules/.git/dist/etc.)
//   2. Check marker files if defined
//   3. If language detected:
//      a. Check if server command exists (which <command>)
//      b. If yes → status: "ready"
//      c. If no, check runtime exists
//      d. If runtime missing → status: "missing-runtime"
//      e. If runtime exists + autoInstallable → status: "installable"
//      f. Otherwise → status: "manual"

export async function detectAndSetup(cwd: string): Promise<DetectedLanguage[]>;
// Non-interactive version for session_start:
//   - Returns only "ready" languages
//   - Logs notifications for installable/missing/manual languages
//   - Does NOT auto-install (user must run /lsp-setup)

export async function installMissingServers(
  languages: DetectedLanguage[],
  confirm: (title: string, message: string) => Promise<boolean>,
  notify: (message: string, type: "info" | "warning" | "error") => void,
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<DetectedLanguage[]>;
// Interactive version for /lsp-setup:
//   - For "ready" → include directly
//   - For "missing-runtime" → warn with installHint
//   - For "manual" → warn with manualInstallHint
//   - For "installable" → prompt confirm, run installCommand, check result

// --- Helpers ---

async function detectLanguage(config: LanguageConfig, cwd: string): Promise<boolean>;
// Runs find commands to check for source files + marker files

async function isCommandAvailable(command: string): Promise<boolean>;
// Runs "which <command>", returns true if exit code 0
```

**Excluded directories for language detection:**
```typescript
const EXCLUDED_DIRS = [
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "vendor", "__pycache__", ".venv", "venv", "target", "bin", "obj",
  ".pi", ".cache", "coverage", ".tox", ".eggs",
];
```

### 4.5 Tool Definitions

#### 4.5.1 lsp_diagnostics (`tools/lsp-diagnostics.ts`)

```typescript
const lspDiagnosticsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "File path to check. Omit for all workspace diagnostics." })
  ),
});

export interface LspDiagnosticsDetails {
  file?: string;
  diagnosticCount: number;
}

export const lspDiagnosticsDefinition: ToolDefinition<typeof lspDiagnosticsSchema, LspDiagnosticsDetails> = {
  name: "lsp_diagnostics",
  label: "LSP Diagnostics",
  description: "Get compiler errors and warnings for a file or the entire workspace. Use after editing code to check for compilation errors. Returns diagnostics with file path, line, severity, and message.",
  parameters: lspDiagnosticsSchema,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const manager = getLspManager();

    if (!manager.hasActiveServers()) {
      return {
        content: [{ type: "text", text: "No LSP servers active. Run /lsp-setup to configure." }],
        details: { diagnosticCount: 0 },
      };
    }

    if (params.path) {
      // Single file diagnostics
      const absPath = resolve(ctx.cwd, params.path);
      const client = manager.getClientForFile(absPath);
      if (!client) {
        return {
          content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
          details: { file: params.path, diagnosticCount: 0 },
        };
      }

      await client.ensureOpen(absPath);
      // Small delay to allow diagnostics to arrive from server
      await new Promise(r => setTimeout(r, 500));

      const diags = client.getDiagnosticsForFile(absPath);
      if (diags.length === 0) {
        return {
          content: [{ type: "text", text: "No diagnostics found." }],
          details: { file: params.path, diagnosticCount: 0 },
        };
      }

      const formatted = formatDiagnostics(params.path, diags);
      return {
        content: [{ type: "text", text: formatted }],
        details: { file: params.path, diagnosticCount: diags.length },
      };
    } else {
      // Workspace diagnostics
      const allDiags = manager.getAllDiagnostics();
      if (allDiags.length === 0) {
        return {
          content: [{ type: "text", text: "No diagnostics found." }],
          details: { diagnosticCount: 0 },
        };
      }

      return {
        content: [{ type: "text", text: allDiags.join("\n") }],
        details: { diagnosticCount: allDiags.length },
      };
    }
  },

  renderResult(result, _options, theme) {
    // Colorize: error=red, warning=yellow, info=blue, hint=dim
  },
};

// Factory for subagent registry
export function createLspDiagnosticsTool(cwd: string): AgentTool<typeof lspDiagnosticsSchema> {
  return {
    name: "lsp_diagnostics",
    label: "lsp_diagnostics",
    sideEffects: false,
    description: lspDiagnosticsDefinition.description,
    parameters: lspDiagnosticsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate) {
      // Same logic but uses factory cwd instead of ctx.cwd
    },
  };
}
```

**Output format for diagnostics:**
```
{relative_path}:{line}:{character} [{severity}] {message}
```

Where severity is one of: `error`, `warning`, `info`, `hint`. Lines and characters are **1-indexed** in output (converted from LSP's 0-indexed).

#### 4.5.2 lsp_definition (`tools/lsp-definition.ts`)

```typescript
const lspDefinitionSchema = Type.Object({
  path: Type.String({ description: "File containing the symbol" }),
  line: Type.Number({ description: "1-indexed line number" }),
  character: Type.Number({ description: "1-indexed character offset" }),
});

export interface LspDefinitionDetails {
  locations: Array<{ file: string; line: number; character: number }>;
}

export const lspDefinitionDefinition: ToolDefinition<typeof lspDefinitionSchema, LspDefinitionDetails> = {
  name: "lsp_definition",
  label: "LSP Definition",
  description: "Find where a symbol is defined. Returns the file path and line. More accurate than grep -- resolves overloads, scopes, and namespaces correctly.",
  parameters: lspDefinitionSchema,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const manager = getLspManager();
    const absPath = resolve(ctx.cwd, params.path);
    const client = manager.getClientForFile(absPath);

    if (!client) {
      return {
        content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
        details: { locations: [] },
      };
    }

    // Convert from 1-indexed (tool API) to 0-indexed (LSP protocol)
    const locations = await client.getDefinition(absPath, params.line - 1, params.character - 1);

    if (locations.length === 0) {
      return {
        content: [{ type: "text", text: "No definition found." }],
        details: { locations: [] },
      };
    }

    // Convert back to 1-indexed for output
    const formatted = locations.map(loc => {
      const relPath = relative(ctx.cwd, loc.file);
      return `${relPath}:${loc.line + 1}:${loc.character + 1}`;
    });

    return {
      content: [{ type: "text", text: formatted.join("\n") }],
      details: {
        locations: locations.map(loc => ({
          file: relative(ctx.cwd, loc.file),
          line: loc.line + 1,
          character: loc.character + 1,
        })),
      },
    };
  },
};

export function createLspDefinitionTool(cwd: string): AgentTool<typeof lspDefinitionSchema> {
  // Same as definition but uses factory cwd
}
```

#### 4.5.3 lsp_references (`tools/lsp-references.ts`)

```typescript
const lspReferencesSchema = Type.Object({
  path: Type.String({ description: "File containing the symbol" }),
  line: Type.Number({ description: "1-indexed line number" }),
  character: Type.Number({ description: "1-indexed character offset" }),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "Include the declaration itself. Default: true" })
  ),
});

export interface LspReferencesDetails {
  referenceCount: number;
  locations: Array<{ file: string; line: number; character: number }>;
}

export const lspReferencesDefinition: ToolDefinition<typeof lspReferencesSchema, LspReferencesDetails> = {
  name: "lsp_references",
  label: "LSP References",
  description: "Find all references to a symbol across the workspace. More accurate than grep -- ignores comments, strings, and same-named symbols in different scopes.",
  parameters: lspReferencesSchema,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const manager = getLspManager();
    const absPath = resolve(ctx.cwd, params.path);
    const client = manager.getClientForFile(absPath);

    if (!client) {
      return {
        content: [{ type: "text", text: `No LSP server available for ${params.path}` }],
        details: { referenceCount: 0, locations: [] },
      };
    }

    const includeDecl = params.includeDeclaration !== false; // default true
    const locations = await client.getReferences(
      absPath, params.line - 1, params.character - 1, includeDecl
    );

    if (locations.length === 0) {
      return {
        content: [{ type: "text", text: "No references found." }],
        details: { referenceCount: 0, locations: [] },
      };
    }

    const formatted = locations.map(loc => {
      const relPath = relative(ctx.cwd, loc.file);
      return `${relPath}:${loc.line + 1}:${loc.character + 1}`;
    });

    return {
      content: [{ type: "text", text: `${locations.length} references:\n${formatted.join("\n")}` }],
      details: {
        referenceCount: locations.length,
        locations: locations.map(loc => ({
          file: relative(ctx.cwd, loc.file),
          line: loc.line + 1,
          character: loc.character + 1,
        })),
      },
    };
  },
};

export function createLspReferencesTool(cwd: string): AgentTool<typeof lspReferencesSchema> {
  // Same as definition but uses factory cwd
}
```

---

## 5. Feature Setup (`features/lsp/index.ts`)

```typescript
import type { AgentSession } from "../agent-session.js";
import { getLspManager, disposeLspManager } from "./manager.js";
import { detectAndSetup, detectLanguages, installMissingServers } from "./language-detector.js";

export { getLspManager, disposeLspManager } from "./manager.js";
export { LspManager } from "./manager.js";
export { LspClient } from "./client.js";

/**
 * Setup LSP feature hooks.
 * Called from AgentSession initialization.
 */
export function setupLspFeature(session: AgentSession): void {
  const manager = getLspManager();

  // 1. Session start → detect languages, start ready servers
  session.onSessionStart(async (ctx) => {
    try {
      const readyLanguages = await detectAndSetup(ctx.cwd);
      for (const lang of readyLanguages) {
        await manager.startServer(lang.key, lang.config, ctx.cwd);
      }
      // Update status bar
      if (manager.hasActiveServers()) {
        const names = manager.getActiveServerNames();
        ctx.ui?.setStatus("lsp", names.join(" | "));
      }
    } catch (err) {
      // Non-fatal: LSP failure shouldn't prevent agent from working
      console.error("LSP setup failed:", err);
    }
  });

  // 2. Session shutdown → stop all servers
  session.onSessionShutdown(async () => {
    await disposeLspManager();
  });

  // 3. File change notification → keep LSP in sync
  // After edit or write tool completes, notify the relevant LSP server
  session.onToolResult(async (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const filePath = (event.input as Record<string, unknown>)?.path;
      if (typeof filePath === "string") {
        try {
          await manager.notifyFileChanged(filePath);
        } catch {
          // Non-fatal: LSP notification failure shouldn't break the agent
        }
      }
    }
  });
}
```

---

## 6. Slash Commands and UI

### 6.1 `/lsp-setup` Command

Interactive language detection and server installation.

```typescript
// Registered via internal extension wrapper (same pattern as bg spec Section 3.9)

pi.registerCommand("lsp-setup", {
  description: "Detect project languages and install missing LSP servers",
  async handler(args, ctx) {
    const manager = getLspManager();

    // Stop existing servers
    await manager.stopAll();

    // Detect all languages
    const languages = await detectLanguages(ctx.cwd);

    if (languages.length === 0) {
      ctx.ui.notify("No supported languages detected in project", "info");
      return;
    }

    // Interactive installation
    const readyLanguages = await installMissingServers(
      languages,
      (title, msg) => ctx.ui.confirm(title, msg),
      (msg, type) => ctx.ui.notify(msg, type),
      (cmd) => exec(cmd),
    );

    // Start ready servers
    for (const lang of readyLanguages) {
      await manager.startServer(lang.key, lang.config, ctx.cwd);
    }

    // Update status
    if (manager.hasActiveServers()) {
      const names = manager.getActiveServerNames();
      ctx.ui.setStatus("lsp", names.join(" | "));
      ctx.ui.notify(`LSP servers active: ${names.join(", ")}`, "info");
    } else {
      ctx.ui.setStatus("lsp", undefined);
      ctx.ui.notify("No LSP servers could be started", "warning");
    }
  },
});
```

### 6.2 `/lsp-status` Command

Show active LSP server status.

```typescript
pi.registerCommand("lsp-status", {
  description: "Show LSP server status",
  async handler(args, ctx) {
    const manager = getLspManager();
    const names = manager.getActiveServerNames();

    if (names.length === 0) {
      ctx.ui.notify("No active LSP servers. Run /lsp-setup to configure.", "info");
    } else {
      ctx.ui.notify(`Active: ${names.join(", ")}`, "info");
    }
  },
});
```

### 6.3 Status Bar

When LSP servers are active, show in status bar:
```
typescript-language-server LSP | pylsp LSP
```

Updated via `ctx.ui.setStatus("lsp", text)` during session_start and /lsp-setup.

---

## 7. Tool Registration

### 7.1 In tools/index.ts (for subagent access)

```diff
+ import { createLspDiagnosticsTool } from "./lsp-diagnostics.js";
+ import { createLspDefinitionTool } from "./lsp-definition.js";
+ import { createLspReferencesTool } from "./lsp-references.js";

  const _toolRegistry = {
    read: (cwd: string) => createReadTool(cwd),
    bash: (cwd: string) => createBashTool(cwd),
    edit: (cwd: string) => createEditTool(cwd),
    write: (cwd: string) => createWriteTool(cwd),
    search: (cwd: string) => createSearchTool(cwd),
    webfetch: (_cwd: string) => createWebfetchTool(),
    websearch: (_cwd: string) => createWebsearchTool(),
+   bg: (cwd: string) => createBgTool(cwd),
+   lsp_diagnostics: (cwd: string) => createLspDiagnosticsTool(cwd),
+   lsp_definition: (cwd: string) => createLspDefinitionTool(cwd),
+   lsp_references: (cwd: string) => createLspReferencesTool(cwd),
  };
```

### 7.2 In AgentSession (for main agent with ExtensionContext)

```typescript
import { lspDiagnosticsDefinition } from "./tools/lsp-diagnostics.js";
import { lspDefinitionDefinition } from "./tools/lsp-definition.js";
import { lspReferencesDefinition } from "./tools/lsp-references.js";

this._customTools = [
  ...(config.customTools ?? []),
  askUserTool as unknown as ToolDefinition,
  bgToolDefinition as unknown as ToolDefinition,
  lspDiagnosticsDefinition as unknown as ToolDefinition,
  lspDefinitionDefinition as unknown as ToolDefinition,
  lspReferencesDefinition as unknown as ToolDefinition,
];
```

---

## 8. Subagent Behavior

### 8.1 Isolation Model

Each subagent process creates its own LspManager singleton. When a subagent starts:

1. Subagent spawns with `--tools read,bash,lsp_diagnostics,lsp_definition,lsp_references`
2. `createLspDiagnosticsTool(cwd)` etc. are created from factory
3. These tools access `getLspManager()` which creates a new LspManager in the subagent process
4. **LSP servers are NOT auto-started for subagents** — the `session_start` hook only runs for the main agent session
5. Subagent LSP tools will return "No LSP servers active" unless the subagent's session also triggers setup

### 8.2 Subagent LSP Server Sharing

Since subagent tools call `getLspManager()` in their own process, they get an empty manager by default. Two approaches:

**Approach A (Recommended): Lazy server start on first tool use**

When a subagent's LSP tool is called and no server is active, automatically detect and start the relevant server:

```typescript
// In createLspDiagnosticsTool factory:
async execute(_toolCallId, params, _signal, _onUpdate) {
  const manager = getLspManager();

  // Lazy init: start server for this file if needed
  if (!manager.hasActiveServers()) {
    const languages = await detectAndSetup(cwd);
    for (const lang of languages) {
      await manager.startServer(lang.key, lang.config, cwd);
    }
  }

  // ... proceed with diagnostics
}
```

**Approach B: Accept limitation**

Subagent LSP tools return "No LSP servers active" — the subagent would need to be told to run `/lsp-setup` first. Less convenient but simpler.

**Decision: Use Approach A** — lazy initialization on first use. This provides the best subagent experience without explicit setup.

### 8.3 LSP Server Process Sharing

Multiple LspClient instances (from different pi processes) can connect to separate instances of the same LSP server. Each pi process spawns its own server process. This is slightly wasteful but avoids cross-process state sharing complexity.

When a subagent exits:
1. Its LspManager.stopAll() is called (via process exit handler)
2. All server processes spawned by that subagent are terminated
3. Main agent's LSP servers are unaffected

---

## 9. Edge Cases and Error Handling

### 9.1 Server Crash Recovery
- If an LSP server process crashes (unexpected exit), LspClient sets `initialized = false`
- Next tool call to that client returns "No LSP server available"
- User can run `/lsp-setup` to restart
- No automatic restart (intentional: crashes may indicate config issues)

### 9.2 Server Installation Failure
- Installation timeout: 120 seconds
- Non-zero exit code: show stderr/stdout to user via notification
- Missing runtime: warn user with install URL, don't attempt server install

### 9.3 File Not Found
- If `readFile()` fails during `notifyFileChanged()`: silently skip (file may have been deleted)
- If tool receives a path that doesn't exist: return "File not found" error

### 9.4 Slow Server Initialization
- `lsp_diagnostics` waits 500ms after `ensureOpen()` for diagnostics to arrive
- If server hasn't finished initializing, `getDefinition`/`getReferences` return empty results
- InitializeRequest has no explicit timeout (relies on general process timeout)

### 9.5 Unsupported Language
- Tool returns "No LSP server available for {file}" — not an error, just informational
- Encourages user to check `/lsp-status` or run `/lsp-setup`

### 9.6 Large Workspaces
- Language detection limited to `find -maxdepth 3` (doesn't scan deeply)
- Excluded directories list prevents scanning into node_modules, .git, etc.
- LSP server indexing may take time for large projects (server-specific behavior)

### 9.7 Concurrent Tool Calls
- Multiple concurrent `lsp_diagnostics` calls are safe (diagnosticsMap is read-only from tools)
- Multiple concurrent `lsp_definition`/`lsp_references` calls are serialized by the LSP protocol connection
- `notifyFileChanged` is fire-and-forget, doesn't block tool execution

---

## 10. Required Changes Summary

### 10.1 New Files

| File | Purpose | LOC (estimate) |
|------|---------|----------------|
| `features/lsp/index.ts` | Feature setup + exports | ~60 |
| `features/lsp/manager.ts` | LspManager + singleton | ~120 |
| `features/lsp/client.ts` | LspClient protocol handler | ~250 |
| `features/lsp/language-configs.ts` | Language config definitions | ~300 |
| `features/lsp/language-detector.ts` | Detection + installation | ~200 |
| `tools/lsp-diagnostics.ts` | Tool definition + factory | ~100 |
| `tools/lsp-definition.ts` | Tool definition + factory | ~80 |
| `tools/lsp-references.ts` | Tool definition + factory | ~80 |
| **Total** | | **~1,190** |

### 10.2 Modified Files

| File | Change |
|------|--------|
| `tools/index.ts` | Add 3 LSP tools to `_toolRegistry` |
| `agent-session.ts` | Add 3 LSP ToolDefinitions to `_customTools`, call `setupLspFeature()` |
| `package.json` | Add `vscode-languageserver-protocol` and `vscode-jsonrpc` dependencies |

### 10.3 Process Exit Handlers

```typescript
// In features/lsp/index.ts or manager.ts
process.on("exit", () => {
  // Synchronous: kill all server processes
  const manager = getLspManager();
  manager.killAll();  // Synchronous SIGKILL variant
});

process.on("SIGTERM", async () => {
  await disposeLspManager();
  process.exit(0);
});
```

---

## 11. Migration Checklist

- [ ] Add `vscode-languageserver-protocol` and `vscode-jsonrpc` to `packages/coding-agent/package.json`
- [ ] Run `npm install` to update lockfile
- [ ] Create `packages/coding-agent/src/core/features/lsp/` directory
- [ ] Implement `language-configs.ts` (Tier 1 + Tier 2 configs)
- [ ] Implement `client.ts` (LspClient with protocol connection)
- [ ] Implement `manager.ts` (LspManager + singleton)
- [ ] Implement `language-detector.ts` (detection + installation)
- [ ] Implement `index.ts` (feature setup)
- [ ] Implement `tools/lsp-diagnostics.ts` (tool definition + factory)
- [ ] Implement `tools/lsp-definition.ts` (tool definition + factory)
- [ ] Implement `tools/lsp-references.ts` (tool definition + factory)
- [ ] Update `tools/index.ts` (add 3 tools to registry)
- [ ] Update `agent-session.ts` (add tools to _customTools, call setupLspFeature)
- [ ] Register `/lsp-setup` command
- [ ] Register `/lsp-status` command
- [ ] Wire up status bar display
- [ ] Add process exit handlers for server cleanup
- [ ] Test: lsp_diagnostics returns TypeScript errors
- [ ] Test: lsp_definition navigates to symbol definition
- [ ] Test: lsp_references finds all usages
- [ ] Test: file edit triggers notifyFileChanged
- [ ] Test: /lsp-setup interactive installation
- [ ] Test: /lsp-status shows active servers
- [ ] Test: subagent can use LSP tools via --tools lsp_diagnostics
- [ ] Test: subagent lazy-starts LSP server on first tool use
- [ ] Test: subagent exit stops its LSP servers
- [ ] Test: main agent LSP servers survive subagent exit
- [ ] Test: server crash handled gracefully
- [ ] Remove `.pi/extensions/lsp-tools/` after migration verified
- [ ] Run `npm run check` — no errors

---

## 12. Open Questions

1. **Diagnostic delay:** The current implementation waits 500ms after `ensureOpen()` for diagnostics to arrive. Is this sufficient for large projects? Should we implement a polling mechanism with timeout instead?

2. **Bun binary bundling:** `vscode-languageserver-protocol` imports from `./node.js` subpath. Need to verify this works correctly with Bun's bundler for the compiled binary. May need explicit `--external` flags.

3. **Server deduplication across features:** If both the main agent and a subagent try to start `typescript-language-server`, they'll get separate server processes. For most servers this is fine, but some (like jdtls) may have workspace locking. Should we document which servers support multiple instances?

4. **Language detection performance:** The `find` commands for 12+ languages at startup could be slow on network filesystems. Should we cache detection results in `.pi/lsp-cache.json`?
