/**
 * SubAgent System — Agent Manager
 *
 * Central module managing agent lifecycle: spawn, stop, query, and
 * async notification back to the main agent when subagents complete.
 *
 * Activity strategy:
 *   - Thinking  → shown ONLY in the widget (live, updating)
 *   - Tool calls → buffered per agent, flushed ONCE at turn_end
 *                   → ONE block per agent per turn in the message area
 *   - Result    → sent on completion with triggerTurn
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import { join } from "path";
import { createPromptRegistry, getTemplatesDir, type PromptRegistry } from "@mariozechner/pi-prompt";
import { TypedEventEmitter } from "./event-emitter.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { HookEngine } from "./hook-engine.js";
import { setActiveAbortCallback } from "../hooks/builtin-actions.js";
import { SubProcessAgent } from "../runtime/subprocess-agent.js";
import { InProcessAgent, type ExtraToolFactory } from "../runtime/inprocess-agent.js";
import { createMessageAgentTool } from "../tools/message-agent.js";
import { assignColor } from "../tui/colors.js";
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventHandler,
  AgentHandle,
  AgentStatus,
  InterAgentMessage,
  MessagingConfig,
  SpawnOptions,
  ThinkingLevel,
} from "./types.js";
import { DEFAULT_MESSAGING_CONFIG } from "./types.js";

/** Lightweight task data read from .pi/tasks/tasks/{id}.json */
interface TaskFileData {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  tags: string[];
  notes: { timestamp: string; author: string; text: string }[];
  dependsOn: number[];
  parentId: number | null;
}

let idCounter = 0;
function generateId(): string {
  return `agent-${Date.now()}-${++idCounter}`;
}

export class AgentManager {
  private agents = new Map<string, AgentHandle>();
  private completedAgents = new Map<string, AgentHandle>();
  private hookEngines = new Map<string, HookEngine>();
  private managerEvents = new TypedEventEmitter();
  private removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tracked event handlers per agent — used to detach during destroyAll() */
  private agentEventHandlers = new Map<string, { handle: AgentHandle; handler: AgentEventHandler }>();
  private mainThinkingLevel: ThinkingLevel = "off";
  private mainModel: any = undefined; // Model<any> from pi context
  private modelRegistry: any = null; // ModelRegistry from pi context

  /** Messaging state: agent configs (id → MessagingConfig) */
  private agentMessagingConfigs = new Map<string, MessagingConfig>();
  /** Message counters per agent (for rate limiting) */
  private messageCounts = new Map<string, number>();
  /** Recent message history for loop detection */
  private messageHistory: { from: string; to: string; timestamp: number }[] = [];
  /** When true, all agent events are suppressed (prevents cascading errors during shutdown) */
  private destroying = false;
  /** Maps agent ID → assigned task IDs (for cross-extension event emission) */
  private agentTaskIds = new Map<string, number[]>();
  /** Tracks agents whose completion was already sent to the main agent (prevents double notification) */
  private completionNotified = new Set<string>();
  /** Prompt registry instance for rendering awareness template */
  private promptRegistry: PromptRegistry | null = null;



  constructor(
    private pi: ExtensionAPI,
    private registry: AgentRegistry,
    private hookEngineFactory: () => HookEngine,
    private cwd: string,
  ) {}

  // ─── Task Integration Helpers ─────────────────────────────────

  /**
   * Read task details from per-file storage (.pi/tasks/tasks/{id}.json).
   * Returns parsed task data for prompt injection. Skips missing files.
   */
  private readTaskFiles(taskIds: number[]): TaskFileData[] {
    const tasks: TaskFileData[] = [];
    for (const id of taskIds) {
      try {
        const filePath = join(this.cwd, ".pi", "tasks", "tasks", `${id}.json`);
        const content = readFileSync(filePath, "utf-8");
        tasks.push(JSON.parse(content) as TaskFileData);
      } catch {
        // Task file not found or parse error — skip silently
      }
    }
    return tasks;
  }

