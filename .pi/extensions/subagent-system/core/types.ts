/**
 * SubAgent System — Core Type Definitions
 *
 * All interfaces and types used across the SubAgent system.
 * This is the foundation module — no internal dependencies.
 */

// ─── Agent Status & Runtime ───────────────────────────────────────────

export type AgentStatus = "idle" | "working" | "thinking" | "completed" | "error" | "aborted";

export type AgentRuntimeMode = "subprocess" | "inprocess";

// ─── Usage Stats ──────────────────────────────────────────────────────

export interface AgentUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function createEmptyUsageStats(): AgentUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ─── Message & Tool Call Info ─────────────────────────────────────────

export interface AgentToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface AgentMessageInfo {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  timestamp: number;
}

// ─── Agent Events ─────────────────────────────────────────────────────

export type AgentEventType =
  | "agent:started"
  | "agent:completed"
  | "agent:failed"
  | "agent:aborted"
  | "turn:start"
  | "turn:end"
  | "message:start"
  | "message:delta"
  | "message:thinking"
  | "message:end"
  | "tool:call"
  | "tool:start"
  | "tool:update"
  | "tool:end";

export interface AgentEvent {
  type: AgentEventType;
  agentId: string;
  agentName: string;
  timestamp: number;
}

export interface AgentToolCallEvent extends AgentEvent {
  type: "tool:call";
  toolName: string;
  input: Record<string, unknown>;
}

export interface AgentToolStartEvent extends AgentEvent {
  type: "tool:start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgentToolUpdateEvent extends AgentEvent {
  type: "tool:update";
  toolCallId: string;
  toolName: string;
  partialResult: string;
}

export interface AgentToolEndEvent extends AgentEvent {
  type: "tool:end";
  toolCallId: string;
  toolName: string;
  result: string;
  isError: boolean;
}

export interface AgentMessageDeltaEvent extends AgentEvent {
  type: "message:delta";
  text: string;
}

export interface AgentThinkingEvent extends AgentEvent {
  type: "message:thinking";
  text: string;
}

export interface AgentTurnStartEvent extends AgentEvent {
  type: "turn:start";
  turnIndex: number;
}

export interface AgentTurnEndEvent extends AgentEvent {
  type: "turn:end";
  turnIndex: number;
}

export interface AgentCompletedEvent extends AgentEvent {
  type: "agent:completed";
  output: string;
  usage: AgentUsageStats;
}

export interface AgentFailedEvent extends AgentEvent {
  type: "agent:failed";
  error: string;
  usage: AgentUsageStats;
}

export interface AgentAbortedEvent extends AgentEvent {
  type: "agent:aborted";
  usage: AgentUsageStats;
}

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

// ─── Agent Handle ─────────────────────────────────────────────────────

export interface AgentHandle {
  // Identity
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly runtimeMode: AgentRuntimeMode;
  readonly task: string;
  readonly systemPrompt?: string;

  // State
  status: AgentStatus;
  readonly startedAt: number;
  completedAt: number | null;

  // Event listening
  on(event: string, handler: AgentEventHandler): void;
  off(event: string, handler: AgentEventHandler): void;

  // Control
  abort(): Promise<void>;
  steer(message: string): Promise<void>;
  sendMessage(message: string): Promise<void>;

  // Information
  getUsage(): AgentUsageStats;
  getMessages(): AgentMessageInfo[];
  getLastOutput(): string;
  getRecentActivity(): AgentMessageInfo[];
}

// ─── Hook System ──────────────────────────────────────────────────────

export interface HookMatch {
  tool?: string;
  contains?: string;
  pattern?: string;
  path?: string;
}

export interface HookRule {
  match?: HookMatch;
  action: string;
  message?: string;
  level?: "info" | "warning" | "error";
  event?: string;
  data?: Record<string, unknown>;
  set?: Record<string, unknown>;
  url?: string;
  [key: string]: unknown;
}

export interface HookConfig {
  [eventName: string]: HookRule[];
}

export interface HookActionResult {
  block?: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
}

export type HookActionHandler = (
  params: Record<string, unknown>,
  event: AgentEvent,
  ctx: { notify: (msg: string, level?: string) => void; log: (msg: string) => void }
) => Promise<HookActionResult | void>;

// ─── Messaging ────────────────────────────────────────────────────────

export interface MessagingConfig {
  /** Agents this agent can send messages to. "*" = all, [] = none (default). */
  canSendTo: string[] | "*";
  /** Agents this agent can receive messages from. "*" = all, ["main"] = only user (default). */
  canReceiveFrom: string[] | "*";
  /** Maximum messages this agent can send per session (spam protection). Default: 20. */
  maxMessages: number;
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  canSendTo: [],
  canReceiveFrom: ["main"],
  maxMessages: 20,
};

export interface InterAgentMessage {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  message: string;
  priority: "normal" | "urgent";
  timestamp: number;
}

// ─── Agent Definition (from .pi/agents/*.md) ──────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  color?: string;
  hooks: HookConfig;
  messaging?: MessagingConfig;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

// ─── Spawn Options ────────────────────────────────────────────────────

export interface SpawnOptions {
  // For predefined agents from .pi/agents/
  agent?: string;

  // For runtime agents (when agent is not set)
  name?: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;

  // Messaging permissions
  messaging?: MessagingConfig;

  // Task assignment (cross-extension: links agent to task management tasks)
  taskIds?: number[];

  // Common
  task: string;

  // Inherited from main agent (set by manager)
  _mainThinkingLevel?: ThinkingLevel;
  _mainModel?: any; // Model<any> from pi — passed directly to avoid resolution issues
  _resolvedApiKey?: string; // Pre-resolved API key from parent to avoid OAuth lock contention
}
