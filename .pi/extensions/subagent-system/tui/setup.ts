/**
 * SubAgent System — TUI Setup
 *
 * - Widget above editor: minimal agent bar (icon + name + status hint)
 * - Message renderers: activity blocks, results, errors
 * - Agent channel overlay: Ctrl+Right/Left to view agent feeds
 * - Ctrl+Shift+A toggle panel visibility
 * - Animation timer: smooth shine + pulse effects on active agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../core/agent-manager.js";
import { renderAgentPanel, type PanelRenderResult } from "./agent-panel.js";
import { registerMessageRenderers } from "./agent-message.js";
import { AgentChannelManager } from "./agent-channel.js";

const WIDGET_KEY = "subagent-bar";

/** Animation frame interval in ms (~12fps — smooth enough for shine, light on CPU) */
const ANIM_INTERVAL_MS = 80;

/** Cooldown: keep animation running after last agent finishes (ms).
 *  Covers the 2s fade-out animation + small buffer. */
const ANIM_COOLDOWN_MS = 2500;

export function setupTUI(pi: ExtensionAPI, manager: AgentManager): void {
  let panelVisible = true;
  let currentCtx: any = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let animCooldownUntil = 0; // timestamp until which animation keeps running

  // Persistent widget state — registered once, never re-registered.
  // Prevents Map insertion-order changes that cause widget position swaps.
  let widgetRegistered = false;
  let widgetInvalidate: (() => void) | null = null;
  let widgetTui: { requestRender: () => void } | null = null;

  // ─── Message renderers ────────────────────────────────────────────
  registerMessageRenderers(pi, manager);

  // ─── Agent channel overlay ────────────────────────────────────────
  const channelManager = new AgentChannelManager(pi, manager);

  // Wire widget refresh for selector highlight updates
  channelManager.onWidgetRefresh = () => invalidateAndRender();

  // ─── Invalidate + Render ──────────────────────────────────────────

  function invalidateAndRender(): void {
    if (widgetInvalidate) widgetInvalidate();
    if (widgetTui) widgetTui.requestRender();
  }

  // ─── Animation timer ─────────────────────────────────────────────

  function hasActiveAgents(): boolean {
    const agents = manager.getAllAgents();
    return agents.some((a) =>
      a.status === "working" || a.status === "thinking" || a.status === "completed"
    );
  }

  function startAnimationTimer(): void {
    if (animTimer) return;
    animTimer = setInterval(() => {
      const active = hasActiveAgents();
      const inCooldown = Date.now() < animCooldownUntil;

      // Stop timer only if no active agents, past cooldown, AND overlay is closed
      if (!active && !inCooldown && !channelManager.isOpen()) {
        stopAnimationTimer();
        return;
      }
      invalidateAndRender();
    }, ANIM_INTERVAL_MS);
  }

  function stopAnimationTimer(): void {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }

  // ─── Widget registration (one-time) ──────────────────────────────

  /** Register the widget component ONCE. All future updates go through invalidateAndRender(). */
  function ensureWidgetRegistered(): void {
    if (widgetRegistered || !currentCtx) return;

    try {
      currentCtx.ui.setWidget(WIDGET_KEY, (tui: { requestRender: () => void }) => {
        widgetTui = tui;

        let cached: string[] | undefined;
        let cachedWidth: number | undefined;

        const component = {
          render: (width: number) => {
            // Read live state on every render — no captured snapshots
            const agents = manager.getAllAgents();
            if (agents.length === 0 || !panelVisible) {
              return [];
            }

            if (!cached || cachedWidth !== width) {
              const result: PanelRenderResult = renderAgentPanel(
                agents,
                width,
                channelManager.viewportStart,
                channelManager.selectedAgentId ?? undefined,
              );
              cached = result.lines;
              cachedWidth = width;
              // Store render result for viewport-aware navigation
              channelManager.updateRenderResult(result);
            }
            return cached;
          },
          invalidate: () => { cached = undefined; cachedWidth = undefined; },
        };

        widgetInvalidate = component.invalidate;
        return component;
      });

      widgetRegistered = true;

      // Force immediate render after registration
      if (widgetTui) {
        widgetTui.requestRender();
      }
    } catch (error) {
      console.error('[subagent] Widget registration failed:', error);
      widgetRegistered = false;
      widgetInvalidate = null;
      widgetTui = null;
    }
  }

  // ─── Widget refresh ──────────────────────────────────────────────

  function refreshWidget(): void {
    const agents = manager.getAllAgents();

    // Force context check if we have agents but no context
    if (agents.length > 0 && !currentCtx) {
      setTimeout(() => refreshWidget(), 100);
      return;
    }

    if (!currentCtx) return;

    // Register widget once when first agents appear
    if (!widgetRegistered && agents.length > 0) {
      ensureWidgetRegistered();
    }

    if (!widgetRegistered) return;

    // Already registered — just invalidate and re-render (no setWidget call)
    invalidateAndRender();

    // Manage animation timer
    if (agents.length === 0 || !panelVisible) {
      stopAnimationTimer();
    } else if (hasActiveAgents()) {
      startAnimationTimer();
    }
  }

  // ─── Ctx capture ─────────────────────────────────────────────────

  pi.on("session_start", async (_e, ctx) => {
    currentCtx = ctx;
    channelManager.setCtx(ctx);
  });

  pi.on("turn_start", async (_e, ctx) => {
    currentCtx = ctx;
    channelManager.setCtx(ctx);
    refreshWidget();
  });

  pi.on("turn_end", async (_e, ctx) => {
    currentCtx = ctx;
    channelManager.setCtx(ctx);
    refreshWidget();
  });

  pi.on("agent_end", async (_e, ctx) => {
    currentCtx = ctx;
    channelManager.setCtx(ctx);
    refreshWidget();
  });

  // ─── Manager events → widget + channel animation ────────────────

  manager.on("agent:created", () => {
    refreshWidget();
    // Ensure animation timer runs for channel overlay too
    if (hasActiveAgents() || channelManager.isOpen()) {
      startAnimationTimer();
    }
  });

  manager.on("agent:event", () => refreshWidget());
  manager.on("agent:completed", () => {
    animCooldownUntil = Date.now() + ANIM_COOLDOWN_MS;
    startAnimationTimer();
    refreshWidget();
  });
  manager.on("agent:failed", () => {
    animCooldownUntil = Date.now() + ANIM_COOLDOWN_MS;
    startAnimationTimer();
    refreshWidget();
  });
  manager.on("agent:aborted", () => {
    animCooldownUntil = Date.now() + ANIM_COOLDOWN_MS;
    startAnimationTimer();
    refreshWidget();
  });
  manager.on("agent:removed", () => refreshWidget());

  // ─── Panel toggle (Ctrl+Shift+P — avoid conflict with channel viewer) ──

  pi.registerShortcut("ctrl+shift+p", {
    description: "Toggle agent panel visibility",
    handler: async (ctx) => {
      currentCtx = ctx;
      channelManager.setCtx(ctx);
      panelVisible = !panelVisible;
      ctx.ui.notify(`Agent panel: ${panelVisible ? "visible" : "hidden"}`, "info");
      invalidateAndRender();
    },
  });

  // ─── Cleanup on session end ─────────────────────────────────────

  pi.on("session_shutdown", async () => {
    stopAnimationTimer();
    widgetRegistered = false;
    widgetInvalidate = null;
    widgetTui = null;
    currentCtx = null;
    animCooldownUntil = 0;
    channelManager.cleanup();
  });
}