  /**
   * Format task details as markdown for system prompt injection.
   */
  private formatTasksForPrompt(tasks: TaskFileData[]): string {
    if (tasks.length === 0) return "";

    const lines: string[] = ["", "## Assigned Tasks", ""];
    for (const t of tasks) {
      lines.push(`### Task #${t.id}: ${t.title}`);
      lines.push(`- **Status**: ${t.status}`);
      lines.push(`- **Priority**: ${t.priority}`);
      if (t.description) lines.push(`- **Description**: ${t.description}`);
      if (t.tags && t.tags.length > 0) lines.push(`- **Tags**: ${t.tags.join(", ")}`);
      if (t.dependsOn && t.dependsOn.length > 0) {
        lines.push(`- **Depends on**: ${t.dependsOn.map((d: number) => `#${d}`).join(", ")}`);
      }
      if (t.notes && t.notes.length > 0) {
        const recentNotes = t.notes.slice(-3);
        lines.push("- **Recent notes**:");
        for (const n of recentNotes) {
          lines.push(`  - [${n.author}] ${n.text}`);
        }
      }
      lines.push("");
    }
    lines.push("Work on the assigned tasks above. Use the task tool to update status as you progress.");
    return lines.join("\n");
  }

  /**
   * Emit agent-task assignment event for the task management extension.
   */
  private emitTaskAssignment(agentId: string, agentName: string, agentColor: string, taskIds: number[]): void {
    this.pi.events.emit("subagent:tasks-assigned", {
      taskIds,
      agent: { agentId, agentName, agentColor },
    });
  }

  // ─── Subagent Awareness ─────────────────────────────────────────

  private getPromptRegistry(): PromptRegistry {
    if (!this.promptRegistry) {
      this.promptRegistry = createPromptRegistry({ templatesDir: getTemplatesDir() });
    }
    return this.promptRegistry;
  }

  /**
   * Render the subagent awareness prompt via the prompt registry.
   * Uses the agents/subagent-awareness template with AGENT_ID and AGENT_TYPE variables.
   */
  private getAwarenessPrompt(agentId: string, agentType: string): string {
    try {
      const registry = this.getPromptRegistry();
      const rendered = registry.render("agents/_subagent-awareness", {
        AGENT_ID: agentId,
        AGENT_TYPE: agentType,
      });
      return rendered;
    } catch {
      return "";
    }
  }

  setCwd(newCwd: string): void { this.cwd = newCwd; }
  setMainThinkingLevel(level: ThinkingLevel): void { this.mainThinkingLevel = level; }
  setMainModel(model: any): void { this.mainModel = model; }
  setModelRegistry(registry: any): void { this.modelRegistry = registry; }

  // ─── Spawn ──────────────────────────────────────────────────────

  spawn(options: SpawnOptions): AgentHandle {
    const id = generateId();
    let handle: AgentHandle;
    let agentColorHex = ""; // Hex fg color for task assignment events

    // ── Task context injection (cross-extension) ──
    let taskPromptSuffix = "";
    if (options.taskIds && options.taskIds.length > 0) {
      const taskData = this.readTaskFiles(options.taskIds);
      taskPromptSuffix = this.formatTasksForPrompt(taskData);
      this.agentTaskIds.set(id, options.taskIds);
    }

    let effectiveDefinition: AgentDefinition | undefined;

    if (options.agent) {
      const definition = this.registry.findByName(this.cwd, options.agent);
      if (!definition) {
        throw new Error(
          `Agent "${options.agent}" not found. Available: ${this.registry.discover(this.cwd).map((d) => d.name).join(", ") || "none"}`
        );
      }

      // Inject subagent awareness and task context into system prompt
      const awarenessBlock = this.getAwarenessPrompt(id, definition.name);
      effectiveDefinition = {
        ...definition,
        systemPrompt: awarenessBlock + "\n\n" + definition.systemPrompt + taskPromptSuffix,
      };

      const color = assignColor(definition.color);
      agentColorHex = color.fg;
      const thinking = definition.thinking || this.mainThinkingLevel;
      handle = new SubProcessAgent(id, effectiveDefinition, options.task, color.name, this.cwd, thinking, this.modelRegistry);

      if (definition.hooks && Object.keys(definition.hooks).length > 0) {
        const engine = this.hookEngineFactory();
        engine.loadConfig(definition.hooks);
        this.hookEngines.set(id, engine);
      }

      // Store messaging config
      if (definition.messaging) {
        this.agentMessagingConfigs.set(id, definition.messaging);
      }
    } else {
      if (!options.name) options.name = `runtime-${idCounter}`;
      const color = assignColor();
      agentColorHex = color.fg;
      options._mainThinkingLevel = this.mainThinkingLevel;
      options._mainModel = this.mainModel;

      // Inject subagent awareness and task context into runtime agent's system prompt
      if (options.systemPrompt) {
        const awarenessBlock = this.getAwarenessPrompt(id, options.name || "custom");
        options.systemPrompt = awarenessBlock + "\n\n" + options.systemPrompt + taskPromptSuffix;
      }

      // Create extra tool factory for message_agent if agent has messaging permissions
      const messagingConfig = options.messaging;
      let extraToolFactory: ExtraToolFactory | undefined;
      if (messagingConfig && this.hasAnySendPermission(messagingConfig)) {
        const mgr = this;
        extraToolFactory = (agentHandle: AgentHandle) => [createMessageAgentTool(mgr, agentHandle)];
      }

      handle = new InProcessAgent(id, options, color.name, this.cwd, extraToolFactory);

      // Store messaging config
      if (options.messaging) {
        this.agentMessagingConfigs.set(id, options.messaging);
      }
    }

    // Register in map and attach event listener BEFORE starting
    // to prevent race condition where early events are lost.
    this.agents.set(id, handle);
    const handler: AgentEventHandler = (event: AgentEvent) => this.handleAgentEvent(handle, event);
    handle.on("*", handler);
    this.agentEventHandlers.set(id, { handle, handler });
    this.managerEvents.emit("agent:created", handle);

    // Start the agent AFTER listeners are attached.
    // Handle errors properly: update status and emit failure event
    // instead of just logging to console.
    if (options.agent) {
      (handle as SubProcessAgent).start(effectiveDefinition!).catch((err) => {
        console.error(`[subagent] Failed to start subprocess agent "${options.agent}":`, err);
        this.handleStartFailure(handle, err);
      });
    } else {
      (handle as InProcessAgent).start(options).catch((err) => {
        console.error(`[subagent] Failed to start inprocess agent "${options.name}":`, err);
        this.handleStartFailure(handle, err);
      });
    }

    // ── Emit task assignment event (cross-extension) ──
    if (options.taskIds && options.taskIds.length > 0) {
      this.emitTaskAssignment(handle.id, handle.name, agentColorHex, options.taskIds);
    }

    return handle;
  }

  // ─── Stop ───────────────────────────────────────────────────────

  async stop(agentId: string): Promise<void> {
    const handle = this.agents.get(agentId) || this.completedAgents.get(agentId);
    if (handle) await handle.abort();
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const h of this.agents.values()) {
      if (h.status === "working" || h.status === "thinking" || h.status === "idle")
        promises.push(h.abort());
    }
    await Promise.allSettled(promises);
  }

