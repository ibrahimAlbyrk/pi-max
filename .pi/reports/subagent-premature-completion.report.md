# Subagent Premature Completion Bug — Investigation Report

**Date**: 2026-03-05  
**Severity**: High  
**Affected**: `.pi/extensions/subagent-system/`

## Problem

After `spawn_agent`, the main agent immediately receives a "completed" notification with incomplete/incorrect output, while the subprocess agent is still actively working (reading files, executing tools).

## Root Cause

**`agent_end` is written to stdout BEFORE the subprocess decides whether to continue working.**

In `agent-session.ts`, the event processing order in `_processAgentEvent` is:

```
1. await this._emitExtensionEvent(event)    ← extensions
2. this._emit(event)                         ← listeners (RPC stdout output)
3. auto-retry / auto-compaction check        ← may trigger agent.continue()
```

When `agent_end` arrives:
- **Step 2** writes it to stdout → parent reads it → `subprocess-agent` emits `agent:completed` → manager calls `onAgentTaskDone` → main agent notified
- **Step 3** checks for retryable errors or compaction needs → may call `agent.continue()` → starts NEW agent loop → subprocess keeps working

The parent has already reported completion before the subprocess decides to continue.

## Event Chain (Bug Scenario)

```
SUBPROCESS (pi --mode rpc)              PARENT (subprocess-agent.ts)         MANAGER
─────────────────────────               ────────────────────────────         ───────
1. prompt received                      
2. agent_start → stdout      ────────→  processRpcEvent: agent_start
3. turn_start → stdout       ────────→  processRpcEvent: turn_start
4. LLM call (overloaded/429/500)
5. message_end (error) → stdout ─────→  processRpcEvent: message_end
6. turn_end → stdout         ────────→  processRpcEvent: turn_end
7. agent_end → stdout        ────────→  processRpcEvent: agent_end
                                         ↓
                                         emits "agent:completed"   ────────→ onAgentTaskDone()
                                                                              ↓
                                                                              sendMessage(triggerTurn=true)
                                                                              ↓
                                                                              MAIN AGENT NOTIFIED ✗
8. _isRetryableError? YES
9. setTimeout → agent.continue()
10. agent_start → stdout     ────────→  processRpcEvent: agent_start
11. turn_start → stdout                  (agent already "completed")
12. LLM call succeeds
13. tool calls (reading files...)
14. ...still working...                  MAIN AGENT ALREADY REPORTED COMPLETION
```

## Confirmed Code Issues

### Issue 1: `agent_end` treated as task completion

**File**: `.pi/extensions/subagent-system/runtime/subprocess-agent.ts:341-365`

```typescript
case "agent_end": {
  // ...extract lastOutput...
  
  // Comment says "The manager will decide" — but it DOESN'T
  this.status = "idle";
  this.emitAgentEvent("agent:completed", { output: this.lastOutput, usage: this.getUsage() });
  break;
}
```

The comment is misleading. The manager immediately calls `onAgentTaskDone` on receiving `agent:completed` — there is no additional decision logic.

### Issue 2: Extension emit happens before retry/compaction check

**File**: `packages/coding-agent/src/core/agent-session.ts:389-451`

```typescript
// Step 1: Extensions + listeners get the event (stdout written here)
await this._emitExtensionEvent(event);
this._emit(event);

// Step 2: AFTER stdout write — check if we should continue
if (event.type === "agent_end" && this._lastAssistantMessage) {
  if (this._isRetryableError(msg)) {
    const didRetry = await this._handleRetryableError(msg);
    if (didRetry) return;
  }
  await this._checkCompaction(msg);
}
```

### Issue 3: Retry/compaction events not handled by subprocess-agent

`subprocess-agent.ts` has NO cases for:
- `auto_retry_start` / `auto_retry_end`
- `auto_compaction_start` / `auto_compaction_end`

These events ARE emitted by the subprocess and written to stdout, but silently ignored by the parent. The parent has no way to know a retry is about to happen.

### Issue 4: Double completion notification

When auto-retry triggers `agent.continue()`, it calls `agentLoopContinue` which emits a NEW `agent_start` → `agent_end` cycle. The second `agent_end` triggers a SECOND `agent:completed` emission.

In the manager, `handleAgentEvent` checks:
```typescript
if (!this.agents.has(handle.id) && !this.completedAgents.has(handle.id)) return;
```

