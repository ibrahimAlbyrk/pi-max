# Extensions to Built-in Migration Analysis Report

**Date:** 2026-03-06
**Scope:** 10 extensions → packages/coding-agent built-in features
**Total Extension Code:** ~17,672+ LOC across 95+ files

---

## 1. Executive Summary

This report provides the technical analysis for migrating 10 extensions from `.pi/extensions/` into `packages/coding-agent` as built-in features. Primary motivation: **subagents cannot access extension tools** — because each subagent is spawned as a separate `pi` process and the extension system only runs inside the main agent.

Once built-in:
- Subagents can access all tools via `--tools bg,task,lsp_diagnostics`
- Users get all features without `.pi/extensions/` setup
- Extension loading overhead (jiti dynamic import) is eliminated

---

## 2. Extension Inventory

| Extension | Files | LOC | Tools | Hooks | npm Deps | Complexity |
|-----------|-------|-----|-------|-------|----------|------------|
| background-process | 3 | 1,631 | `bg` | 3 | - | Medium |
| dynamic-prompt-system | 23 | 4,150 | - | 6 | - | High |
| lsp-tools | 6 | 1,776 | `lsp_diagnostics`, `lsp_definition`, `lsp_references` | 3 | vscode-languageserver-protocol, vscode-jsonrpc | High |
| task-management | 55 | 8,000+ | `task` | 7 | - | Very High |
| notification | 2 | 170 | - | 4 | - | Low |
| prompt-history-search | 1 | 430 | - | 1 | - | Low |
| restrictions | 1 | 555 | - | 2 | - | Medium |
| file-browser | 1 | 530 | - | 0 | - | Low |
| image-markers | 1 | 305 | - | 4 | - | Low |
| diff | 1 | 125 | - | 0 | - | Low |

---

## 3. Architectural Analysis: Extension vs Built-in

### 3.1 Current Extension System

```
Extension (.pi/extensions/*.ts)
    ↓ jiti dynamic import
ExtensionAPI (pi.registerTool, pi.on, pi.registerCommand, ...)
    ↓
ExtensionRunner (tool wrapping, event emission)
    ↓
AgentSession._toolRegistry (built-in + extension tools merged)
    ↓
LLM (tools available in context)
```

**Critical limitation:** Subagents run via `spawn("pi", ["--tools", "read,bash"])`. The `--tools` flag only accepts built-in tool names. Extension tools cannot be passed to subagents.

### 3.2 After Built-in Migration

```
packages/coding-agent/src/core/tools/
    ├── bash.ts            (existing)
    ├── read.ts            (existing)
    ├── edit.ts            (existing)
    ├── write.ts           (existing)
    ├── search.ts          (existing)
    ├── webfetch.ts        (existing)
    ├── websearch.ts       (existing)
    ├── bg.ts              (NEW)
    ├── task.ts            (NEW)
    ├── lsp-diagnostics.ts (NEW)
    ├── lsp-definition.ts  (NEW)
    ├── lsp-references.ts  (NEW)
    └── ...

packages/coding-agent/src/core/features/
    ├── notification/
    ├── restrictions/
    ├── prompt-history-search/
    ├── file-browser/
    ├── image-markers/
    ├── diff/
    └── dynamic-prompt-system/
```

---

## 4. Categorization: Two Distinct Types

### 4.1 Tool-Based Extensions (Critical for subagent access)

These register LLM-callable tools. Once built-in, subagents can also use them.

| Extension | Tool(s) | Subagent Impact |
|-----------|---------|-----------------|
| **background-process** | `bg` | Subagents can start/stop processes |
| **lsp-tools** | `lsp_diagnostics`, `lsp_definition`, `lsp_references` | Subagents can navigate code |
| **task-management** | `task` | Subagents can create/update tasks |

### 4.2 Hook/UI-Only Extensions (For user experience)

These don't register tools — they only provide hooks and TUI. Subagent access isn't needed but built-in status simplifies user setup.

