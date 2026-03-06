/**
 * SubAgent System — SubProcess Agent Runtime
 *
 * Runs predefined agents (.pi/agents/*.md) as separate `pi` processes
 * using `--mode rpc` for bidirectional communication.
 *
 * RPC mode enables:
 *   - Sending prompts/messages to a running agent (stdin JSON commands)
 *   - Receiving structured events (stdout JSON events)
 *   - Steering, follow-up, and abort commands
 *
 * Each agent gets full isolation: separate context window, tools, model.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypedEventEmitter } from "../core/event-emitter.js";
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventHandler,
  AgentHandle,
  AgentMessageInfo,
  AgentRuntimeMode,
  AgentStatus,
  AgentUsageStats,
  ThinkingLevel,
} from "../core/types.js";
import { createEmptyUsageStats } from "../core/types.js";

export class SubProcessAgent implements AgentHandle {
  // Identity
  readonly id: string;
  readonly name: string;
  readonly agentType: string;
  readonly description: string;
  readonly color: string;
  readonly runtimeMode: AgentRuntimeMode = "subprocess";
  readonly task: string;
  readonly systemPrompt: string;

  // State
  status: AgentStatus = "idle";
  readonly startedAt: number;
  completedAt: number | null = null;

  // Internal
  private proc: ChildProcess | null = null;
  private events = new TypedEventEmitter();
  private usage: AgentUsageStats;
  private messages: AgentMessageInfo[] = [];
  private lastOutput = "";
  private turnIndex = 0;
  private tmpPromptDir: string | null = null;
  private tmpPromptPath: string | null = null;
  private cwd: string;
  private thinkingLevel: ThinkingLevel | undefined;
  private rpcReady = false;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private hasReceivedActivity = false;
  private hasEmittedStarted = false;
  private pendingRequests = new Map<string, { resolve: (response: any) => void; reject: (error: Error) => void }>();
  private nextRequestId = 0;
  private modelRegistry: any = null;

  /** Timeout in ms for first activity from subprocess (default: 60s) */
  private static readonly ACTIVITY_TIMEOUT_MS = 60_000;

  /**
   * Delay in ms before treating agent_end as true task completion.
   * After agent_end, the subprocess may trigger auto-retry or auto-compaction
   * which emits events (auto_retry_start, auto_compaction_start, agent_start)
   * BEFORE the new agent loop begins. 500ms is generous — these events arrive
   * within a few ms since they're in the same process event loop.
   */
  private static readonly COMPLETION_DELAY_MS = 500;

  constructor(
    id: string,
    definition: AgentDefinition,
    task: string,
    color: string,
    cwd: string,
    thinkingLevel?: ThinkingLevel,
    modelRegistry?: any,
    displayName?: string,
  ) {
    this.thinkingLevel = thinkingLevel;
    this.modelRegistry = modelRegistry || null;
    this.id = id;
    this.name = displayName || definition.name;
    this.agentType = definition.name;
    this.description = definition.description;
    this.color = color;
    this.task = task;
    this.cwd = cwd;
    this.systemPrompt = definition.systemPrompt;
    this.startedAt = Date.now();
    this.usage = createEmptyUsageStats();
  }

  /**
   * Start the subprocess agent in RPC mode.
   */
  async start(definition: AgentDefinition): Promise<void> {
    this.status = "working";

    // 1. Build args — RPC mode, no session, no -p (stays alive for interaction)
    const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];
    if (definition.model) args.push("--model", definition.model);
    if (definition.tools && definition.tools.length > 0) {
      args.push("--tools", definition.tools.join(","));
    }
    const thinking = definition.thinking || this.thinkingLevel;
    if (thinking && thinking !== "off") {
      args.push("--thinking", thinking);
    }

    // 1b. Resolve API key from parent's ModelRegistry to avoid OAuth lock contention.
    // When multiple subprocess agents start simultaneously, they all contend on
    // auth.json lock for OAuth token refresh. By resolving the key in the parent
    // (which already has it) and passing via --api-key, the subprocess uses a
    // runtime override that bypasses OAuth entirely.
    if (this.modelRegistry && definition.model) {
      try {
        const available = await this.modelRegistry.getAvailable();
        const model = available.find((m: any) => m.id === definition.model);
        if (model) {
          const apiKey = await this.modelRegistry.getApiKeyForProvider(model.provider);
          if (apiKey) {
            args.push("--api-key", apiKey);
          }
        }
      } catch {
        // Best effort — subprocess will try to resolve on its own
      }
    }

    // 2. Write system prompt to temp file if present
    if (definition.systemPrompt.trim()) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      const safeName = definition.name.replace(/[^\w.-]+/g, "_");
      const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
      fs.writeFileSync(filePath, definition.systemPrompt, { encoding: "utf-8", mode: 0o600 });
      this.tmpPromptDir = tmpDir;
      this.tmpPromptPath = filePath;
      args.push("--append-system-prompt", filePath);
    }

    // 3. Spawn pi process with stdin OPEN for RPC commands
    this.proc = spawn("pi", args, {
      cwd: this.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 5. Read JSON events from stdout
    let buffer = "";
    this.proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this.processRpcEvent(line);
      }
    });

    // 6. Capture stderr (for error reporting)
    let stderrBuffer = "";
    this.proc.stderr!.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    // 7. Handle process exit
    this.proc.on("close", (code, signal) => {
      if (buffer.trim()) this.processRpcEvent(buffer);
      this.cancelCompletionTimer();
      this.cleanupTempFiles();

      if (this.status === "aborted") return;


      
      // Reject pending RPC requests
      for (const [id, pending] of this.pendingRequests.entries()) {
        const errorMsg = signal 
          ? `Process terminated by signal ${signal}`
          : `Process exited with code ${code}`;
        pending.reject(new Error(errorMsg));
      }
      this.pendingRequests.clear();
      
      // Handle unexpected exit during startup
      if (this.status === "working" && !this.hasReceivedActivity) {
        this.status = "error";
        this.completedAt = Date.now();
        const errorMsg = signal 
          ? `Process terminated by signal ${signal}` 
          : stderrBuffer.trim() || `Process exited with code ${code} during startup`;
        this.emitAgentEvent("agent:failed", { error: errorMsg, usage: this.getUsage() });
        return;
      }

      if (code !== 0 && this.status !== "completed") {
        this.status = "error";
        this.completedAt = Date.now();
        const errorMsg = signal 
          ? `Process terminated by signal ${signal}`
          : stderrBuffer.trim() || `Process exited with code ${code}`;
        this.emitAgentEvent("agent:failed", { error: errorMsg, usage: this.getUsage() });
      } else if (this.status !== "completed" && this.status !== "error") {
        this.status = "completed";
        this.completedAt = Date.now();
        this.emitAgentEvent("agent:completed", { output: this.lastOutput, usage: this.getUsage() });
      }
    });

    this.proc.on("error", (err) => {
      this.cleanupTempFiles();
      this.status = "error";
      this.completedAt = Date.now();
      
      // Reject pending RPC requests
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error(`Process error: ${err.message}`));
      }
      this.pendingRequests.clear();
      
      this.emitAgentEvent("agent:failed", { error: err.message, usage: this.getUsage() });
    });

    // 8. Give the child a moment to boot (following pi-agent-teams pattern)
    //    This eliminates race conditions without waiting for session_ready events.
    await new Promise((r) => setTimeout(r, 120));
    
    // 9. Send initial task immediately after boot delay and wait for process readiness
    try {
      await this.sendRpcWithResponse({ type: "prompt", message: `Task: ${this.task}` });
    } catch (err) {
      this.status = "error";
      this.completedAt = Date.now();
      this.emitAgentEvent("agent:failed", { 
        error: `Failed to send initial task: ${err.message}`, 
        usage: this.getUsage() 
      });
      return;
    }

    // 10. Start activity timeout — if no events arrive within the timeout,
    //     fail the agent instead of hanging forever in "working" state.
    this.startActivityTimeout();
  }

  /**
   * Process an RPC event/response line from stdout.
   * RPC mode emits the same event types as JSON mode, plus response confirmations.
   */
  private processRpcEvent(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    // Mark RPC as ready on first structured event
    if (!this.rpcReady) {
      this.rpcReady = true;
    }

    // RPC response acknowledgments — handle for request/response pattern
    // These are infrastructure events, NOT real agent activity.
    if (event.type === "response") {
      const response = event as any;
      if (response.id && this.pendingRequests.has(response.id)) {
        const pending = this.pendingRequests.get(response.id)!;
        this.pendingRequests.delete(response.id);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error || "RPC command failed"));
        }
      } else if (!response.success && response.error) {
        // Late error response: session.prompt() failed AFTER the initial success
        // response was already sent and resolved. RPC mode sends success immediately
        // for fire-and-forget prompts, then the async error arrives with the same id.
        // Without this, the error is silently swallowed and the agent hangs until
        // the activity timeout fires.
        this.clearActivityTimeout();
        if (this.status !== "completed" && this.status !== "error" && this.status !== "aborted") {
          this.status = "error";
          this.completedAt = Date.now();
          this.emitAgentEvent("agent:failed", {
            error: `Prompt failed: ${response.error}`,
            usage: this.getUsage(),
          });
        }
      }
      return;
    }

    // Handle session_ready signal from subprocess (infrastructure, not real activity)
    if (event.type === "session_ready") {
      this.rpcReady = true;
      return;
    }

    // Clear activity timeout on first REAL event (after infrastructure early-returns).
    // This prevents session_ready/response from disarming the timeout prematurely.
    if (!this.hasReceivedActivity) {
      this.hasReceivedActivity = true;
      this.clearActivityTimeout();
    }

    // Emit agent:started on first real event if not yet emitted.
    // This ensures the agent is considered "started" even if the subprocess
    // never sends an explicit "agent_start" event.
    if (!this.hasEmittedStarted) {
      this.hasEmittedStarted = true;
      this.emitAgentEvent("agent:started");
    }

    const now = Date.now();

    switch (event.type) {
      case "agent_start":
        // Cancel pending completion — agent is continuing (retry/compaction triggered new loop)
        this.cancelCompletionTimer();
        // agent:started already emitted above on first real event — no-op
        break;

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
          this.messages.push({ type: "text", content: delta.delta, timestamp: now });
          this.emitAgentEvent("message:delta", { text: delta.delta });
        } else if (delta.type === "thinking_delta" && delta.delta) {
          this.status = "thinking";
          this.messages.push({ type: "thinking", content: delta.delta, timestamp: now });
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

      case "agent_end": {
        if (event.messages) {
          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = event.messages[i];
            if (msg.role === "assistant") {
              for (const part of msg.content || []) {
                if (part.type === "text") {
                  this.lastOutput = part.text;
                  break;
                }
              }
              break;
            }
          }
        }

        // In RPC mode, agent_end does NOT mean the task is truly complete.
        // The subprocess may trigger auto-retry (retryable errors) or
        // auto-compaction (context overflow/threshold) AFTER emitting agent_end.
        // These would start a new agent loop via agent.continue().
        //
        // Instead of emitting agent:completed immediately, start a short timer.
        // If auto_retry_start, auto_compaction_start, or a new agent_start
        // arrives before the timer fires, we cancel it — the agent is continuing.
        // If the timer fires, the task is truly done.
        this.status = "idle";
        this.startCompletionTimer();
        break;
      }

      // ─── Auto-retry / Auto-compaction events ─────────────────────
      // These arrive AFTER agent_end but BEFORE the new agent loop starts.
      // They signal that the subprocess decided to continue working.

      case "auto_retry_start": {
        this.cancelCompletionTimer();
        this.status = "working";
        break;
      }

      case "auto_retry_end": {
        // If retry failed (max retries exceeded), the subprocess won't start
        // a new agent loop — let the next agent_end or process exit handle completion.
        break;
      }

      case "auto_compaction_start": {
        this.cancelCompletionTimer();
        this.status = "working";
        break;
      }

      case "auto_compaction_end": {
        // After compaction, the subprocess may call agent.continue() (overflow retry)
        // or not (threshold compaction without queued messages). Either way, a new
        // agent_start or process exit will follow.
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
    this.cancelCompletionTimer();
    const wasIdle = this.status === "idle";

    if (wasIdle) {
      // Graceful shutdown of idle agent (already completed its task)
      this.status = "completed";
      this.completedAt = Date.now();
      this.sendRpc({ type: "abort" });
      setTimeout(() => this.killProcess(), 2000);
      this.cleanupTempFiles();
      this.emitAgentEvent("agent:completed", {
        output: this.lastOutput,
        usage: this.getUsage(),
        gracefulShutdown: true,
      });
    } else {
      // Actual abort of working/thinking agent
      this.status = "aborted";
      this.completedAt = Date.now();
      this.sendRpc({ type: "abort" });
      setTimeout(() => this.killProcess(), 5000);
      this.cleanupTempFiles();
      this.emitAgentEvent("agent:aborted", { usage: this.getUsage() });
    }
  }

  async steer(message: string): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    if (this.status !== "working" && this.status !== "thinking") return;

    this.sendRpc({ type: "steer", message });
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.proc || this.proc.killed) {
      throw new Error(`Agent "${this.name}" process is not running`);
    }
    if (this.status === "completed" || this.status === "error" || this.status === "aborted") {
      throw new Error(`Cannot send message to ${this.status} agent "${this.name}"`);
    }

    // Use prompt with followUp behavior so it doesn't interrupt current work
    this.sendRpc({
      type: "prompt",
      message,
      streamingBehavior: "followUp",
    });
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

  /**
   * Start a delayed completion timer after agent_end.
   * If no continuation signal (agent_start, auto_retry_start, auto_compaction_start)
   * arrives within COMPLETION_DELAY_MS, emit agent:completed for real.
   */
  private startCompletionTimer(): void {
    this.cancelCompletionTimer();
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      // Only complete if still in a non-terminal state
      if (this.status === "idle" || this.status === "working" || this.status === "thinking") {
        this.emitAgentEvent("agent:completed", { output: this.lastOutput, usage: this.getUsage() });
      }
    }, SubProcessAgent.COMPLETION_DELAY_MS);
  }

  private cancelCompletionTimer(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }

  private sendRpc(cmd: object): void {
    if (!this.proc || this.proc.killed || !this.proc.stdin || this.proc.stdin.destroyed) {
      return;
    }
    try {
      const message = JSON.stringify(cmd) + "\n";
      this.proc.stdin.write(message);
    } catch (err) {
      // Silent
    }
  }

  private async sendRpcWithResponse(cmd: any): Promise<any> {
    if (!this.proc || this.proc.killed || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("Process is not running");
    }
    
    const id = `req-${this.name}-${this.nextRequestId++}`;
    const fullCmd = { id, ...cmd };
    
    return new Promise<any>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      // 10 second timeout for RPC response
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout waiting for RPC response (id=${id}, cmd=${cmd.type})`));
        }
      }, 10000);
      
      const originalResolve = resolve;
      const originalReject = reject;
      
      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          originalResolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        }
      });
      
      try {
        const message = JSON.stringify(fullCmd) + "\n";
        this.proc!.stdin!.write(message);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Exception sending RPC: ${err.message}`));
      }
    });
  }

  private startActivityTimeout(): void {
    this.activityTimer = setTimeout(() => {
      if (this.hasReceivedActivity) return;
      if (this.status === "completed" || this.status === "error" || this.status === "aborted") return;


      this.status = "error";
      this.completedAt = Date.now();
      this.emitAgentEvent("agent:failed", {
        error: `Agent failed to start: no activity within ${SubProcessAgent.ACTIVITY_TIMEOUT_MS / 1000} seconds`,
        usage: this.getUsage(),
      });

      // Kill the subprocess since it's unresponsive
      this.killProcess();
      this.cleanupTempFiles();
    }, SubProcessAgent.ACTIVITY_TIMEOUT_MS);
  }

  private clearActivityTimeout(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }



  private killProcess(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin?.end();
      } catch { /* ignore */ }
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  /**
   * Force kill the process immediately without waiting.
   * Used during session shutdown for immediate cleanup.
   *
   * Always kills the process and cleans up temp files, even if the agent
   * is already in a terminal state — prevents zombie subprocesses when
   * the agent completed before destroyAll() ran.
   */
  async forceKill(): Promise<void> {
    this.clearActivityTimeout();
    this.cancelCompletionTimer();

    if (this.proc && !this.proc.killed) {
      // Detach all event handlers BEFORE killing to prevent late events
      // (buffered stdout data, close events) from being processed
      this.proc.stdout?.removeAllListeners();
      this.proc.stderr?.removeAllListeners();
      this.proc.removeAllListeners("close");
      this.proc.removeAllListeners("error");

      try {
        this.proc.stdin?.end();
      } catch { /* ignore */ }

      // Send SIGKILL directly, no graceful waiting
      this.proc.kill("SIGKILL");
    }

    this.cleanupTempFiles();

    // Reject any pending RPC requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Agent force-killed during session shutdown"));
    }
    this.pendingRequests.clear();

    // Update status only if not already terminal
    if (this.status !== "aborted" && this.status !== "error") {
      this.status = "aborted";
      this.completedAt = this.completedAt || Date.now();
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

  private cleanupTempFiles(): void {
    if (this.tmpPromptPath) {
      try { fs.unlinkSync(this.tmpPromptPath); } catch { /* ignore */ }
    }
    if (this.tmpPromptDir) {
      try { fs.rmdirSync(this.tmpPromptDir); } catch { /* ignore */ }
    }
    this.tmpPromptPath = null;
    this.tmpPromptDir = null;
  }
}
