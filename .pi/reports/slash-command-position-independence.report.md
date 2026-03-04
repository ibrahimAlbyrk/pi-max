# Slash Command Position Independence Analysis

**Date**: 2026-03-04  
**Scope**: `/skill:name` and `/prompt:name` (template) slash invocations -- making them work at any cursor position, not just the start of input.  
**Out of scope**: Built-in commands like `/export`, `/compact`, `/settings` etc. which should remain start-only.

---

## Current Architecture

### 1. Two Distinct Slash Command Categories

The system has two fundamentally different types of `/`-prefixed items:

| Category | Examples | Behavior | Where Handled |
|----------|----------|----------|---------------|
| **Built-in commands** | `/export`, `/compact`, `/settings`, `/model`, `/quit` | Execute immediately, clear editor, don't send to LLM | `interactive-mode.ts:2055-2170` (giant if/else chain in `setupEditorSubmitHandler`) |
| **Invocations** (skill/prompt) | `/skill:frontend-design`, `/git:commit` | Expanded into text, then sent to LLM as part of user message | `agent-session.ts:791-795` via `_expandSkillCommand()` + `expandPromptTemplate()` |

**Key insight**: Built-in commands consume the entire input (`text === "/settings"`). Invocations are text transformations -- they replace `/skill:name args` with the skill/template content + args, producing a regular user message.

### 2. Autocomplete Trigger Chain

When the user types a character, the flow is:

```
editor.ts handleInput() → insertCharAtCursor() → character trigger check
```

**File**: `packages/tui/src/components/editor.ts`

#### Auto-trigger for `/` (line 985-987):
```typescript
if (char === "/" && this.isAtStartOfMessage()) {
    this.tryTriggerAutocomplete();
}
```

#### `isAtStartOfMessage()` (line 1897-1901):
```typescript
private isAtStartOfMessage(): boolean {
    if (!this.isSlashMenuAllowed()) return false;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
}
```

#### `isSlashMenuAllowed()` (line 1891-1893):
```typescript
private isSlashMenuAllowed(): boolean {
    return this.state.cursorLine === 0;
}
```

#### Continued typing trigger (line 1003-1008):
```typescript
else if (/[a-zA-Z0-9.\-_]/.test(char)) {
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
    }
}
```

#### `isInSlashCommandContext()` (line 1903-1905):
```typescript
private isInSlashCommandContext(textBeforeCursor: string): boolean {
    return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
}
```

**Restriction points** (why it only works at the start):
1. `isSlashMenuAllowed()` → `cursorLine === 0` (first line only)
2. `isAtStartOfMessage()` → requires the text before cursor to be empty or just "/"
3. `isInSlashCommandContext()` → requires `textBeforeCursor.trimStart()` to start with "/"
4. `getSuggestions()` in `CombinedAutocompleteProvider` → `textBeforeCursor.startsWith("/")`

### 3. Autocomplete Suggestion Logic

**File**: `packages/tui/src/autocomplete.ts`, `CombinedAutocompleteProvider.getSuggestions()` (line 215-275)

```typescript
// Check for slash commands
if (textBeforeCursor.startsWith("/")) {
    const spaceIndex = textBeforeCursor.indexOf(" ");
    if (spaceIndex === -1) {
        // Complete command names
        const prefix = textBeforeCursor.slice(1);
        // ... fuzzy filter all commands ...
    } else {
        // Complete command arguments
    }
}
```

This checks if the **entire line up to cursor** starts with `/`. No concept of mid-text slash commands.

### 4. Apply Completion Logic

**File**: `packages/tui/src/autocomplete.ts`, `CombinedAutocompleteProvider.applyCompletion()` (line 277-340)

```typescript
const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
if (isSlashCommand) {
    const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
    // ...
}
```

Again assumes slash command is at start of line with nothing before it.

### 5. Submit-Time Processing

**File**: `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2055+`

The submit handler first checks all built-in commands:
```typescript
if (text === "/settings") { ... }
if (text === "/model" || text.startsWith("/model ")) { ... }
if (text.startsWith("/export")) { ... }
// ... 20+ more ...
```

If none match, the text goes through `session.prompt(text)`.

**File**: `packages/coding-agent/src/core/agent-session.ts:761-795`

