/**
 * SubAgent System — InProcess Agent Runtime
 *
 * Runs runtime-created agents in the same Node.js process using the pi SDK.
 * Used when the main LLM creates agents on-the-fly with spawn_agent.
 *
 * Uses createAgentSession() to create an isolated agent session.
 */

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { TypedEventEmitter } from "../core/event-emitter.js";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentHandle,
  AgentMessageInfo,
  AgentRuntimeMode,
  AgentStatus,
  AgentUsageStats,
  SpawnOptions,
  ThinkingLevel,
} from "../core/types.js";
import { createEmptyUsageStats } from "../core/types.js";

// Tool name → factory function mapping
const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

function createToolsFromNames(names: string[], cwd: string): any[] {
  const tools: any[] = [];
  for (const name of names) {
    const factory = TOOL_FACTORIES[name.trim()];
    if (factory) {
      tools.push(factory(cwd));
    }
  }
  return tools.length > 0 ? tools : createCodingTools(cwd);
}

/** Optional extra tools to inject into the agent's session (e.g., message_agent) */
export type ExtraToolFactory = (handle: AgentHandle) => any[];

export class InProcessAgent implements AgentHandle {
  // Identity
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly runtimeMode: AgentRuntimeMode = "inprocess";
  readonly task: string;

  // State
  status: AgentStatus = "idle";
  readonly startedAt: number;
  completedAt: number | null = null;

  // Internal
  private session: any = null; // AgentSession
  private events = new TypedEventEmitter();
  private usage: AgentUsageStats;
  private messages: AgentMessageInfo[] = [];
  private lastOutput = "";
  private turnIndex = 0;
  private cwd: string;
  private unsubscribe: (() => void) | null = null;
  private extraToolFactory: ExtraToolFactory | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private hasReceivedActivity = false;

  /** Timeout in ms for first activity from session (default: 30s) */
  private static readonly ACTIVITY_TIMEOUT_MS = 30_000;

  constructor(
    id: string,
    options: SpawnOptions,
    color: string,
    cwd: string,
    extraToolFactory?: ExtraToolFactory,
  ) {
    this.id = id;
    this.name = options.name || "unnamed";
    this.description = options.description || options.task;
    this.color = color;
    this.task = options.task;
    this.cwd = cwd;
    this.startedAt = Date.now();
    this.usage = createEmptyUsageStats();
    this.extraToolFactory = extraToolFactory || null;
  }

  /**
   * Start the in-process agent session.
   */
  async start(options: SpawnOptions): Promise<void> {
    this.status = "working";
    this.emitAgentEvent("agent:started");

    try {
      const authStorage = AuthStorage.create();
      const modelRegistry = new ModelRegistry(authStorage);

      // Resolve model: explicit string → search registry, else inherit main agent's model
      let model: any = undefined;
      if (options.model) {
        // Try to find model by provider/id or just id
        const parts = options.model.split("/");
        if (parts.length === 2) {
          model = modelRegistry.find(parts[0], parts[1]);
        }
        if (!model) {
          // Search all providers
          const available = await modelRegistry.getAvailable();
          model = available.find((m: any) => m.id === options.model || m.id.includes(options.model!));
        }
      }
      // Fallback: use the main agent's model object directly (avoids provider mismatch)
      if (!model && options._mainModel) {
        model = options._mainModel;
      }

      // Create tools
      const tools = options.tools
        ? createToolsFromNames(options.tools, this.cwd)
        : createCodingTools(this.cwd);

      // Inject extra tools (e.g., message_agent for agents with messaging permissions)
      if (this.extraToolFactory) {
        const extraTools = this.extraToolFactory(this);
        tools.push(...extraTools);
      }

      // Create a minimal resource loader with the system prompt
      const systemPrompt = options.systemPrompt || `You are an agent named "${this.name}". Complete the assigned task.`;
      const loader = new DefaultResourceLoader({
        cwd: this.cwd,
        systemPromptOverride: () => systemPrompt,
      });
      await loader.reload();

      // Thinking level: explicit > inherited from main agent > "off"
      const thinkingLevel = (options.thinking || options._mainThinkingLevel || "off") as any;

      // Create session
      const { session } = await createAgentSession({
        cwd: this.cwd,
        model,
        thinkingLevel,
        authStorage,
        modelRegistry,
        tools,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
      });

      this.session = session;

      // Subscribe to events
      this.unsubscribe = session.subscribe((event: any) => {
        this.processSessionEvent(event);
      });

      // Start activity timeout — fail if no events arrive
      this.startActivityTimeout();

      // Send the task (non-blocking — runs in background)
      session.prompt(`Task: ${this.task}`).then(() => {
        this.clearActivityTimeout();
        if (this.status !== "aborted" && this.status !== "error") {
          // Transition to idle — agent can still receive messages.
          // The manager will decide when to actually mark it completed.
          this.status = "idle";

          this.emitAgentEvent("agent:completed", {
            output: this.lastOutput,
            usage: this.getUsage(),
          });
        }
      }).catch((err: Error) => {
        this.clearActivityTimeout();
        if (this.status !== "aborted") {
          this.status = "error";
          this.completedAt = Date.now();

          this.emitAgentEvent("agent:failed", {
            error: err.message,
            usage: this.getUsage(),
          });
        }
      });
    } catch (err: any) {
      this.status = "error";
      this.completedAt = Date.now();

      this.emitAgentEvent("agent:failed", {
        error: err.message || "Failed to start agent",
        usage: this.getUsage(),
      });
    }
  }