| Extension | Function | Why Built-in |
|-----------|----------|--------------|
| **dynamic-prompt-system** | System prompt composition | Required for every pi user |
| **restrictions** | Tool call interception | Security layer, should always be active |
| **notification** | Agent completion alerts | UX improvement |
| **prompt-history-search** | History search | Core TUI feature |
| **file-browser** | File explorer | Core TUI feature |
| **image-markers** | Image pasting | Core editor feature |
| **diff** | Git diff viewing | Core developer tool |

---

## 5. Per-Extension Detailed Analysis

### 5.1 background-process (1,631 LOC)

**What it does:** Start/stop/log background processes via the `bg` tool. ProcessPanel TUI component, editor badge.

**Built-in strategy:**
- `src/core/tools/bg.ts` — Tool factory function (createBgTool)
- `src/core/features/bg/manager.ts` — ProcessManager class (RingBuffer, lifecycle tracking)
- `src/core/features/bg/panel.ts` — TUI component

**Challenges:**
- ProcessManager must be singleton within a process (multiple agents share the same pool)
- Session shutdown hook still required (process cleanup)
- Editor badge animation depends on TUI event loop
- Integration with task-management exists (`task:completed` event stops linked processes)

**Risk:** Low. Well-isolated with clear boundaries.

### 5.2 lsp-tools (1,776 LOC)