But if the agent is still in `completedAgents` (within the 2s removal timer), the second `onAgentTaskDone` call fires — sending a SECOND notification to the main agent via `sendMessage(triggerTurn: true)`.

### Issue 5: RPC prompt is fire-and-forget

**File**: `packages/coding-agent/src/modes/rpc/rpc-mode.ts:356-365`

```typescript
case "prompt": {
  session.prompt(command.message, { ... })
    .catch((e) => output(error(id, "prompt", e.message)));
  return success(id, "prompt");  // Returns IMMEDIATELY
}
```

The RPC success response means "prompt was accepted", NOT "prompt processing completed". But `sendRpcWithResponse` resolves on this success, giving a false sense of task initiation.

## Trigger Scenarios

### Scenario A: Retryable API Error (most likely)
1. Agent's first LLM call hits overloaded/rate_limit/429/500/502/503/504
2. `agent_end` fires with error stop reason
3. Parent reports completion with error output
4. Auto-retry kicks in after exponential backoff
5. New agent loop starts, agent actually works
6. Main agent already thinks agent is done

### Scenario B: Context Overflow
1. Agent's context exceeds model limit (unlikely for fresh agent, possible with large system prompts)
2. `agent_end` fires with overflow error
3. Parent reports completion
4. Auto-compaction triggers with `willRetry: true`
5. Agent continues after compaction

### Scenario C: Threshold Compaction + Queued Messages
1. Agent completes a turn successfully
2. `agent_end` fires — parent reports completion
3. Context exceeds threshold → auto-compaction runs
4. Queued follow-up messages exist → `agent.continue()` called
5. Agent keeps working

## Recommended Fixes

### Fix 1: Don't treat `agent_end` as task completion (subprocess-agent.ts)

Instead of immediately emitting `agent:completed` on `agent_end`, transition to an intermediate state and wait for either:
- Process exit (definitive completion)
- A timeout with no new events (idle timeout = true completion)
- An explicit "done" signal

```typescript
case "agent_end": {
  // Extract output...
  this.status = "idle";
  
  // DON'T emit agent:completed immediately.
  // Start an idle timer — if no new agent_start arrives within N ms,
  // THEN emit agent:completed.
  this.startCompletionTimer();
  break;
}

case "agent_start": {
  // Cancel pending completion timer — agent is continuing
  this.cancelCompletionTimer();
  this.hasEmittedStarted = true;  // already set
  break;
}
```

### Fix 2: Handle retry/compaction events (subprocess-agent.ts)

Add cases for `auto_retry_start` and `auto_compaction_start` to cancel any pending completion:

```typescript
case "auto_retry_start":
  this.cancelCompletionTimer();
  this.status = "working";
  this.emitAgentEvent("message:delta", { 
    text: `[retrying: attempt ${event.attempt}/${event.maxAttempts}]` 
  });
  break;

case "auto_compaction_start":
  this.cancelCompletionTimer();
  this.status = "working";
  break;
```

### Fix 3: Prevent double completion in manager (agent-manager.ts)

Track whether completion was already sent for an agent:

```typescript
private completionSent = new Set<string>();

private onAgentTaskDone(handle: AgentHandle, output: string): void {
  if (this.completionSent.has(handle.id)) return; // Already notified
  this.completionSent.add(handle.id);
  // ... existing logic
}
```

### Fix 4: Use process exit as definitive completion signal

The most reliable completion signal for a subprocess is process exit. Consider using the `close` event handler as the primary completion trigger instead of `agent_end`:

```typescript
// In process close handler:
if (code === 0 && this.status !== "completed") {
  this.status = "completed";
  this.completedAt = Date.now();
  this.emitAgentEvent("agent:completed", { output: this.lastOutput, usage: this.getUsage() });
}
```

This would require the subprocess to exit after completing (not stay alive in RPC mode), or sending an explicit "task_complete" signal.

## LLM Hallucination (Secondary Risk)

Independent of the code bug, there is a secondary risk: the main agent's LLM may not comply with the "STOP immediately after spawning" instruction. If the LLM continues generating instead of stopping, it could fabricate a fake agent completion response.

Indicators that this is happening:
- Agent output appears instantly (no realistic processing time)
- Output contains plausible but fabricated data
- The agent ID format matches the real one (LLM copies it from tool result)

This is a model-level issue that can't be fixed in code, but the premature `agent_end` bug makes it harder to distinguish from real completions.