  /**
   * Process a session event from the SDK.
   */
  private processSessionEvent(event: any): void {
    // Clear activity timeout on first real event
    if (!this.hasReceivedActivity) {
      this.hasReceivedActivity = true;
      this.clearActivityTimeout();
    }

    const now = Date.now();

    switch (event.type) {
      case "turn_start":
        this.turnIndex++;
        this.status = "working";
        this.emitAgentEvent("turn:start", { turnIndex: this.turnIndex });
        break;

      case "turn_end":
        this.status = "idle";
        this.emitAgentEvent("turn:end", { turnIndex: this.turnIndex });
        break;

      case "message_start":
        this.emitAgentEvent("message:start");
        break;

      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (!delta) break;

        if (delta.type === "text_delta" && delta.delta) {
          this.status = "working";
          this.lastOutput += delta.delta;
          this.messages.push({
            type: "text",
            content: delta.delta,
            timestamp: now,
          });
          this.emitAgentEvent("message:delta", { text: delta.delta });
        } else if (delta.type === "thinking_delta" && delta.delta) {
          this.status = "thinking";
          this.messages.push({
            type: "thinking",
            content: delta.delta,
            timestamp: now,
          });
          this.emitAgentEvent("message:thinking", { text: delta.delta });
        }
        break;
      }

      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant" && msg.usage) {
          this.usage.input += msg.usage.input || 0;
          this.usage.output += msg.usage.output || 0;
          this.usage.cacheRead += msg.usage.cacheRead || 0;
          this.usage.cacheWrite += msg.usage.cacheWrite || 0;
          this.usage.cost += msg.usage.cost?.total || 0;
          this.usage.contextTokens = msg.usage.totalTokens || 0;
          this.usage.turns++;
        }
        this.emitAgentEvent("message:end");
        break;
      }

      case "tool_execution_start": {
        this.status = "working";
        this.messages.push({
          type: "tool_call",
          content: event.toolName || "",
          toolName: event.toolName,
          toolArgs: event.args,
          timestamp: now,
        });
        this.emitAgentEvent("tool:start", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      }

      case "tool_execution_update": {
        this.emitAgentEvent("tool:update", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult?.content?.[0]?.text || "",
        });
        break;
      }

      case "tool_execution_end": {
        const resultText = event.result?.content?.[0]?.text || "";
        this.messages.push({
          type: "tool_result",
          content: resultText.slice(0, 200),
          toolName: event.toolName,
          timestamp: now,
        });
        this.emitAgentEvent("tool:end", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultText,
          isError: event.isError || false,
        });
        break;
      }
    }
  }

  // ─── AgentHandle Implementation ─────────────────────────────────

  on(event: string, handler: AgentEventHandler): void {
    this.events.on(event, handler);
  }

  off(event: string, handler: AgentEventHandler): void {
    this.events.off(event, handler);
  }

  async abort(): Promise<void> {
    if (this.status === "completed" || this.status === "error" || this.status === "aborted") {
      return;
    }

    this.clearActivityTimeout();
    const wasIdle = this.status === "idle";

    if (wasIdle) {
      // Graceful shutdown of idle agent (already completed its task)
      this.status = "completed";
      this.completedAt = Date.now();
      this.cleanup();
      this.emitAgentEvent("agent:completed", {
        output: this.lastOutput,
        usage: this.getUsage(),
        gracefulShutdown: true,
      });
    } else {
      // Actual abort of working/thinking agent
      this.status = "aborted";
      this.completedAt = Date.now();
      this.cleanup();
      this.emitAgentEvent("agent:aborted", {
        usage: this.getUsage(),
      });
    }
  }

  async steer(message: string): Promise<void> {
    if (!this.session || this.status !== "working") return;

    try {
      await this.session.steer(message);
    } catch (err) {
      console.error(`[subagent] Failed to steer agent "${this.name}":`, err);
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.session) {
      throw new Error(`Agent "${this.name}" session not available`);
    }
    if (this.status === "completed" || this.status === "error" || this.status === "aborted") {
      throw new Error(`Cannot send message to ${this.status} agent "${this.name}"`);
    }

    try {
      // Use prompt with followUp behavior: if streaming, queues for later;
      // if idle, sends immediately as a new turn.
      await this.session.prompt(message, { streamingBehavior: "followUp" });
    } catch (err) {
      console.error(`[subagent] Failed to send message to agent "${this.name}":`, err);
      throw err;
    }
  }

  getUsage(): AgentUsageStats {
    return { ...this.usage };
  }

  getMessages(): AgentMessageInfo[] {
    return [...this.messages];
  }

  getLastOutput(): string {
    return this.lastOutput;
  }

  getRecentActivity(): AgentMessageInfo[] {
    return this.messages.slice(-10);
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  private startActivityTimeout(): void {
    this.activityTimer = setTimeout(() => {
      if (this.hasReceivedActivity) return;
      if (this.status === "completed" || this.status === "error" || this.status === "aborted") return;

      console.error(`[subagent] Activity timeout: agent "${this.name}" produced no output within ${InProcessAgent.ACTIVITY_TIMEOUT_MS / 1000}s`);
      this.status = "error";
      this.completedAt = Date.now();
      this.cleanup();
      this.emitAgentEvent("agent:failed", {
        error: `Agent failed to start: no activity within ${InProcessAgent.ACTIVITY_TIMEOUT_MS / 1000} seconds`,
        usage: this.getUsage(),
      });
    }, InProcessAgent.ACTIVITY_TIMEOUT_MS);
  }

  private clearActivityTimeout(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private emitAgentEvent(type: string, extra: Record<string, unknown> = {}): void {
    const event: AgentEvent = {
      type: type as any,
      agentId: this.id,
      agentName: this.name,
      timestamp: Date.now(),
      ...extra,
    };
    this.events.emit(type, event);
    this.events.emit("*", event);
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.session) {
      try { this.session.dispose(); } catch { /* ignore */ }
      this.session = null;
    }
  }
}