**What it does:** Manages LSP servers (TypeScript, Python, Go, Rust, C#, etc.). 3 tools: diagnostics, definition, references.

**Built-in strategy:**
- `src/core/tools/lsp-diagnostics.ts`, `lsp-definition.ts`, `lsp-references.ts` — 3 separate tools
- `src/core/features/lsp/` — Manager, client, language configs

**Challenges:**
- **npm dependencies:** `vscode-languageserver-protocol` and `vscode-jsonrpc` must be added to coding-agent's package.json
- **Bundle size increase:** These two packages add ~500KB+
- LSP servers run as background processes — must tie into session lifecycle
- Language detection does filesystem scanning (startup overhead)
- `tool_result` hook for file change notification — must integrate into agent-session

**Risk:** Medium. External dependencies and process management complexity.

### 5.3 task-management (8,000+ LOC, 55 files)

**What it does:** Full project task management — CRUD, sprints, dependencies, kanban, intelligence, import/export, automation.

**Built-in strategy:**
- `src/core/tools/task.ts` — Tool factory (action dispatcher)
- `src/core/features/task/` — All submodules (actions, hierarchy, sprints, intelligence, etc.)

**Challenges:**
- **Largest extension** — 55 files, 8000+ LOC
- Complex file structure: `.pi/tasks/` directory with per-file persistence
- Session-aware state reconstruction (preventing state loss on branch/fork)
- Inter-extension communication: `task:completed` event linked to background-process
- Kanban board TUI component is quite comprehensive
- Intelligence module (analyzer, prioritizer) may be LLM-dependent
- Compaction handler does custom session management

**Risk:** High. Most complex extension, requires the most refactoring.

### 5.4 dynamic-prompt-system (4,150 LOC, 23 files)

**What it does:** 4-layer (L0-L4) dynamic system prompt composition. Condition engine, variable resolver, segment registry.

**Built-in strategy:**
- Current `system-prompt.ts` and DPS extension will be **completely replaced**
- A new, clean system prompt pipeline will be designed from scratch
- Good aspects from DPS (condition engine, segment registry, layer system) will be incorporated via a clean API
- Current YAML parser (480 LOC) should be replaced with a more minimal approach

**Challenges:**
- Requires from-scratch design — copy-pasting the current DPS is insufficient
- Condition engine (15+ condition types) is complex but useful — need to decide which ones to keep
- L4 reminders (message injection) must be integrated directly into agent-session
- Segment override chain (builtin < global < project) must be preserved

**Risk:** High. All prompt quality depends on this pipeline. Writing from scratch is cleaner but requires more design effort.

### 5.5 restrictions (555 LOC)

**What it does:** Tool call interception — tool disable, read-only mode, filesystem path restrictions, bash command restrictions.

**Built-in strategy:**
- `src/core/features/restrictions/` — Config loading, validation, glob matching
- Must integrate into agent-session's tool wrapping pipeline

**Challenges:**
- Works via `tool_call` hook — built-in mechanism will differ
- Config merge logic (global + project layers)
- Glob pattern → regex conversion
- Turn-scoped file check cache

**Risk:** Low-Medium. Security-critical — incorrect refactoring could cause restriction bypass.

### 5.6 notification (170 LOC)

**What it does:** OS notification and sound on agent completion.

**Built-in strategy:**
- `src/core/features/notification.ts` — Single file sufficient

**Challenges:**
- Cross-platform sound playback (macOS/Linux/fallback)
- OS notification APIs (osascript/notify-send)
- Config persistence (`appendEntry`)

**Risk:** Very Low. Simplest extension.

### 5.7 prompt-history-search (430 LOC)

**What it does:** Fuzzy search through past prompts.

**Built-in strategy:**
- `src/core/features/prompt-history-search.ts` — Single file

**Challenges:**
- SelectList overlay TUI
- File-based cache (mtime tracking)
- Session file format parsing

**Risk:** Low.

### 5.8 file-browser (530 LOC)

**What it does:** Interactive file explorer overlay.

**Built-in strategy:**
- `src/core/features/file-browser.ts` — Single file

**Challenges:**
- Recursive search (depth limit 5, max 100)
- Clipboard integration (platform-specific)
- @ref insertion depends on editor

**Risk:** Low.

### 5.9 image-markers (305 LOC)

**What it does:** Clipboard image pasting, base64 encoding, sending to LLM.

**Built-in strategy:**
- `src/core/features/image-markers.ts` — Single file

**Challenges:**
- CustomEditor extension — depends on editor pipeline
- /tmp file management (cleanup?)
- `input` hook for message transformation

**Risk:** Low.

### 5.10 diff (125 LOC)

**What it does:** Git status display and file opening.

**Built-in strategy:**
- `src/core/features/diff.ts` — Single file

**Challenges:** Nearly none. Simplest extension.

**Risk:** Very Low.

---

## 6. Technical Challenges and Obstacles

### 6.1 Hook System Changes

Current extensions register hooks via `pi.on("event", handler)`. When built-in:
- Hook handlers must connect directly to agent-session
- Event emission order must be guaranteed (currently depends on extension load order)
- **Solution:** Create a `BuiltinFeature` interface — a subset of the extension API

### 6.2 TUI Component Access

Extensions create overlays via `ctx.ui.custom()`. As built-in:
- Direct access to TUI context required
- TUI primitives (DynamicBorder, SelectList, Container) must be imported
- **Solution:** TUI context injection pattern for built-in features

### 6.3 Inter-Feature Communication

- `background-process` ↔ `task-management`: `task:completed` event
- `dynamic-prompt-system` → `system-prompt.ts`: prompt composition
- `restrictions` → tool pipeline: tool_call interception
- **Solution:** Internal event bus or direct function calls (instead of extension event bus)

### 6.4 Bundle Size Increase

| New Dependency | Estimated Size | Source | Status |
|----------------|---------------|--------|--------|
| vscode-languageserver-protocol | ~300KB | lsp-tools | Required |
| vscode-jsonrpc | ~200KB | lsp-tools | Required |
| **Total** | **~500KB** | | |

These will be required dependencies of coding-agent. Other extensions have no external dependencies — they only use Node.js stdlib.

### 6.5 Subagent Tool Passing Changes

Current `tools/index.ts` tool registry:
```typescript
const _toolRegistry = {
  read: ..., bash: ..., edit: ..., write: ..., search: ..., webfetch: ..., websearch: ...
};
```

Needs to be extended:
```typescript
const _toolRegistry = {
  // Existing
  read: ..., bash: ..., edit: ..., write: ..., search: ..., webfetch: ..., websearch: ...,
  // New built-in tools
  bg: (cwd) => createBgTool(cwd),
  task: (cwd) => createTaskTool(cwd),
  lsp_diagnostics: (cwd) => createLspDiagnosticsTool(cwd),
  lsp_definition: (cwd) => createLspDefinitionTool(cwd),
  lsp_references: (cwd) => createLspReferencesTool(cwd),
};
```

Subagents can then use `--tools read,bash,lsp_diagnostics,task`.

### 6.6 State Management: Isolated Per-Process

Each process (main agent or subagent) manages its own state:

- **LSP Manager:** Each process starts its own LSP client. Multiple clients can connect to the same LSP server — the LSP protocol supports this.
- **ProcessManager:** Each process has an isolated pool. When a subagent exits, all processes in its pool are automatically terminated. The main agent's pool is unaffected.
- **TaskStore:** File-based persistence (`.pi/tasks/`). All processes read/write the same files — file-level locking or last-write-wins strategy may be needed.

### 6.7 Extension API Backward Compatibility

After built-in migration, duplicate extensions in `.pi/extensions/` could cause conflicts.
- **Decision:** Built-in always wins. Same-named extensions are skipped and a warning is logged. Built-in tool/command names are reserved.

---

## 7. Benefits and Risks Analysis

### 7.1 Benefits

| Benefit | Impact | Description |
|---------|--------|-------------|
| **Subagent tool access** | Critical | `bg`, `task`, `lsp_*` tools become usable in subagents |
| **Zero-config experience** | High | Users get all features without extension setup |
| **Startup performance** | Medium | No jiti dynamic import overhead (10 extensions x ~50ms = ~500ms gain) |
| **Single source of truth** | High | Extension versioning/compatibility issues eliminated |
| **Testability** | High | Built-in features can be tested in CI; extensions are not tested |
| **Type safety** | Medium | Compile-time type checking (jiti gives errors at runtime) |
| **Bundle consistency** | High | Included in Bun binary, no external file dependencies |

### 7.2 Risks / Downsides

| Risk | Impact | Description |
|------|--------|-------------|
| **Bundle size increase** | Medium | ~500KB (LSP deps) + ~17K LOC → estimated +1-2MB compiled |
| **Modularity loss** | Low | Extension system was "opt-in", built-in is "always-on" — no opt-out |
| **Refactoring volume** | High | 95+ files, 17K+ LOC to move + adapt |
| **DPS integration risk** | High | System prompt pipeline failure affects all agent quality |
| **Regression risk** | Medium | Worked as extension, may behave differently as built-in |
| **Maintenance burden** | Medium | All features now core team responsibility |
| **Flexibility loss** | Low | Built-in wins — users cannot override with same-named extensions |

### 7.3 Net Assessment

**Benefits clearly outweigh the risks.** The primary motivation (subagent tool access) alone justifies this change. However, migration should be phased — small, testable steps rather than one massive PR.

---

## 8. Recommended Migration Strategy

### Phase 1: Tool-Based Extensions (Priority: Critical)

The most important ones for subagent access should be migrated first:

1. **background-process** → `src/core/tools/bg.ts` + `src/core/features/bg/`
2. **lsp-tools** → `src/core/tools/lsp-*.ts` + `src/core/features/lsp/`
3. **task-management** → `src/core/tools/task.ts` + `src/core/features/task/`

For each:
- Create tool factory function (createXxxTool pattern)
- Add to `_toolRegistry`
- Integrate hook handlers into agent-session
- Move TUI components under `src/core/features/`

### Phase 2: Core UX Features (Priority: High)

4. **restrictions** → `src/core/features/restrictions/` (security layer)
5. **image-markers** → `src/core/features/image-markers.ts` (editor integration)
6. **notification** → `src/core/features/notification.ts` (agent completion)

### Phase 3: TUI Enhancements (Priority: Medium)

7. **prompt-history-search** → `src/core/features/prompt-history-search.ts`
8. **file-browser** → `src/core/features/file-browser.ts`
9. **diff** → `src/core/features/diff.ts`

### Phase 4: System Prompt Pipeline — Full Rewrite (Priority: High but risky)

10. **dynamic-prompt-system** → Current `system-prompt.ts` + DPS extension completely replaced

A clean system prompt pipeline will be designed from scratch. Good aspects from the current DPS (condition engine, segment registry, variable resolver) will be incorporated but the architecture will be built fresh. Most risky phase — should be handled as a separate sprint with comprehensive testing.

---

## 9. Built-in Feature Interface Design Proposal

As a subset of the extension API:

```typescript
interface BuiltinFeature {
  name: string;

  // Lifecycle
  onSessionStart?(session: AgentSession): void;
  onSessionShutdown?(session: AgentSession): void;

  // Tools (registered at startup)
  tools?: AgentTool[];

  // Commands
  commands?: SlashCommand[];

  // Shortcuts
  shortcuts?: KeyboardShortcut[];

  // Hooks
  onBeforeAgentStart?(event: BeforeAgentStartEvent): BeforeAgentStartResult | void;
  onToolCall?(event: ToolCallEvent): ToolCallResult | void;
  onToolResult?(event: ToolResultEvent): ToolResultResult | void;
  onContext?(event: ContextEvent): ContextResult | void;
  onTurnEnd?(event: TurnEndEvent): void;
  onInput?(event: InputEvent): InputResult | void;
}
```

This interface is a streamlined version of the extension API for built-in features. Uses direct method implementation instead of `pi.on()` event subscription.

---

## 10. Design Decisions (Finalized)

1. **DPS → New system prompt pipeline from scratch:** Current `buildSystemPrompt()` and DPS extension will be completely replaced. A cleaner architecture will be planned and built from scratch. This eliminates the complexity of the current system-prompt.ts while incorporating the good aspects of DPS (condition engine + segment registry + layer system) via a clean API.

2. **No opt-out:** Built-in features are always active. Since agents are already told which tools to use, unnecessary tool usage won't occur. A disable mechanism is unnecessary complexity.

3. **Built-in wins:** If a user places an extension with the same name as a built-in in `.pi/extensions/`, the built-in version takes priority. The extension is skipped (warning may be logged).

4. **LSP dependencies required:** `vscode-languageserver-protocol` and `vscode-jsonrpc` will be required dependencies of coding-agent. Optional dependency complexity is unnecessary.

5. **Task storage stays in place:** `.pi/tasks/` directory remains in its current location. Per-file persistence under `.pi/tasks/` in the project directory continues.

6. **Process manager isolated:** Each subagent has its own process pool. When a subagent exits, all `bg` processes it started are automatically terminated. The main agent's pool is unaffected. This ensures clean cleanup and predictable lifecycle.

---

## 11. Estimated Effort

| Extension | Estimated Effort | Notes |
|-----------|-----------------|-------|
| diff | 2 hours | Simple TUI, no hooks |
| notification | 3 hours | Cross-platform logic, config persistence |
| file-browser | 4 hours | TUI overlay, clipboard |
| prompt-history-search | 4 hours | Cache logic, TUI overlay |
| image-markers | 4 hours | Editor integration, input hook |
| restrictions | 6 hours | Security-critical, careful testing required |
| background-process | 8 hours | Process management, TUI panel, badge |
| lsp-tools | 12 hours | External deps, process management, protocol |
| task-management | 20+ hours | 55 files, complex state, many hooks |
| dynamic-prompt-system | 16 hours | System prompt pipeline integration |
| **TOTAL** | **~79+ hours** | |

---

## 12. Conclusion

This migration is large but necessary. The most important gain is **subagent tool access** — this fundamentally strengthens pi's agent orchestration capabilities. The second major gain is **zero-config user experience**.

Recommended approach: phased migration, starting with tool-based extensions, testing each phase independently. DPS integration should be left for last as it's the riskiest and requires the deepest system changes.
