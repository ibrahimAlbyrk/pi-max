/**
 * SubAgent System — Agent Channel Switching
 *
 * Two-stage interaction:
 *   1. Agent Selector: Ctrl+Shift+A → agent bar shows selection highlight
 *      ←→ to pick agent, Enter to open feed, Escape to cancel
 *      An invisible overlay captures input so ←→/Enter/Esc don't go to input bar
 *   2. Agent Feed: full-screen view of agent activity
 *      Tab/Shift+Tab to switch, ↑↓ to scroll, Escape to close
 *
 * The selector changes ONLY the widget rendering (adds highlight).
 * All other UI stays exactly the same.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Focusable } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth, wrapTextWithAnsi, matchesKey } from "@mariozechner/pi-tui";
import type { AgentManager } from "../core/agent-manager.js";
import type { AgentHandle, AgentEvent } from "../core/types.js";
import type { PanelRenderResult } from "./agent-panel.js";
import {
  AgentFeedBuffer,
  processAgentEvent,
  addUserMessage,
  addAgentMessageSent,
  addAgentMessageReceived,
  type ChannelInfo,
  type FeedEntry,
} from "./agent-feed.js";
import {
  AGENT_COLOR_PALETTE,
  hexToAnsi,
  hexToBgAnsi,
  getStatusIcon,
  ANSI_RESET,
  ANSI_DIM,
  ANSI_BOLD,
  ANSI_ITALIC,
  FEED_BG_TOOL,
  FEED_BG_USER,
  FEED_BG_HEADER,
  FEED_FG_MUTED,
  FEED_FG_SEPARATOR,
  FEED_FG_TOOL_OUTPUT,
  FEED_FG_SUCCESS,
  applyLineBg,
} from "./colors.js";

// ─── Constants ────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 100;
const CHROME_LINES = 6; // header(2) + input separator(1) + input line(1) + footer separator(1) + tab bar(1)
const DEFAULT_HEIGHT = 40;

// ─── Channel Manager ─────────────────────────────────────────────────

export class AgentChannelManager {
  private channels = new Map<string, ChannelInfo>();
  private channelOrder: string[] = [];
  private activeChannel: string | null = null;
  private scrollOffset = -1;
  private userScrolled = false;
  private isShowing = false;
  private currentCtx: any = null;

  /** Selection state — used by widget renderer */
  private _selectedAgentId: string | null = null;

  /** Viewport start index for the agent panel bar (sorted order) */
  private _viewportStart = 0;

  /** Last render result from renderAgentPanel — used for viewport-aware navigation */
  private _lastRenderResult: PanelRenderResult | null = null;

  /** Actual rendered content line count from last renderFeedView() — used by scroll() */
  private lastRenderedContentCount = 0;

  /** Input buffer for the feed panel input area */
  private inputBuffer = "";
  /** Cursor position within the input buffer */
  private inputCursor = 0;

  /** Callback to refresh the widget (set by setup.ts) */
  onWidgetRefresh: (() => void) | null = null;

  constructor(
    private pi: ExtensionAPI,
    private manager: AgentManager,
  ) {
    this.setupManagerListeners();
    this.setupShortcuts();
  }

  // ─── Public API ───────────────────────────────────────────────────

  isOpen(): boolean {
    return this.activeChannel !== null;
  }

  /** Currently selected agent ID for widget highlighting */
  get selectedAgentId(): string | null {
    return this._selectedAgentId;
  }

  /** Viewport start index for agent panel bar (in sorted display order) */
  get viewportStart(): number {
    return this._viewportStart;
  }

  /** Store the last render result from renderAgentPanel for viewport-aware navigation */
  updateRenderResult(result: PanelRenderResult): void {
    this._lastRenderResult = result;
  }

  setCtx(ctx: any): void {
    this.currentCtx = ctx;
  }

  cleanup(): void {
    this.activeChannel = null;
    this.isShowing = false;
    this._selectedAgentId = null;
    this._viewportStart = 0;
    this._lastRenderResult = null;
    this.channels.clear();
    this.channelOrder = [];
  }

  hasViewableAgents(): boolean {
    if (this.isShowing) return true;
    // Use manager as source of truth instead of stale channelOrder
    const agents = this.manager.getAllAgents();
    return agents.some(a =>
      a.status === "working" || a.status === "thinking" || a.status === "idle"
    );
  }

  // ─── Manager Event Wiring ────────────────────────────────────────

  private setupManagerListeners(): void {
    this.manager.on("agent:created", (handle: AgentHandle) => {
      this.ensureChannel(handle);
    });

    this.manager.on("agent:event", (handle: AgentHandle, event: AgentEvent) => {
      const channel = this.ensureChannel(handle);
      channel.lastStatus = handle.status;
      try { channel.usage = { ...handle.getUsage() }; } catch { /* noop */ }
      processAgentEvent(channel.buffer, event);

      if (this.activeChannel === handle.id && !this.userScrolled) {
        this.scrollOffset = -1;
      }
    });

    // User → Agent message (from /tell command or feed panel input)
    this.manager.on("agent:user-message", (info: { agentId: string; agentName: string; message: string }) => {
      const channel = this.channels.get(info.agentId);
      if (channel) {
        addUserMessage(channel.buffer, info.message);
        if (this.activeChannel === info.agentId && !this.userScrolled) {
          this.scrollOffset = -1;
        }
      }
    });

    // Agent → Agent message sent (shown in sender's feed)
    this.manager.on("agent:message-sent", (info: { agentId: string; targetName: string; message: string }) => {
      const channel = this.channels.get(info.agentId);
      if (channel) {
        addAgentMessageSent(channel.buffer, info.targetName, info.message);
      }
    });

    // Agent → Agent message received (shown in receiver's feed)
    this.manager.on("agent:message-received", (info: { agentId: string; sourceName: string; message: string }) => {
      const channel = this.channels.get(info.agentId);
      if (channel) {
        addAgentMessageReceived(channel.buffer, info.sourceName, info.message);
      }
    });

    // Agent removed — clean up channel and order to prevent ghost agents.
    // While the feed panel is open (isShowing), defer ALL cleanup so that
    // the current view AND Tab/Shift+Tab navigation remain intact.
    // syncChannelsWithManager() handles deferred cleanup when the panel closes.
    this.manager.on("agent:removed", (agentId: string) => {
      if (this.isShowing) {
        return;
      }

      this.channels.delete(agentId);
      this.channelOrder = this.channelOrder.filter(id => id !== agentId);

      // If the selected agent in the selector was removed, clear selection
      if (this._selectedAgentId === agentId) {
        this._selectedAgentId = null;
      }
    });
  }

  private ensureChannel(handle: AgentHandle): ChannelInfo {
    let channel = this.channels.get(handle.id);
    if (!channel) {
      channel = {
        id: handle.id,
        name: handle.name,
        color: handle.color,
        description: handle.description,
        task: handle.task,
        buffer: new AgentFeedBuffer(),
        lastStatus: handle.status,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      };
      // Add system prompt and task as initial feed entries
      if (handle.systemPrompt) {
        channel.buffer.push({
          type: "system_prompt",
          timestamp: handle.startedAt,
          content: handle.systemPrompt,
        });
      }
      if (handle.task) {
        channel.buffer.push({
          type: "task",
          timestamp: handle.startedAt,
          content: handle.task,
        });
      }
      this.channels.set(handle.id, channel);
      this.channelOrder.push(handle.id);
    }
    return channel;
  }

  /**
   * Synchronize channels/channelOrder with the manager's live agent list.
   * Removes entries for agents that no longer exist in the manager.
   */
  private syncChannelsWithManager(): void {
    const liveIds = new Set(this.manager.getAllAgents().map(a => a.id));

    // Remove channels for agents that no longer exist
    this.channelOrder = this.channelOrder.filter(id => liveIds.has(id));
    for (const id of this.channels.keys()) {
      if (!liveIds.has(id)) {
        this.channels.delete(id);
      }
    }
  }

  // ─── Shortcuts ──────────────────────────────────────────────────

  private setupShortcuts(): void {
    this.pi.registerShortcut("shift+up", {
      description: "Open agent selector",
      handler: async (ctx: any) => {
        this.currentCtx = ctx;
        if (this.isShowing) return;

        if (!this.hasViewableAgents()) {
          if (this.channelOrder.length > 0) {
            this.channels.clear();
            this.channelOrder = [];
          }
          ctx.ui.notify("No agents to view", "info");
          return;
        }

        // Stage 1: Selector — invisible overlay captures input,
        //          widget renders with highlight
        const selectedId = await this.showAgentSelector(ctx);
        if (!selectedId) return;

        // Stage 2: Feed panel
        await this.showChannelLoop(ctx, selectedId);
      },
    });
  }

  // ─── Stage 1: Agent Selector ────────────────────────────────────
  //
  // An invisible 1-line overlay captures ←→ Enter Escape input.
  // The WIDGET renders the highlight via selectedAgentId state.
  // The rest of the UI is completely untouched.
  //

  private async showAgentSelector(ctx: any): Promise<string | null> {
    // Sync channels with manager to remove ghosts before opening selector
    this.syncChannelsWithManager();

    if (this.channelOrder.length === 0) return null;

    // Use sorted display order from last render result, fallback to live manager data
    const getSortedIds = (): string[] => {
      if (this._lastRenderResult?.sortedIds?.length) {
        return this._lastRenderResult.sortedIds;
      }
      // Fallback: derive from manager's live agents (not stale channelOrder)
      const liveAgents = this.manager.getAllAgents();
      return liveAgents.map(a => a.id);
    };

    const getVisibleRange = (): [number, number] => {
      return this._lastRenderResult?.visibleRange ?? [0, getSortedIds().length];
    };

    // Set initial selection — first agent in sorted order
    const sortedIds = getSortedIds();
    let selectedIndex = 0;
    this._selectedAgentId = sortedIds[selectedIndex] ?? null;
    this._viewportStart = 0;
    this.onWidgetRefresh?.();

    const self = this;

    const result = await ctx.ui.custom<string | null>(
      (tui: any, _theme: any, _kb: any, done: (result: string | null) => void) => {
        return new InvisibleInputCapture(
          // on left
          () => {
            const ids = getSortedIds();
            if (ids.length === 0) { done(null); return; }

            // Clamp index in case agents were removed since last navigation
            if (selectedIndex >= ids.length) selectedIndex = ids.length - 1;
            selectedIndex = (selectedIndex - 1 + ids.length) % ids.length;
            self._selectedAgentId = ids[selectedIndex];

            // Viewport scroll: if selection moved before visible range, shift viewport
            const [visStart] = getVisibleRange();
            if (selectedIndex < self._viewportStart) {
              self._viewportStart = selectedIndex;
            }
            // Circular wrap: going from first to last
            if (selectedIndex === ids.length - 1 && self._viewportStart === 0) {
              // We wrapped around to the end — adjust viewport so last agent is visible
              const visCount = self._lastRenderResult?.visibleCount ?? ids.length;
              self._viewportStart = Math.max(0, ids.length - visCount);
            }

            self.onWidgetRefresh?.();
            tui.requestRender();
          },
          // on right
          () => {
            const ids = getSortedIds();
            if (ids.length === 0) { done(null); return; }

            // Clamp index in case agents were removed since last navigation
            if (selectedIndex >= ids.length) selectedIndex = ids.length - 1;
            selectedIndex = (selectedIndex + 1) % ids.length;
            self._selectedAgentId = ids[selectedIndex];

            // Viewport scroll: if selection moved beyond visible range, shift viewport
            const [, visEnd] = getVisibleRange();
            if (selectedIndex >= visEnd) {
              // Shift viewport so the selected agent is the last visible one
              const visCount = self._lastRenderResult?.visibleCount ?? ids.length;
              self._viewportStart = Math.max(0, selectedIndex - visCount + 1);
            }
            // Circular wrap: going from last to first
            if (selectedIndex === 0) {
              self._viewportStart = 0;
            }

            self.onWidgetRefresh?.();
            tui.requestRender();
          },
          // on enter
          () => {
            done(self._selectedAgentId);
          },
          // on escape
          () => {
            done(null);
          },
        );
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          percentWidth: 100,
        },
      },
    );

    // Clear selection highlight and reset viewport
    this._selectedAgentId = null;
    this._viewportStart = 0;
    this.onWidgetRefresh?.();

    return result;
  }

  // ─── Stage 2: Feed Panel Loop ──────────────────────────────────

  private async showChannelLoop(ctx: any, startId: string): Promise<void> {
    if (this.isShowing) return;
    this.isShowing = true;

    let currentId: string | null = startId;

    while (currentId) {
      this.activeChannel = currentId;
      this.scrollOffset = -1;
      this.userScrolled = false;

      const result = await this.showChannel(ctx, currentId);

      if (result === "next") {
        const idx = this.channelOrder.indexOf(currentId);
        currentId = this.channelOrder[(idx + 1) % this.channelOrder.length];
      } else if (result === "prev") {
        const idx = this.channelOrder.indexOf(currentId);
        currentId = this.channelOrder[(idx - 1 + this.channelOrder.length) % this.channelOrder.length];
      } else {
        currentId = null;
      }
    }

    this.activeChannel = null;
    this.isShowing = false;

    // Sync with manager to clean up any agents removed while feed was open
    this.syncChannelsWithManager();

    if (!this.hasViewableAgents()) {
      this.channels.clear();
      this.channelOrder = [];
    }
  }

  private async showChannel(ctx: any, agentId: string): Promise<string | null> {
    const self = this;
    // Reset input buffer when opening a channel
    this.inputBuffer = "";
    this.inputCursor = 0;

    // Enable SGR mouse tracking so wheel events reach handleInput
    // instead of being handled by the terminal (which scrolls the buffer)
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    const result = await ctx.ui.custom<string | null>(
      (tui: any, _theme: any, _kb: any, done: (value: string | null) => void) => {
        let cachedLines: string[] | undefined;
        let cachedWidth: number | undefined;
        let closed = false;

        const refreshTimer = setInterval(() => {
          if (closed) return;
          cachedLines = undefined;
          cachedWidth = undefined;
          try { tui.requestRender(); } catch { /* noop */ }
        }, REFRESH_INTERVAL_MS);

        function closeFeed(result: string | null): void {
          if (closed) return;
          closed = true;
          clearInterval(refreshTimer);
          done(result);
        }

        function invalidateCache(): void {
          cachedLines = undefined;
          cachedWidth = undefined;
        }

        return {
          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;
            cachedLines = self.renderFeedView(width);
            return cachedLines;
          },
          handleInput(data: string): boolean {
            // Escape or Shift+Alt+Up always closes (even with text in input)
            if (matchesKey(data, "escape") || matchesKey(data, "shift+down")) { closeFeed(null); return true; }

            // Enter: if input buffer has text, send message; otherwise ignore
            if (matchesKey(data, "return")) {
              if (self.inputBuffer.trim()) {
                self.handleSendMessage(agentId);
                invalidateCache();
              }
              return true;
            }

            // Tab/Shift+Tab: switch channels (only if input empty)
            if (self.inputBuffer.length === 0) {
              if (matchesKey(data, "tab")) { closeFeed("next"); return true; }
              if (matchesKey(data, "shift+tab")) { closeFeed("prev"); return true; }
            }

            // Helper: scroll + immediate re-render (don't wait for 100ms timer)
            function doScroll(delta: number): boolean {
              self.scroll(delta);
              invalidateCache();
              tui.requestRender();
              return true;
            }

            // Ctrl+Up/Ctrl+Down or PageUp/PageDown: scroll
            if (matchesKey(data, "pageup")) return doScroll(-20);
            if (matchesKey(data, "pagedown")) return doScroll(20);
            if (data.includes("\x1b[<64;")) return doScroll(-3);
            if (data.includes("\x1b[<65;")) return doScroll(3);

            // Arrow up/down: scroll when input is empty, otherwise ignore
            if (self.inputBuffer.length === 0) {
              if (matchesKey(data, "up")) return doScroll(-1);
              if (matchesKey(data, "down")) return doScroll(1);
            }

            // Backspace
            if (matchesKey(data, "backspace")) {
              if (self.inputCursor > 0) {
                self.inputBuffer = self.inputBuffer.slice(0, self.inputCursor - 1) + self.inputBuffer.slice(self.inputCursor);
                self.inputCursor--;
                invalidateCache();
              }
              return true;
            }

            // Delete
            if (matchesKey(data, "delete")) {
              if (self.inputCursor < self.inputBuffer.length) {
                self.inputBuffer = self.inputBuffer.slice(0, self.inputCursor) + self.inputBuffer.slice(self.inputCursor + 1);
                invalidateCache();
              }
              return true;
            }

            // Left/Right arrow: move cursor within input
            if (matchesKey(data, "left")) {
              if (self.inputCursor > 0) { self.inputCursor--; invalidateCache(); }
              return true;
            }
            if (matchesKey(data, "right")) {
              if (self.inputCursor < self.inputBuffer.length) { self.inputCursor++; invalidateCache(); }
              return true;
            }

            // Home/End
            if (matchesKey(data, "home")) { self.inputCursor = 0; invalidateCache(); return true; }
            if (matchesKey(data, "end")) { self.inputCursor = self.inputBuffer.length; invalidateCache(); return true; }

            // Ctrl+U: clear input
            if (data === "\x15") {
              self.inputBuffer = "";
              self.inputCursor = 0;
              invalidateCache();
              return true;
            }

            // Printable characters — add to input buffer
            if (data.length > 0 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
              self.inputBuffer = self.inputBuffer.slice(0, self.inputCursor) + data + self.inputBuffer.slice(self.inputCursor);
              self.inputCursor += data.length;
              invalidateCache();
              return true;
            }

            return true;
          },
          invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
          dispose(): void {
            if (!closed) { closed = true; clearInterval(refreshTimer); }
          },
        };
      },
    );

    // Disable mouse tracking when feed panel closes
    process.stdout.write("\x1b[?1000l\x1b[?1006l");

    return result;
  }

  /**
   * Handle sending a message from the feed panel input area.
   */
  private handleSendMessage(agentId: string): void {
    const message = this.inputBuffer.trim();
    if (!message) return;

    const handle = this.manager.getAgent(agentId);
    if (!handle) return;

    if (handle.status === "completed" || handle.status === "error" || handle.status === "aborted") {
      return;
    }

    // Clear input
    this.inputBuffer = "";
    this.inputCursor = 0;

    // Send message async — don't block the UI
    handle.sendMessage(message).catch((err) => {
      console.error(`[subagent] Failed to send message from feed panel:`, err);
    });

    // Emit user message event for feed display
    this.manager.emitUserMessage(handle.id, handle.name, message);

    // Auto-scroll to bottom
    this.scrollOffset = -1;
    this.userScrolled = false;
  }

  // ─── Scrolling ─────────────────────────────────────────────────

  /**
   * Adjust scroll offset by delta. Does NOT do bounds checking here —
   * renderFeedView() does the clamping with the real content line count.
   * This avoids stale lastRenderedContentCount causing snap-back bugs.
   */
  private scroll(delta: number): void {
    if (this.scrollOffset === -1) {
      // Currently at bottom — approximate current position for relative scrolling
      const height = (process.stdout.rows || DEFAULT_HEIGHT) - CHROME_LINES;
      this.scrollOffset = Math.max(0, this.lastRenderedContentCount - height);
    }
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.userScrolled = true;
  }

  // ─── Feed View Rendering ───────────────────────────────────────

  renderFeedView(width: number): string[] {
    if (!this.activeChannel) return [];
    const channel = this.channels.get(this.activeChannel);
    if (!channel) return ["  No data for this agent."];

    const termHeight = process.stdout.rows || DEFAULT_HEIGHT;
    const colorInfo = AGENT_COLOR_PALETTE.find((c) => c.name === channel.color) || AGENT_COLOR_PALETTE[0];
    const fg = hexToAnsi(colorInfo.fg);
    const sepFg = hexToAnsi(FEED_FG_SEPARATOR);
    const mutedFg = hexToAnsi(FEED_FG_MUTED);
    const lines: string[] = [];

    // ── Header: clean single line with subtle background ──
    const statusIcon = getStatusIcon(channel.lastStatus);
    const usage = channel.usage;
    const up: string[] = [];
    if (usage.turns > 0) up.push(`Turn ${usage.turns}`);
    if (usage.input > 0) up.push(`↑${fmtTok(usage.input)}`);
    if (usage.output > 0) up.push(`↓${fmtTok(usage.output)}`);
    if (usage.cost > 0) up.push(`$${usage.cost.toFixed(4)}`);
    const usageStr = up.join("  ");
    const hLeft = `  ${statusIcon} ${ANSI_BOLD}${channel.name}${ANSI_RESET}${hexToBgAnsi(FEED_BG_HEADER)}${fg}  ${ANSI_DIM}${channel.lastStatus}${ANSI_RESET}${hexToBgAnsi(FEED_BG_HEADER)}`;
    const hRight = usageStr ? `${mutedFg}${usageStr}  ` : "";
    const hLeftVis = 2 + 1 + 1 + channel.name.length + 2 + channel.lastStatus.length;
    const hRightVis = usageStr ? stripAnsi(hRight).length : 0;
    const hPad = Math.max(1, width - hLeftVis - hRightVis);
    lines.push(applyLineBg(`${fg}${hLeft}${" ".repeat(hPad)}${hRight}`, FEED_BG_HEADER, width, width));
    lines.push(`${sepFg}${"─".repeat(width)}${ANSI_RESET}`);

    // ── Content ──
    const entries = channel.buffer.getEntries();
    const allContent: string[] = [];
    for (const entry of entries) {
      const entryLines = this.renderEntry(entry, width, colorInfo.fg);
      for (const line of entryLines) allContent.push(truncateToWidth(line, width));
    }
    if (allContent.length === 0) allContent.push(`  ${ANSI_DIM}Waiting for activity…${ANSI_RESET}`);

    // Store actual content line count for scroll()'s initial position estimate
    this.lastRenderedContentCount = allContent.length;

    // ── Viewport — clamping and snap-to-bottom ──
    const contentHeight = Math.max(1, termHeight - CHROME_LINES);
    const total = allContent.length;
    const maxOffset = Math.max(0, total - contentHeight);
    let viewStart: number;

    if (this.scrollOffset === -1 || !this.userScrolled) {
      viewStart = maxOffset;
    } else {
      viewStart = Math.min(this.scrollOffset, maxOffset);
      this.scrollOffset = viewStart;
      if (viewStart >= maxOffset && maxOffset > 0) {
        this.scrollOffset = -1;
        this.userScrolled = false;
        viewStart = maxOffset;
      }
    }

    const viewEnd = viewStart + contentHeight;
    const visible = allContent.slice(viewStart, viewEnd);
    while (visible.length < contentHeight) visible.push("");
    lines.push(...visible);

    // ── Input area ──
    const inputAgentActive = channel.lastStatus === "working" || channel.lastStatus === "thinking" || channel.lastStatus === "idle";
    if (inputAgentActive) {
      lines.push(`${sepFg}${"─".repeat(width)}${ANSI_RESET}`);
      const prompt = `${fg}❯${ANSI_RESET} `;
      let inputLine: string;
      if (this.inputBuffer.length > 0) {
        const before = this.inputBuffer.slice(0, this.inputCursor);
        const cursorChar = this.inputCursor < this.inputBuffer.length ? this.inputBuffer[this.inputCursor] : " ";
        const after = this.inputCursor < this.inputBuffer.length ? this.inputBuffer.slice(this.inputCursor + 1) : "";
        inputLine = `${prompt}${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
      } else {
        inputLine = `${prompt}${ANSI_DIM}Type message to ${channel.name}… (Enter to send)${ANSI_RESET}`;
      }
      lines.push(inputLine);
    } else {
      lines.push(`${sepFg}${"─".repeat(width)}${ANSI_RESET}`);
      lines.push(`  ${ANSI_DIM}Agent ${channel.lastStatus} — read only${ANSI_RESET}`);
    }

    // ── Footer: clean tab bar ──
    lines.push(`${sepFg}${"─".repeat(width)}${ANSI_RESET}`);
    const tabParts: string[] = [];
    for (const chId of this.channelOrder) {
      const ch = this.channels.get(chId);
      if (!ch) continue;
      const cI = AGENT_COLOR_PALETTE.find((c) => c.name === ch.color) || AGENT_COLOR_PALETTE[0];
      const cFg = hexToAnsi(cI.fg);
      const icon = getStatusIcon(ch.lastStatus);
      if (chId === this.activeChannel) {
        tabParts.push(`${cFg}${ANSI_BOLD} ${icon} ${ch.name} ${ANSI_RESET}`);
      } else {
        tabParts.push(`${ANSI_DIM} ${icon} ${ch.name} ${ANSI_RESET}`);
      }
    }
    const scrollInfo = total > contentHeight
      ? `${ANSI_DIM}${viewStart + 1}-${Math.min(viewEnd, total)}/${total}${ANSI_RESET}` : "";
    const helpText = `${ANSI_DIM}Shift+↓:back  Tab:next${ANSI_RESET}`;
    const rSide = scrollInfo ? `${scrollInfo}  ${helpText}` : helpText;
    const tabBar = tabParts.join(`${ANSI_DIM}·${ANSI_RESET}`);
    const tabBarVis = stripAnsi(tabBar).length;
    const rSideVis = stripAnsi(rSide).length;
    const fPad = Math.max(1, width - tabBarVis - rSideVis);
    if (tabBarVis + 1 + rSideVis > width) {
      lines.push(truncateToWidth(`${tabBar} ${rSide}`, width));
    } else {
      lines.push(`${tabBar}${" ".repeat(fPad)}${rSide}`);
    }

    return lines;
  }

  // ─── Entry Rendering ───────────────────────────────────────────

  private renderEntry(entry: FeedEntry, width: number, colorHex: string): string[] {
    const fg = hexToAnsi(colorHex);
    const mutedFg = hexToAnsi(FEED_FG_MUTED);
    const sepFg = hexToAnsi(FEED_FG_SEPARATOR);
    const toolOutFg = hexToAnsi(FEED_FG_TOOL_OUTPUT);
    const pad = "  "; // consistent left padding
    const innerWidth = Math.max(20, width - 4);

    switch (entry.type) {
      case "system_prompt": {
        // Plain system prompt — no background, like main context
        const result: string[] = [];
        result.push(`${pad}${mutedFg}${ANSI_BOLD}System Prompt${ANSI_RESET}`);
        const promptLines = entry.content.split("\n");
        for (const line of promptLines) {
          const wrapped = wrapTextWithAnsi(line, innerWidth);
          for (const w of wrapped) {
            result.push(`${pad}${ANSI_DIM}${w}${ANSI_RESET}`);
          }
        }
        result.push("");
        return result;
      }

      case "task": {
        // Plain task block — no background
        const result: string[] = [];
        result.push(`${pad}${fg}${ANSI_BOLD}Task${ANSI_RESET}`);
        const taskLines = entry.content.split("\n");
        for (const line of taskLines) {
          const wrapped = wrapTextWithAnsi(line, innerWidth);
          for (const w of wrapped) {
            result.push(`${pad}${w}`);
          }
        }
        result.push("");
        return result;
      }

      case "status": {
        // Clean inline status — no timestamp
        return [`${pad}${mutedFg}${entry.content}${ANSI_RESET}`];
      }

      case "turn": {
        // Clean turn separator — subtle line with turn label
        const label = entry.content;
        const sepLen = Math.max(0, width - label.length - 6);
        return [
          "",
          `${pad}${sepFg}───${ANSI_RESET} ${fg}${label}${ANSI_RESET} ${sepFg}${"─".repeat(sepLen)}${ANSI_RESET}`,
        ];
      }

      case "thinking": {
        // Subtle italic thinking — no emoji, no timestamp
        const text = entry.content.replace(/\s+/g, " ").trim();
        if (!text) return [];
        const wrapped = wrapTextWithAnsi(text, innerWidth);
        const result: string[] = [];
        for (const w of wrapped) {
          result.push(`${pad}${ANSI_DIM}${ANSI_ITALIC}${w}${ANSI_RESET}`);
        }
        if (entry.streaming && result.length > 0) {
          result[result.length - 1] = result[result.length - 1].replace(
            new RegExp(`${escapeRegex(ANSI_RESET)}$`), `▍${ANSI_RESET}`,
          );
        }
        return result;
      }

      case "message": {
        // Clean message text — no emoji, natural flow
        const text = entry.content.trim();
        if (!text) return [];
        const msgLines = text.split("\n");
        const result: string[] = [];
        for (const line of msgLines) {
          if (line === "") {
            result.push("");
            continue;
          }
          const wrapped = wrapTextWithAnsi(line, innerWidth);
          for (const w of wrapped) {
            result.push(`${pad}${w}`);
          }
        }
        if (entry.streaming && result.length > 0) {
          result[result.length - 1] += `${ANSI_DIM}▍${ANSI_RESET}`;
        }
        return result;
      }

      case "tool_call": {
        // Tool call header with background — like main context ToolExecutionComponent
        const tcLines = entry.content.split("\n");
        const result: string[] = [];
        result.push(applyLineBg(`${pad}${fg}${ANSI_BOLD}${tcLines[0]}${ANSI_RESET}`, FEED_BG_TOOL, width));
        // Additional lines (multi-line tool calls like bash with long commands)
        for (let i = 1; i < tcLines.length; i++) {
          result.push(applyLineBg(`${pad}${toolOutFg}${truncateToWidth(tcLines[i], innerWidth)}${ANSI_RESET}`, FEED_BG_TOOL, width));
        }
        return result;
      }

      case "tool_result": {
        // Tool result — plain dimmed text, no background
        const rl = entry.content.split("\n");
        const result: string[] = [];
        for (const l of rl) {
          result.push(`${pad}${ANSI_DIM}${truncateToWidth(l, innerWidth)}${ANSI_RESET}`);
        }
        return result;
      }

      case "user_message": {
        // User message — subtle background like main context UserMessageComponent
        const text = entry.content.trim();
        if (!text) return [];
        const result: string[] = [];
        const msgLines = text.split("\n");
        for (const line of msgLines) {
          const wrapped = wrapTextWithAnsi(line, innerWidth);
          for (const w of wrapped) {
            result.push(applyLineBg(`${pad}${w}${ANSI_RESET}`, FEED_BG_USER, width));
          }
        }
        return result;
      }

      case "agent_message_sent": {
        const target = entry.agentName || "?";
        const text = entry.content.trim();
        if (!text) return [];
        const wrapped = wrapTextWithAnsi(text, Math.max(20, innerWidth - target.length - 6));
        const result: string[] = [];
        for (let i = 0; i < wrapped.length; i++) {
          if (i === 0) result.push(`${pad}${fg}${ANSI_BOLD}→ ${target}${ANSI_RESET}  ${wrapped[i]}`);
          else result.push(`${pad}${"  ".repeat(target.length + 3)}${wrapped[i]}`);
        }
        return result;
      }

      case "agent_message_received": {
        const source = entry.agentName || "?";
        const text = entry.content.trim();
        if (!text) return [];
        const wrapped = wrapTextWithAnsi(text, Math.max(20, innerWidth - source.length - 6));
        const result: string[] = [];
        const recvFg = hexToAnsi(FEED_FG_SUCCESS);
        for (let i = 0; i < wrapped.length; i++) {
          if (i === 0) result.push(`${pad}${recvFg}${ANSI_BOLD}← ${source}${ANSI_RESET}  ${wrapped[i]}`);
          else result.push(`${pad}${"  ".repeat(source.length + 3)}${wrapped[i]}`);
        }
        return result;
      }

      default:
        return [`${pad}${entry.content}`];
    }
  }
}

// ─── Invisible Input Capture Overlay ──────────────────────────────────
//
// Renders nothing visible (empty line). Its only purpose is to
// capture keyboard input during agent selection mode so that
// ←→ Enter Escape don't reach the input bar.
//

class InvisibleInputCapture implements Focusable {
  focused = false;

  constructor(
    private onLeft: () => void,
    private onRight: () => void,
    private onEnter: () => void,
    private onEscape: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "shift+down")) { this.onEscape(); return; }
    if (matchesKey(data, "return")) { this.onEnter(); return; }
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) { this.onLeft(); return; }
    if (matchesKey(data, "right") || matchesKey(data, "tab")) { this.onRight(); return; }
    // All other keys: do nothing (consumed by overlay)
  }

  render(_width: number): string[] {
    // Render a single empty line — effectively invisible
    return [""];
  }

  invalidate(): void {}
  dispose(): void {}
}

// ─── Utilities ────────────────────────────────────────────────────────

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
function stripAnsi(s: string): string { return s.replace(/\x1b\[[^m]*m/g, ""); }
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
