# Prompt Caching & Cache Breakpoints

LLM providers like Anthropic and AWS Bedrock support prompt caching — reusing previously processed prompt prefixes to reduce cost and latency. Pi uses multi-block system prompts with per-block cache breakpoints to maximize cache hits even when parts of the prompt change every turn.

**Source files** ([pi-mono](https://github.com/badlogic/pi-mono)):
- [`packages/ai/src/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts) — `SystemPromptBlock`, `Context` types
- [`packages/ai/src/prompt-utils.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/prompt-utils.ts) — `normalizeSystemPrompt()`, `flattenSystemPrompt()` helpers
- [`packages/ai/src/providers/anthropic.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts) — Per-block `cache_control` mapping
- [`packages/ai/src/providers/amazon-bedrock.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/amazon-bedrock.ts) — Per-block `CachePoint` mapping
- [`packages/coding-agent/src/core/features/dps/prompt-composer.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/features/dps/prompt-composer.ts) — Stable/volatile block splitting
- [`packages/coding-agent/src/core/features/dps/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/features/dps/types.ts) — `DpsEntry.dynamic`, `ComposeResult.blocks`

## Overview

Without cache breakpoints, the entire system prompt is a single cache unit. Any change — even updating the current timestamp — invalidates the full cache and forces a costly rewrite. With multi-block splitting, pi separates stable content from volatile content so that the stable prefix stays cached across turns.

### Before (Single Block)

```
┌────────────────────────────────────────────────────┐
│ Base prompt + tools + context + skills + tasks + dt │  ← One block
│ cache_control: ephemeral                           │
└────────────────────────────────────────────────────┘
```

Any change to tasks or date/time invalidates the entire ~6000-token block.

### After (Multi-Block)

```
┌────────────────────────────────────────────────────┐
│ Block 0: Base prompt + tools + context + skills    │  ← Stable
│ cache_control: ephemeral                           │
├────────────────────────────────────────────────────┤
│ Block 1: Tasks + git branch + date/time + cwd      │  ← Volatile
│ cache_control: ephemeral                           │
└────────────────────────────────────────────────────┘
```

Block 0 (~80-90% of tokens) stays cached. Only Block 1 is reprocessed when dynamic content changes.

## How It Works

### 1. SystemPromptBlock Type

The `Context.systemPrompt` field accepts either a plain string (backward compatible) or an array of blocks:

```typescript
interface SystemPromptBlock {
  text: string;
  /** Whether to add a cache breakpoint after this block. Default: true */
  cache?: boolean;
}

interface Context {
  systemPrompt?: string | SystemPromptBlock[];
  messages: Message[];
  tools?: Tool[];
}
```

When a string is provided, it behaves exactly as before — normalized to a single block internally.

### 2. DPS Composition

The [Dynamic Prompt System (DPS)](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/features/dps/) composes the system prompt from multiple `.prompt.md` templates organized by layers (L0-L3). Each template can be marked as `dynamic: true` in its frontmatter:

```yaml
# dps/env-cwd-datetime.prompt.md
name: dps/env-cwd-datetime
dps:
  layer: 3
  priority: 99
  dynamic: true      # ← This entry goes into the volatile block
```

The `PromptComposer` splits resolved entries into two groups:

| Group | Contains | Cache Behavior |
|-------|----------|----------------|
| **Stable** | Entries with `dynamic: false` (default) | Cached across turns — prefix stays warm |
| **Volatile** | Entries with `dynamic: true` | May change per turn — reprocessed as needed |

Currently three DPS templates are marked dynamic:

| Template | Layer | Content |
|----------|-------|---------|
| `dps/env-cwd-datetime` | L3 | Current date/time and working directory |
| `dps/tool-task-context` | L2 | Task management state (active tasks, progress) |
| `dps/env-git-repo` | L1 | Git branch and workflow guidance |

### 3. Provider Mapping

#### Anthropic

Each `SystemPromptBlock` maps to a separate content block in the `system` parameter, with its own `cache_control`:

```json
{
  "system": [
    {
      "type": "text",
      "text": "Base prompt + tools + context...",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "Tasks + git + datetime...",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

Anthropic's cache is prefix-based: if Block 0 hasn't changed, its tokens are served from cache regardless of Block 1 changes.

#### AWS Bedrock

Each block maps to a `SystemContentBlock` with an associated `CachePoint`:

```json
{
  "system": [
    { "text": "Base prompt + tools + context..." },
    { "cachePoint": { "type": "DEFAULT" } },
    { "text": "Tasks + git + datetime..." },
    { "cachePoint": { "type": "DEFAULT" } }
  ]
}
```

#### Other Providers

OpenAI, Google, and other providers that don't support per-block cache control receive a flattened string via `flattenSystemPrompt()`. Their automatic prefix-based caching (where available) still benefits from stable prefixes since the block ordering places static content first.

## Cache Retention Levels

Pi supports three cache retention levels via `StreamOptions.cacheRetention` or the `PI_CACHE_RETENTION` environment variable:

| Level | Anthropic TTL | Write Cost | Read Cost | When to Use |
|-------|--------------|------------|-----------|-------------|
| `"short"` (default) | 5 minutes | 1.25x base | 0.1x base | Interactive sessions (refreshed on each turn) |
| `"long"` | 1 hour | 2x base | 0.1x base | Batch/infrequent use with large prompts |
| `"none"` | — | — | — | Disable caching entirely |

The 5-minute default is optimal for interactive use: each turn refreshes the cache, so it effectively never expires during active conversations.

## Anthropic Cache Constraints

- **Maximum 4 explicit cache breakpoints** per request (across `tools`, `system`, and `messages`). Pi uses 2 for system prompt blocks, leaving room for message caching.
- **Minimum cacheable length**: 1024-4096 tokens depending on the model. Blocks below this threshold are processed as regular uncached input (which is fine — the goal is caching the large stable block).
- **Cache hierarchy**: `tools` → `system` → `messages`. Changes at any level invalidate that level and all subsequent levels.
- **20-block lookback window**: The system checks up to 20 blocks before each explicit breakpoint for cache matches.

## Extension Compatibility

Extensions that hook into `before_agent_start` receive the system prompt as a **flattened string** for backward compatibility:

```typescript
// Extension handler receives a flat string
pi.on("before_agent_start", (event) => {
  console.log(typeof event.systemPrompt); // "string"
});
```

- If an extension **does not modify** `systemPrompt` → original blocks are preserved (cache optimization active).
- If an extension **modifies** `systemPrompt` → the result is a single string block (cache optimization is lost for that turn, but correctness is maintained).

## Cost Impact

Example with Sonnet 4.5 ($3/MTok base), 6000-token system prompt:

| Scenario | Without Blocks | With Blocks | Savings |
|----------|---------------|-------------|---------|
| Nothing changed | 6K cache read = $1.80 | 5.5K read + 0.5K read = $1.80 | 0% |
| Task state changed | 6K cache write = $22.50 | 5.5K read + 0.5K input = $3.15 | **86%** |
| 10 turns (5 task changes) | $121.50 | $24.00 | **80%** |

The savings come from avoiding full cache rewrites when only the volatile block changes.

## Adding a Dynamic DPS Template

To mark a new DPS template as dynamic, add `dynamic: true` to the `dps:` frontmatter block:

```yaml
---
name: dps/my-dynamic-section
description: Content that changes frequently
version: 1
dps:
  layer: 2
  priority: 5
  dynamic: true
  conditions:
    - tool_active: my_tool
variables:
  - name: MY_VARIABLE
    type: string
    required: true
---
{{MY_VARIABLE}}
```

Guidelines for marking templates as dynamic:
- Mark as `dynamic: true` if the template uses variables that change every turn (timestamps, task state, token usage).
- Leave as default (`false`) for templates with stable content (tool guidelines, project context, skills).
- Semi-static content (git branch) can go either way — marking it dynamic keeps the stable block more consistent at the cost of a slightly larger volatile block.

## Helpers

Two utility functions in `@mariozechner/pi-ai` handle conversion between formats:

```typescript
import { normalizeSystemPrompt, flattenSystemPrompt } from "@mariozechner/pi-ai";

// String → blocks
normalizeSystemPrompt("hello");           // [{ text: "hello" }]
normalizeSystemPrompt(undefined);          // []

// Blocks → string
flattenSystemPrompt([
  { text: "block1" },
  { text: "block2" },
]);                                        // "block1\n\nblock2"
flattenSystemPrompt(undefined);            // undefined
```

Custom providers that don't support multi-block system prompts should use `flattenSystemPrompt()` to convert blocks to a single string before sending to their API.
