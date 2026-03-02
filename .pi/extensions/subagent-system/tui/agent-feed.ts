/**
 * SubAgent System — Agent Feed Buffer
 *
 * Collects agent events and converts them into displayable feed entries.
 * Each agent has its own feed buffer with a circular capacity.
 */

import type {
  AgentEvent,
  AgentToolCallEvent,
  AgentToolEndEvent,
  AgentMessageDeltaEvent,
  AgentThinkingEvent,
  AgentTurnStartEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentUsageStats,
  AgentStatus,
} from "../core/types.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface FeedEntry {
  type: "system_prompt" | "task" | "status" | "turn" | "thinking" | "message" | "tool_call" | "tool_result" | "user_message" | "agent_message_sent" | "agent_message_received";
  timestamp: number;
  content: string;
  streaming?: boolean;
  /** For agent messages: source or target agent name */
  agentName?: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  color: string;
  description: string;
  task: string;
  buffer: AgentFeedBuffer;
  lastStatus: AgentStatus;
  usage: AgentUsageStats;
}

// ─── Feed Buffer ──────────────────────────────────────────────────────

export class AgentFeedBuffer {
  private entries: FeedEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 300) {
    this.maxEntries = maxEntries;
  }

  push(entry: FeedEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /** Append text to the last streaming entry of given type. Returns false if none found. */
  appendToStreaming(type: string, text: string): boolean {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === type && this.entries[i].streaming) {
        this.entries[i].content += text;
        return true;
      }
    }
    return false;
  }

  /** Mark the last streaming entry of given type as finalized. */
  finalizeStreaming(type: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === type && this.entries[i].streaming) {
        this.entries[i].streaming = false;
        return;
      }
    }
  }

  getEntries(): FeedEntry[] {
    return this.entries;
  }

  get length(): number {
    return this.entries.length;
  }
}

// ─── Event → Feed Entry Processing ───────────────────────────────────

export function processAgentEvent(buffer: AgentFeedBuffer, event: AgentEvent): void {
  const ts = event.timestamp;

  switch (event.type) {
    case "agent:started":
      buffer.push({ type: "status", timestamp: ts, content: "▶ Started" });
      break;

    case "turn:start": {
      const e = event as AgentTurnStartEvent;
      buffer.finalizeStreaming("thinking");
      buffer.finalizeStreaming("message");
      buffer.push({ type: "turn", timestamp: ts, content: `Turn ${e.turnIndex + 1}` });
      break;
    }

    case "message:thinking": {
      const e = event as AgentThinkingEvent;
      if (!buffer.appendToStreaming("thinking", e.text)) {
        buffer.push({ type: "thinking", timestamp: ts, content: e.text, streaming: true });
      }
      break;
    }

    case "message:delta": {
      const e = event as AgentMessageDeltaEvent;
      if (!buffer.appendToStreaming("message", e.text)) {
        buffer.finalizeStreaming("thinking");
        buffer.push({ type: "message", timestamp: ts, content: e.text, streaming: true });
      }
      break;
    }

    case "message:end":
      buffer.finalizeStreaming("message");
      break;

    case "tool:call":
    case "tool:start": {
      const e = event as any;
      buffer.finalizeStreaming("thinking");
      buffer.finalizeStreaming("message");
      const toolName = e.toolName || "";
      const toolInput = e.input || e.args || {};
      buffer.push({ type: "tool_call", timestamp: ts, content: formatToolCall(toolName, toolInput) });
      break;
    }

    case "tool:end": {
      const e = event as AgentToolEndEvent;
      if (e.result && e.result.trim()) {
        buffer.push({ type: "tool_result", timestamp: ts, content: truncateResult(e.result, 5) });
      }
      break;
    }

    case "agent:completed": {
      const e = event as AgentCompletedEvent;
      buffer.finalizeStreaming("thinking");
      buffer.finalizeStreaming("message");
      buffer.push({ type: "status", timestamp: ts, content: `✅ Completed ${formatUsageCompact(e.usage)}` });
      break;
    }

    case "agent:failed": {
      const e = event as AgentFailedEvent;
      buffer.finalizeStreaming("thinking");
      buffer.finalizeStreaming("message");
      buffer.push({ type: "status", timestamp: ts, content: `❌ Failed: ${e.error}` });
      break;
    }

    case "agent:aborted":
      buffer.finalizeStreaming("thinking");
      buffer.finalizeStreaming("message");
      buffer.push({ type: "status", timestamp: ts, content: "⚠️ Aborted" });
      break;
  }
}

/**
 * Add a user-sent message entry to the feed buffer.
 */
export function addUserMessage(buffer: AgentFeedBuffer, message: string): void {
  buffer.push({ type: "user_message", timestamp: Date.now(), content: message });
}

/**
 * Add an inter-agent message entry to the feed buffer.
 */
export function addAgentMessageSent(buffer: AgentFeedBuffer, targetName: string, message: string): void {
  buffer.push({ type: "agent_message_sent", timestamp: Date.now(), content: message, agentName: targetName });
}

export function addAgentMessageReceived(buffer: AgentFeedBuffer, sourceName: string, message: string): void {
  buffer.push({ type: "agent_message_received", timestamp: Date.now(), content: message, agentName: sourceName });
}

// ─── Formatters ───────────────────────────────────────────────────────

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return `$ ${(args.command as string) || "…"}`;
    case "read": {
      const p = (args.file_path || args.path || "…") as string;
      let t = `📖 read ${shortenPath(p)}`;
      if (args.offset || args.limit) {
        const off = (args.offset as number) || 1;
        const lim = (args.limit as number) || 0;
        t += `:${off}-${off + lim - 1}`;
      }
      return t;
    }
    case "write":
      return `✏️  write ${shortenPath((args.file_path || args.path || "…") as string)}`;
    case "edit":
      return `✏️  edit ${shortenPath((args.file_path || args.path || "…") as string)}`;
    case "grep":
      return `🔍 grep /${args.pattern || ""}/ ${shortenPath((args.path || ".") as string)}`;
    case "find":
      return `🔍 find ${args.pattern || "*"} in ${shortenPath((args.path || ".") as string)}`;
    case "ls":
      return `📂 ls ${shortenPath((args.path || ".") as string)}`;
    default:
      return `🔧 ${toolName} ${JSON.stringify(args).slice(0, 80)}`;
  }
}

function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let s = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (s.length > 60) {
    const parts = s.split("/");
    if (parts.length > 3) s = "…/" + parts.slice(-2).join("/");
  }
  return s;
}

function truncateResult(result: string, maxLines: number): string {
  const lines = result.split("\n");
  if (lines.length <= maxLines) return result;
  const shown = lines.slice(0, maxLines);
  return shown.join("\n") + `\n… (${lines.length - maxLines} more lines)`;
}

function formatUsageCompact(usage: AgentUsageStats | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turns`);
  if (usage.input) parts.push(`↑${fmtTok(usage.input)}`);
  if (usage.output) parts.push(`↓${fmtTok(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.length > 0 ? `(${parts.join(" · ")})` : "";
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