```typescript
async prompt(text: string, options?: PromptOptions): Promise<void> {
    // First: try extension commands (lines 765-771)
    if (expandPromptTemplates && text.startsWith("/")) {
        const handled = await this._tryExecuteExtensionCommand(text);
        if (handled) return;
    }
    
    // Then: expand skills and templates (lines 791-795)
    let expandedText = currentText;
    if (expandPromptTemplates) {
        expandedText = this._expandSkillCommand(expandedText);
        expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
    }
}
```

**`_expandSkillCommand()`** (line 941-963):
```typescript
private _expandSkillCommand(text: string): string {
    if (!text.startsWith("/skill:")) return text;
    // Extract name, read file, wrap in <skill> tags
}
```

**`expandPromptTemplate()`** (prompt-templates.ts:327-355):
```typescript
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
    if (!text.startsWith("/")) return text;
    const spaceIndex = text.indexOf(" ");
    const rawName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    // ... find and expand template ...
}
```

Both use `text.startsWith("/")` -- they expect the **entire message** to start with a slash.

### 6. Visual Feedback

There is **no syntax highlighting** of slash command text in the editor. The visual feedback is:
- **Autocomplete dropdown** appearing when typing `/`
- **Border color** changes for bash mode (`!`) and thinking level, but NOT for slash commands
- The autocomplete item styling (via `SelectList` theme)

---

## What Needs to Change

### Goal
Allow `/skill:name` and `/prompt:template` (but NOT built-in commands like `/export`) to appear anywhere in the input text, with:
1. Autocomplete triggers at any position when typing `/` followed by skill/prompt names
2. Correct completion application (inserting at cursor position, not replacing entire line)
3. Expansion at submit time (finding and expanding all skill/prompt invocations in the text)
4. Optional: visual distinction (coloring) of the invocation tokens in the editor

### Affected Files & Changes

#### Layer 1: Autocomplete Trigger (packages/tui)

**`packages/tui/src/components/editor.ts`**

| Location | Current | Needed |
|----------|---------|--------|
| `isSlashMenuAllowed()` L1891 | `cursorLine === 0` | Keep for built-in commands, add separate check for invocations |
| `isAtStartOfMessage()` L1897 | Must be at start of first line | Needs a sibling method like `isAtInvocationTrigger()` that checks for `/` after whitespace at any position |
| Character trigger L985-987 | `char === "/" && this.isAtStartOfMessage()` | Also trigger when `/` follows whitespace/newline at any cursor position |
| Continued typing L1003-1008 | `isInSlashCommandContext(textBeforeCursor)` | Also check for mid-text invocation context |

**Approach**: The editor needs a way to distinguish "slash command at start" (for built-ins) vs "slash invocation mid-text" (for skills/prompts). The editor itself doesn't know which commands are built-in vs invocations. Two options:

**Option A**: Editor always triggers autocomplete for `/` anywhere, and the `CombinedAutocompleteProvider` filters to only return invocations (skills/prompts) when not at start position. This requires the provider to know which items are "invocations" vs "commands".

**Option B**: Pass a flag/category to autocomplete items so the provider can filter by position context.

**Recommendation**: Option A -- mark items with a category in `SlashCommand` interface.

#### Layer 2: Autocomplete Provider (packages/tui)

**`packages/tui/src/autocomplete.ts`** — `CombinedAutocompleteProvider`

`getSuggestions()` changes:
- Currently only checks `textBeforeCursor.startsWith("/")` for slash commands
- Need to: scan backwards from cursor to find the last `/` that's at a word boundary
- Extract the token being typed (e.g., in `"fix the bug /skill:fro"`, extract `/skill:fro`)
- When NOT at start of line: only return invocation-type items (skills, prompts), not built-in commands
- When at start of line: return all items (current behavior)

`applyCompletion()` changes:
- Currently assumes slash command replaces from start of line
- Need to: replace only the `/token` portion at cursor position
- After completion, insert a space after the invocation name

New `SlashCommand` interface addition:
```typescript
export interface SlashCommand {
    name: string;
    description?: string;
    /** If true, this command can be invoked at any position (skills, prompts) */
    inlineInvocable?: boolean;
    getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}
```

#### Layer 3: Command Registration (packages/coding-agent)

**`packages/coding-agent/src/modes/interactive/interactive-mode.ts`** — `setupAutocomplete()`

Mark skills and prompt templates as inline-invocable:
```typescript
const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
    name: cmd.name.replace(/\//g, ":"),
    description: cmd.description,
    inlineInvocable: true,  // <-- NEW
}));

skillCommandList.push({ 
    name: commandName, 
    description: skill.description,
    inlineInvocable: true,  // <-- NEW
});
```

