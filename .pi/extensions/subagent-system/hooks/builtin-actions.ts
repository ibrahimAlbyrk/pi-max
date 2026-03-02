/**
 * SubAgent System — Built-in Hook Actions
 *
 * Predefined actions: block, notify, log, abort, emit, modify
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { HookEngine } from "../core/hook-engine.js";

/**
 * Agent abort callback — set by AgentManager when creating an agent.
 */
let activeAbortCallback: (() => Promise<void>) | null = null;

export function setActiveAbortCallback(cb: (() => Promise<void>) | null): void {
  activeAbortCallback = cb;
}

/**
 * Register all built-in hook actions with the hook engine.
 */
export function registerBuiltinActions(hookEngine: HookEngine, pi: ExtensionAPI): void {
  // ─── block ────────────────────────────────────────────────────────
  // Block a tool call (only effective for InProcess agents)
  hookEngine.registerAction("block", async (params, _event, ctx) => {
    const message = (params.message as string) || "Blocked by hook";
    ctx.log(`[hook:block] ${message}`);
    return { block: true, reason: message };
  });

  // ─── notify ───────────────────────────────────────────────────────
  // Send a notification to the user
  hookEngine.registerAction("notify", async (params, _event, ctx) => {
    const message = (params.message as string) || "Agent notification";
    const level = (params.level as string) || "info";
    ctx.notify(message, level);
  });

  // ─── log ──────────────────────────────────────────────────────────
  // Write to debug log
  hookEngine.registerAction("log", async (params, _event, ctx) => {
    const message = (params.message as string) || "";
    ctx.log(`[hook:log] ${message}`);
  });

  // ─── abort ────────────────────────────────────────────────────────
  // Stop the agent
  hookEngine.registerAction("abort", async (params, _event, ctx) => {
    const message = (params.message as string) || "Agent aborted by hook";
    ctx.log(`[hook:abort] ${message}`);

    if (activeAbortCallback) {
      await activeAbortCallback();
    }
  });

  // ─── emit ─────────────────────────────────────────────────────────
  // Emit a custom event on pi.events bus
  hookEngine.registerAction("emit", async (params, event, _ctx) => {
    const eventName = (params.event as string) || "subagent:custom-event";
    const data = (params.data as Record<string, unknown>) || {};
    pi.events.emit(eventName, {
      agentId: event.agentId,
      agentName: event.agentName,
      ...data,
    });
  });

  // ─── modify ───────────────────────────────────────────────────────
  // Modify tool input (only effective for InProcess agents)
  hookEngine.registerAction("modify", async (params, _event, ctx) => {
    const setValues = (params.set as Record<string, unknown>) || {};
    if (Object.keys(setValues).length === 0) return;

    ctx.log(`[hook:modify] Modifying input: ${JSON.stringify(setValues)}`);
    return { modifiedInput: setValues };
  });
}
