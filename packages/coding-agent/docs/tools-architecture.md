# Tool Architecture

Pi's tool system has three layers: definition (metadata + schema), registration (the `ToolRegistry`), and execution (middleware + extension interception).

## Definitions

All executable tools share a common metadata base, `BaseToolDefinition`, defined in `@mariozechner/pi-agent-core`:

```typescript
// Tool (packages/ai) — minimal LLM-facing descriptor
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters; // JSON schema
}

// BaseToolDefinition (packages/agent) — adds human-readable label
interface BaseToolDefinition<TParameters extends TSchema = TSchema> extends Tool<TParameters> {
  label: string; // Human-readable label for UI display
}

// AgentTool (packages/agent) — built-in tool execute signature
interface AgentTool<TParameters, TDetails> extends BaseToolDefinition<TParameters> {
  sideEffects?: boolean;
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>;
}

// ToolDefinition (packages/coding-agent) — extension/SDK execute signature
interface ToolDefinition<TParams, TDetails> extends BaseToolDefinition<TParams> {
  sideEffects?: boolean;
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  renderCall?(args, options, theme): Component | undefined;
  renderResult?(result, options, theme): Component | undefined;
}
```

### `sideEffects`

Controls whether the agent loop may parallelize a tool with other read-only tools:

| Value | Behavior |
|-------|----------|
| `false` | Read-only; may be parallelized with other `sideEffects: false` tools (up to `maxParallelTools`, default 5) |
| `true` | Has side effects; always executes sequentially |
| `undefined` | Treated as `true` (safe default) |

Use `sideEffects: false` for file reads, searches, API queries. Leave it unset or set to `true` for writes, deletes, shell commands, or any stateful operation.

## Registration (ToolRegistry)

`ToolRegistry` (`packages/coding-agent/src/core/tool-registry.ts`) is the canonical runtime authority for all tools in a session. It is exported from `@mariozechner/pi-coding-agent` and instantiated once per session.

**Three registration paths:**

| Origin | Method | Source |
|--------|--------|--------|
| `"builtin"` | `registerBuiltin(tool)` | Built-in tool sets (`codingTools`, `readOnlyTools`, etc.) |
| `"extension"` | `registerExtension(registeredTool)` | `pi.registerTool()` calls from extensions |
| `"sdk"` | `registerSdk(definition)` | `customTools` array in `createAgentSession()` options |

Registration uses **last-write-wins** semantics: if a name is already registered, the new entry replaces it and the displaced entry is recorded in `getDuplicates()`. In practice, registration order is builtin → extension → SDK, so SDK tools take highest priority.

### Middleware

Middleware intercepts a specific tool's execute path before the extension `tool_call`/`tool_result` event layer:

```typescript
import { ToolRegistry } from "@mariozechner/pi-coding-agent";

const registry = new ToolRegistry();

// Middleware registered first is outermost (called first)
registry.registerMiddleware("bash", async (toolCallId, params, signal, onUpdate, next) => {
  // Runs before tool executes
  const result = await next(toolCallId, params, signal, onUpdate);
  // Runs after tool executes
  return result;
});
```

The call order is:

```
extension tool_call handlers (can block)
  │
  ▼
ToolMiddlewareFn chain (outermost first, registered via registerMiddleware)
  │
  ▼
tool.execute()
  │
  ▼
extension tool_result handlers (can modify result)
```

### Validation Diagnostics

Every registration validates the tool's metadata. Call `getDiagnostics()` (or `validateAll()`, which is equivalent) after all registrations are complete:

```typescript
const diagnostics = registry.getDiagnostics();
for (const { name, origin, issues } of diagnostics) {
  for (const { severity, code, message } of issues) {
    console.warn(`[${severity}] ${name} (${origin}): ${code} — ${message}`);
  }
}
```

Validation codes:

| Code | Severity | Condition |
|------|----------|-----------|
| `name_empty` | `warning` | Tool name is empty |
| `name_format` | `warning` | Name contains characters outside `[a-zA-Z0-9_-]` |
| `name_length` | `warning` | Name exceeds 64 characters |
| `description_empty` | `warning` | Description is missing or blank |
| `label_empty` | `info` | Label is missing or blank |
| `schema_type_missing` | `warning` | Parameters schema lacks a `"type"` field |
| `schema_not_object` | `info` | Parameters schema `"type"` is not `"object"` |
| `duplicate_override` | `info` | This registration replaced an earlier one |

### Duplicate Detection

```typescript
for (const { name, previousOrigin, incomingOrigin } of registry.getDuplicates()) {
  console.warn(`${name}: ${incomingOrigin} overrode ${previousOrigin}`);
}
```

## Execution Flow

Full lifecycle for a single tool call:

```
LLM requests tool call
  │
  ▼
extension tool_call handlers
  (can return { block: true } to abort)
  │
  ▼
ToolMiddlewareFn chain
  (registered via registry.registerMiddleware())
  │
  ▼
tool.execute()
  │
  ▼
extension tool_result handlers
  (can return patches to modify content/details/isError)
  │
  ▼
result returned to LLM context
```

## Provider Serialization (packages/ai)

When the agent calls the LLM, tools are serialized to the provider-specific format by shared functions in `packages/ai/src/providers/tool-serializers.ts`. Provider streaming files delegate to these functions instead of duplicating conversion logic:

| Function | Provider |
|----------|----------|
| `serializeAnthropicTools` | Anthropic Messages API |
| `serializeOpenAIResponsesTools` | OpenAI Responses API |
| `serializeOpenAICompletionsTools` | OpenAI Chat Completions API |
| `serializeGoogleTools` | Google Generative AI / Vertex AI |
| `serializeBedrockTools` | Amazon Bedrock Converse API |

All functions accept `Tool[]` from `@mariozechner/pi-ai` as input. The `BaseToolDefinition.label` field is UI-only and is not serialized to providers.