  /**
   * Forcefully destroy all agents and clean all state.
   * Used during session shutdown for immediate cleanup.
   */
  async destroyAll(): Promise<void> {
    // Suppress all event processing during destroy to prevent:
    // - sendMessage errors during session shutdown crashing the cleanup loop
    // - agents re-adding themselves to maps via event handlers
    // - new timers being created via scheduleRemoval
    this.destroying = true;

    // 1. Snapshot agents before clearing maps
    const toKill = [...this.agents.values(), ...this.completedAgents.values()];

    // 2. Detach event handlers from all handles FIRST — prevents any late
    //    events (buffered stdout, microtask completions) from reaching
    //    handleAgentEvent after destroying is set back to false.
    for (const [id, { handle, handler }] of this.agentEventHandlers) {
      handle.off("*", handler);
    }

    // 3. Clear all timers
    for (const timer of this.removalTimers.values()) {
      clearTimeout(timer);
    }

    // 4. Clear all maps and state IMMEDIATELY (before async kill)
    //    This ensures queries return empty even if kill takes time.
    this.agents.clear();
    this.completedAgents.clear();
    this.hookEngines.clear();
    this.removalTimers.clear();
    this.agentEventHandlers.clear();
    this.agentMessagingConfigs.clear();
    this.messageCounts.clear();
    this.messageHistory = [];
    this.agentTaskIds.clear();
    this.completionNotified.clear();

    // 4. Now kill processes (best-effort, errors ignored)
    const promises: Promise<void>[] = [];
    for (const handle of toKill) {
      try {
        if (handle instanceof SubProcessAgent) {
          promises.push((handle as any).forceKill());
        } else {
          promises.push(handle.abort());
        }
      } catch { /* ignore individual errors */ }
    }
    await Promise.allSettled(promises);

    this.destroying = false;
    // NOTE: Do NOT call removeAllListeners() — TUI listeners are registered
    // once in setupTUI() and must survive across sessions.
  }