Built-in commands remain without `inlineInvocable` (default false).

#### Layer 4: Submit-Time Expansion (packages/coding-agent)

**`packages/coding-agent/src/core/agent-session.ts`**

`_expandSkillCommand()` changes:
- Currently: `if (!text.startsWith("/skill:")) return text;` — only handles when entire text starts with `/skill:`
- Needed: find ALL `/skill:name` tokens in the text and expand each one
- Use regex like `/(?:^|\s)(\/skill:[\w-]+)(?:\s|$)/g` to find all occurrences
- Expand each match in-place

**`packages/coding-agent/src/core/prompt-templates.ts`**

`expandPromptTemplate()` changes:
- Currently: `if (!text.startsWith("/")) return text;` — only handles when entire text starts with `/`
- Needed: find ALL `/templatename` tokens and expand each one
- More complex because templates can have arguments (text after the template name until the next `/template` or end)
- Need to define argument boundary rules for mid-text invocations

**Argument boundaries for mid-text invocations**: When a skill/prompt invocation is mid-text, its arguments are everything after the invocation name until the next `/skill:` or `/promptname` invocation token, or end of text.

Example:
```
fix this bug /skill:frontend-design make it responsive /git:commit summarize changes
```
Parses to:
1. `fix this bug ` → plain text (prepended to final message)
2. `/skill:frontend-design` + args `make it responsive` → expanded
3. `/git:commit` + args `summarize changes` → expanded

Implementation: scan the text for invocation tokens at word boundaries. For each, capture text until the next invocation or end. Non-invocation text before the first invocation is preserved as-is.

```typescript
// Pseudocode for multi-invocation expansion
function expandAllInvocations(text: string, skills: Skill[], templates: PromptTemplate[]): string {
    const invocationPattern = /(?:^|\s)(\/(?:skill:[\w-]+|[\w:-]+))(?=\s|$)/g;
    // Find all invocation positions, split text into segments
    // For each invocation segment: expand skill/template with its trailing args
    // Reassemble: plain prefix + expanded segments
}
```

#### Layer 5: Steer/FollowUp Expansion

**`packages/coding-agent/src/core/agent-session.ts`** — `steer()` and `followUp()`

Same changes as `_expandSkillCommand` since they also call it:
```typescript
let expandedText = this._expandSkillCommand(text);
expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
```

These will work automatically once the expansion functions support mid-text invocations.

---

## Implementation Complexity Summary

| Component | Difficulty | Risk |
|-----------|-----------|------|
| Editor trigger (isSlashMenuAllowed relaxation) | Low | Low — isolated change |
| Autocomplete provider (mid-text `/` detection) | Medium | Medium — must not break file path detection |
| SlashCommand `inlineInvocable` flag | Low | Low — additive |
| Skill expansion (multi-match) | Medium | Low — self-contained |
| Template expansion (multi-match) | Medium | Low — argument boundary = next invocation or end of text |
| Visual highlighting of invocations | Medium | Low — optional/cosmetic |

### Conflict Risk: `@` File References vs Slash Invocations

The autocomplete provider handles `@file` references by scanning backwards for `@`. The same backward-scanning approach applies to `/` for invocations. Care needed to avoid conflicts -- but since `@` and `/` are different characters, this should be straightforward.

### Conflict Risk: File Paths

File paths like `./src/foo.ts` or `/usr/bin/foo` contain `/`. The provider must distinguish:
- `/skill:name` — invocation (starts with known prefix after word boundary)
- `./path/to/file` — file path
- `/absolute/path` — file path (only at start of line in current system, but could appear in quoted paths)

Heuristic: only treat `/` as invocation trigger when preceded by whitespace or at start of text.

---

## Recommended Implementation Order

1. Add `inlineInvocable` to `SlashCommand` interface
2. Mark skills and prompt templates as `inlineInvocable` in `interactive-mode.ts`
3. Update `CombinedAutocompleteProvider.getSuggestions()` to detect mid-text `/` tokens and filter to invocable items
4. Update `CombinedAutocompleteProvider.applyCompletion()` for mid-text replacement
5. Update editor trigger logic (`isAtStartOfMessage`, character triggers) to allow mid-text `/`
6. Update `_expandSkillCommand()` to handle multiple occurrences
7. Update `expandPromptTemplate()` to handle multiple occurrences
8. Add tests for all new behaviors