  // ─── Queries ────────────────────────────────────────────────────

  getAgent(idOrName: string): AgentHandle | undefined {
    const byId = this.agents.get(idOrName) || this.completedAgents.get(idOrName);
    if (byId) return byId;
    for (const h of this.agents.values()) if (h.name === idOrName) return h;
    for (const h of this.completedAgents.values()) if (h.name === idOrName) return h;
    return undefined;
  }

  getRunningAgents(): AgentHandle[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === "working" || a.status === "thinking" || a.status === "idle"
    );
  }

  getAllAgents(): AgentHandle[] {
    const all = new Map<string, AgentHandle>();
    for (const [id, h] of this.agents) all.set(id, h);
    for (const [id, h] of this.completedAgents) all.set(id, h);
    return Array.from(all.values());
  }

  getAvailableDefinitions(): AgentDefinition[] {
    return this.registry.discover(this.cwd);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.managerEvents.on(event, handler);
  }

  /**
   * Send a message to an agent (from user or another agent).
   * Returns true if delivered successfully.
   */
  async sendMessageToAgent(agentIdOrName: string, message: string, senderName?: string): Promise<boolean> {
    const handle = this.getAgent(agentIdOrName);
    if (!handle) return false;
    if (handle.status === "completed" || handle.status === "error" || handle.status === "aborted") return false;

    const formattedMessage = senderName
      ? `[Message from "${senderName}"]\n${message}`
      : message;

    await handle.sendMessage(formattedMessage);
    return true;
  }

  /**
   * Emit a user message event so the TUI feed can display it.
   */
  emitUserMessage(agentId: string, agentName: string, message: string): void {
    this.managerEvents.emit("agent:user-message", { agentId, agentName, message, timestamp: Date.now() });
  }

  // ─── Inter-Agent Messaging ──────────────────────────────────────

  /**
   * Get the messaging config for an agent. Returns default config if none set.
   */
  getMessagingConfig(agentId: string): MessagingConfig {
    return this.agentMessagingConfigs.get(agentId) || { ...DEFAULT_MESSAGING_CONFIG };
  }

  /**
   * Check if one agent is permitted to send a message to another.
   * Both sender's canSendTo and receiver's canReceiveFrom must allow it.
   */
  checkMessagingPermission(fromId: string, toId: string): { allowed: boolean; reason?: string } {
    const fromHandle = this.getAgent(fromId);
    const toHandle = this.getAgent(toId);
    if (!fromHandle || !toHandle) return { allowed: false, reason: "Agent not found" };

    const fromConfig = this.getMessagingConfig(fromId);
    const toConfig = this.getMessagingConfig(toId);

    // Check sender's canSendTo
    const canSend = fromConfig.canSendTo === "*"
      || (Array.isArray(fromConfig.canSendTo) && fromConfig.canSendTo.includes(toHandle.name));
    if (!canSend) {
      return { allowed: false, reason: `Agent "${fromHandle.name}" is not permitted to send messages to "${toHandle.name}"` };
    }

    // Check receiver's canReceiveFrom
    const canReceive = toConfig.canReceiveFrom === "*"
      || (Array.isArray(toConfig.canReceiveFrom) && toConfig.canReceiveFrom.includes(fromHandle.name));
    if (!canReceive) {
      return { allowed: false, reason: `Agent "${toHandle.name}" does not accept messages from "${fromHandle.name}"` };
    }

    return { allowed: true };
  }

  /**
   * Check if an agent has reached its message send limit.
   */
  isMessageLimitReached(agentId: string): boolean {
    const config = this.getMessagingConfig(agentId);
    const count = this.messageCounts.get(agentId) || 0;
    return count >= config.maxMessages;
  }

  /**
   * Detect message loops between two agents.
   * Returns true if there are too many messages between the same pair recently.
   */
  private detectLoop(fromId: string, toId: string): boolean {
    const now = Date.now();
    // Clean old entries (older than 15 seconds)
    this.messageHistory = this.messageHistory.filter((m) => now - m.timestamp < 15_000);

    // Count messages between this pair in last 15 seconds
    const pairCount = this.messageHistory.filter((m) =>
      (m.from === fromId && m.to === toId) || (m.from === toId && m.to === fromId)
    ).length;

    return pairCount >= 6;
  }

  /**
   * Route a message from one agent to another.
   * Performs permission checks, rate limiting, and loop detection.
   */
  async routeMessage(msg: InterAgentMessage): Promise<{ success: boolean; error?: string }> {
    // 1. Permission check
    const perm = this.checkMessagingPermission(msg.fromId, msg.toId);
    if (!perm.allowed) {
      return { success: false, error: perm.reason };
    }

    // 2. Rate limit check
    if (this.isMessageLimitReached(msg.fromId)) {
      return { success: false, error: `Agent "${msg.fromName}" has reached its message limit` };
    }

    // 3. Loop detection
    if (this.detectLoop(msg.fromId, msg.toId)) {
      return { success: false, error: `Message loop detected between "${msg.fromName}" and "${msg.toName}"` };
    }

    // 4. Find target handle
    const target = this.getAgent(msg.toId);
    if (!target) {
      return { success: false, error: `Agent "${msg.toName}" not found` };
    }
    if (target.status === "completed" || target.status === "error" || target.status === "aborted") {
      return { success: false, error: `Agent "${msg.toName}" is ${target.status}` };
    }

    // 5. Format message
    const formattedMessage = `[Message from agent "${msg.fromName}"]\n${msg.message}`;

    // 6. Deliver
    try {
      if (msg.priority === "urgent") {
        await target.steer(formattedMessage);
      } else {
        await target.sendMessage(formattedMessage);
      }
    } catch (err: any) {
      return { success: false, error: `Delivery failed: ${err.message}` };
    }

    // 7. Record for rate limiting and loop detection
    this.messageCounts.set(msg.fromId, (this.messageCounts.get(msg.fromId) || 0) + 1);
    this.messageHistory.push({ from: msg.fromId, to: msg.toId, timestamp: Date.now() });

    // 8. Emit events for TUI
    this.managerEvents.emit("agent:message-sent", {
      agentId: msg.fromId,
      targetName: msg.toName,
      message: msg.message,
    });
    this.managerEvents.emit("agent:message-received", {
      agentId: msg.toId,
      sourceName: msg.fromName,
      message: msg.message,
    });

    return { success: true };
  }

  /**
   * Check if a messaging config has any send permissions (not empty).
   */
  private hasAnySendPermission(config: MessagingConfig): boolean {
    return config.canSendTo === "*" || (Array.isArray(config.canSendTo) && config.canSendTo.length > 0);
  }

  // ─── Start Failure Recovery ──────────────────────────────────────

  /**
   * Handle a failed start() — update agent status and emit failure event
   * so the TUI and main agent are properly notified instead of hanging forever.
   */
  private handleStartFailure(handle: AgentHandle, err: any): void {
    // Only act if the agent is still in a non-terminal state
    if (handle.status === "completed" || handle.status === "error" || handle.status === "aborted") {
      return;
    }

    handle.status = "error";
    handle.completedAt = Date.now();

    const errorMsg = err?.message || String(err) || "Unknown startup error";

    // Emit failure event so handleAgentEvent picks it up
    // and routes to onAgentFailed → notifies main agent
    const event: AgentEvent = {
      type: "agent:failed",
      agentId: handle.id,
      agentName: handle.name,
      timestamp: Date.now(),
      error: errorMsg,
      usage: handle.getUsage(),
    } as any;

    this.handleAgentEvent(handle, event);
  }

  // ─── Event Handling ─────────────────────────────────────────────

  private handleAgentEvent(handle: AgentHandle, event: AgentEvent): void {
    // Skip all event processing during destroyAll() to prevent cascading errors
    if (this.destroying) return;
    // Ignore events from agents no longer managed (e.g., late subprocess events after destroyAll)
    if (!this.agents.has(handle.id) && !this.completedAgents.has(handle.id)) return;

    this.runHooks(handle, event);

    // Forward to manager listeners (TUI widget refresh)
    this.managerEvents.emit("agent:event", handle, event);

    // Task done → notify main agent but keep the subagent alive (idle).
    // Only failure/abort actually removes the agent.
    if (event.type === "agent:completed") {
      const wasGracefulShutdown = (event as any).gracefulShutdown;
      if (wasGracefulShutdown) {
        this.onAgentGracefulShutdown(handle);
      } else {
        this.onAgentTaskDone(handle, (event as any).output || handle.getLastOutput());
      }
    } else if (event.type === "agent:failed") {
      this.onAgentFailed(handle, (event as any).error || "Unknown error");
    } else if (event.type === "agent:aborted") {
      this.onAgentAborted(handle);
    }
  }

  // ─── Hooks ──────────────────────────────────────────────────────

  private runHooks(handle: AgentHandle, event: AgentEvent): void {
    const hookEngine = this.hookEngines.get(handle.id);
    if (!hookEngine) return;

    setActiveAbortCallback(() => handle.abort());

    hookEngine.evaluate(event, {
      notify: (msg: string, level?: string) => {
        try {
          this.pi.sendMessage({
            customType: "subagent-notification",
            content: `[${handle.name}] ${msg}`,
            display: true,
            details: { agentId: handle.id, agentName: handle.name, level },
          });
        } catch { /* ignore */ }
      },
      log: (msg: string) => {
        console.error(`[subagent:${handle.name}] ${msg}`);
      },
    }).catch((err) => {
      console.error(`[subagent] Hook evaluation error:`, err);
    });

    setActiveAbortCallback(null);
  }

  // ─── Completion Handlers ────────────────────────────────────────

  private onAgentTaskDone(handle: AgentHandle, output: string): void {
    // Prevent double notification — completion timer in subprocess-agent should
    // already prevent this, but guard here as a safety net.
    if (this.completionNotified.has(handle.id)) return;
    this.completionNotified.add(handle.id);

    // Mark agent as completed so TUI can reflect the final state.
    handle.status = "completed";
    handle.completedAt = Date.now();

    // Move to completedAgents so it fades out then gets removed.
    this.agents.delete(handle.id);
    this.completedAgents.set(handle.id, handle);

    // Result goes to both LLM context and TUI display.
    this.pi.sendMessage(
      {
        customType: "subagent-result",
        content: `Agent "${handle.name}" completed its task:\n\n${output}`,
        display: true,
        details: {
          agentId: handle.id,
          agentName: handle.name,
          agentColor: handle.color,
          output,
          usage: handle.getUsage(),
          runtimeMode: handle.runtimeMode,
        },
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );

    // Remove from bar after 3s fade-out.
    this.scheduleRemoval(handle.id, 2_000);
    this.managerEvents.emit("agent:completed", handle);
  }

  private onAgentFailed(handle: AgentHandle, error: string): void {
    this.agents.delete(handle.id);
    this.completedAgents.set(handle.id, handle);

    // Error goes to LLM context only (display: false).
    this.pi.sendMessage(
      {
        customType: "subagent-error",
        content: `Agent "${handle.name}" failed: ${error}`,
        display: false,
        details: {
          agentId: handle.id,
          agentName: handle.name,
          agentColor: handle.color,
          error,
          usage: handle.getUsage(),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );

    this.scheduleRemoval(handle.id);
    this.managerEvents.emit("agent:failed", handle);
  }

  private onAgentAborted(handle: AgentHandle): void {
    this.agents.delete(handle.id);
    this.completedAgents.set(handle.id, handle);

    // Abort goes to LLM context only (display: false).
    this.pi.sendMessage(
      {
        customType: "subagent-error",
        content: `Agent "${handle.name}" was aborted.`,
        display: false,
        details: {
          agentId: handle.id,
          agentName: handle.name,
          agentColor: handle.color,
          error: "Aborted",
          usage: handle.getUsage(),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );

    this.scheduleRemoval(handle.id);
    this.managerEvents.emit("agent:aborted", handle);
  }

  private onAgentGracefulShutdown(handle: AgentHandle): void {
    // Move to completed agents without notification (already notified when task completed)
    this.agents.delete(handle.id);
    this.completedAgents.set(handle.id, handle);
    this.scheduleRemoval(handle.id);
    this.managerEvents.emit("agent:completed", handle);
  }

  private scheduleRemoval(agentId: string, delayMs: number = 10_000): void {
    const existing = this.removalTimers.get(agentId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.completedAgents.delete(agentId);
      this.hookEngines.delete(agentId);
      this.agentMessagingConfigs.delete(agentId);
      this.messageCounts.delete(agentId);
      this.agentTaskIds.delete(agentId);
      this.completionNotified.delete(agentId);
      this.removalTimers.delete(agentId);
      // Detach event handler for this agent
      const tracked = this.agentEventHandlers.get(agentId);
      if (tracked) {
        tracked.handle.off("*", tracked.handler);
        this.agentEventHandlers.delete(agentId);
      }
      this.managerEvents.emit("agent:removed", agentId);
    }, delayMs);

    this.removalTimers.set(agentId, timer);
  }
}
