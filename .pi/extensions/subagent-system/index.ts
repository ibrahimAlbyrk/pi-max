/**
 * SubAgent System — Extension Entry Point
 *
 * Modular, async subagent infrastructure for pi CLI.
 * Registers tools (spawn_agent, stop_agent, list_agents),
 * commands (/agents), shortcuts (Ctrl+Shift+A), and TUI components.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, Container } from "@mariozechner/pi-tui";
import { AgentManager } from "./core/agent-manager.js";
import { AgentRegistry } from "./core/agent-registry.js";
import { HookEngine } from "./core/hook-engine.js";
import { registerBuiltinActions } from "./hooks/builtin-actions.js";
import { setupTUI } from "./tui/setup.js";
import { getStatusIcon } from "./tui/colors.js";
import type { AgentEvent, AgentHandle, AgentToolStartEvent, AgentMessageDeltaEvent } from "./core/types.js";

export default function (pi: ExtensionAPI) {
  // ─── 1. Registry — agent discovery ──────────────────────────────
  const registry = new AgentRegistry();

  // ─── 2. Hook engine factory ─────────────────────────────────────
  const createHookEngine = (): HookEngine => {
    const engine = new HookEngine();
    registerBuiltinActions(engine, pi);
    return engine;
  };

  // ─── 3. Custom action registration listener ─────────────────────
  pi.events.on("subagent:register-action", ({ name, handler }: any) => {
    // This will be used by extensions registering custom actions
    // Each agent gets its own hook engine, but we can register globally
    console.error(`[subagent] Custom action registered: ${name}`);
  });

  // ─── 4. Agent manager ──────────────────────────────────────────
  let cwd = process.cwd();
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
  });

  const manager = new AgentManager(pi, registry, createHookEngine, cwd);

  // ─── 5. Register tools ─────────────────────────────────────────

  // spawn_agent — Foreground (default) or background agent spawning
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    sideEffects: false, // Enables parallel execution of multiple spawn_agent calls
    description: [
      "Spawn a subagent for delegated tasks.",
      "",
      "Default is foreground (blocking): waits until agent completes, returns result inline.",
      "Set background=true only when you need to continue working while the agent runs.",
      "",
      "When to use:",
      "\u2022 Any task requiring reading, searching, or analyzing code",
      "\u2022 You don't know which files to look at",
      "\u2022 Task needs more than 1 file read",
      "",
      "When NOT to use:",
      "\u2022 Reading a single known file you're about to edit \u2014 use read directly",
      "",
      "Modes:",
      "\u2022 Predefined: 'agent' + 'task' only. System loads config automatically.",
      "\u2022 Runtime: 'name' + 'systemPrompt' + 'task' for custom agents.",
      "",
      "Execution:",
      "\u2022 Default: BLOCKS until agent completes. Result returned inline. No extra turn needed.",
      "\u2022 background=true: Returns immediately. Result delivered as followUp (costs an extra turn).",
      "\u2022 Multiple foreground agents in the same turn run in parallel automatically.",
    ].join("\n"),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({
        description: "Predefined agent name (e.g., 'explorer', 'worker'). Config loads automatically.",
      })),
      name: Type.Optional(Type.String({
        description: "Runtime mode only: custom agent name. Ignored if 'agent' is set.",
      })),
      description: Type.Optional(Type.String({
        description: "Runtime mode only: agent purpose. Ignored if 'agent' is set.",
      })),
      systemPrompt: Type.Optional(Type.String({
        description: "Runtime mode only: system prompt. Ignored if 'agent' is set.",
      })),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "Override: tool list. Available tools are all built-in tools registered in the tool registry.",
      })),
      model: Type.Optional(Type.String({
        description: "Override: model to use.",
      })),
      thinking: Type.Optional(Type.String({
        description: "Override: thinking verbosity. Values: off,minimal,low,medium,high,xhigh.",
      })),
      task: Type.String({
        description: "The task/instruction for the agent.",
      }),
      taskIds: Type.Optional(Type.Array(Type.Number(), {
        description: "Task IDs to assign to this agent. Task details are injected into the agent's system prompt.",
      })),
      background: Type.Optional(Type.Boolean({
        description: "If true, runs agent in background and returns immediately (result delivered as followUp). " +
                     "Default is false (foreground): blocks until agent completes, returns result inline. " +
                     "Only use background when you have your own parallel work to do alongside the agent.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        // Validate parameter combinations
        if (params.agent) {
          // Predefined mode - warn about ignored parameters
          const ignoredParams = [];
          if (params.systemPrompt) ignoredParams.push('systemPrompt');
          if (params.name) ignoredParams.push('name');
          if (params.description) ignoredParams.push('description');
          if (ignoredParams.length > 0) {
            console.warn(`[spawn_agent] Predefined agent "${params.agent}" ignores: ${ignoredParams.join(', ')}`);
          }
        } else {
          // Runtime mode - require essential parameters
          if (!params.name) {
            throw new Error('Runtime mode requires "name" parameter');
          }
          if (!params.systemPrompt) {
            throw new Error('Runtime mode requires "systemPrompt" parameter');
          }
        }

        const isForeground = !params.background; // default: foreground (background must be explicitly true)

        // Acquire concurrency pool slot (may wait if pool is full)
        const slotRelease = await manager.acquireSlot(_signal);

        // Update cwd from context
        const currentCwd = ctx.cwd || cwd;

        const handle = manager.spawn({
          agent: params.agent,
          name: params.name,
          description: params.description,
          systemPrompt: params.systemPrompt,
          tools: params.tools,
          model: params.model,
          thinking: params.thinking as any,
          task: params.task,
          taskIds: params.taskIds,
          _isForeground: isForeground,
        });

        if (isForeground) {
          // ── FOREGROUND: Block until agent completes ──────────────
          const result = await new Promise<{ output: string; failed: boolean }>((resolve) => {
            let settled = false;
            const settle = (output: string, failed: boolean) => {
              if (settled) return;
              settled = true;
              handle.off("*", onEvent);
              manager.unregisterFgResolver(handle.id);
              slotRelease();
              resolve({ output, failed });
            };

            const onEvent = (event: AgentEvent) => {
              // Progress updates via tool_execution_update callback
              if (_onUpdate && (event.type === "tool:start" || event.type === "message:delta")) {
                _onUpdate({
                  content: [{ type: "text", text: formatProgressLine(handle, event) }],
                  details: { agentId: handle.id, agentName: handle.name, status: handle.status },
                });
              }

              if (event.type === "agent:completed") {
                settle((event as any).output || handle.getLastOutput(), false);
              } else if (event.type === "agent:failed") {
                settle((event as any).error || "Agent failed", true);
              } else if (event.type === "agent:aborted") {
                settle("[Agent was aborted]", true);
              }
            };
            handle.on("*", onEvent);

            // Register fg→bg resolver: called by manager.moveToBg() (triggered by Ctrl+Shift+B)
            manager.registerFgResolver(handle.id, () => {
              if (settled) return;
              handle.off("*", onEvent);
              // Do NOT release slot — agent still running in background
              settled = true;
              resolve({ output: "[Agent moved to background \u2014 results will be delivered separately]", failed: false });
            });

            // Also handle abort signal (e.g., user aborts the entire agent run)
            if (_signal) {
              const onAbort = () => {
                if (settled) return;
                handle.off("*", onEvent);
                manager.unregisterFgResolver(handle.id);
                manager.moveToBg(handle.id);
                settled = true;
                resolve({ output: "[Agent moved to background \u2014 results will be delivered separately]", failed: false });
              };
              if (_signal.aborted) {
                onAbort();
              } else {
                _signal.addEventListener("abort", onAbort, { once: true });
              }
            }
          });

          if (result.failed) {
            return {
              content: [{ type: "text", text: `Agent "${handle.name}" failed: ${result.output}` }],
              details: {
                agentId: handle.id,
                agentName: handle.name,
                mode: "foreground",
                usage: handle.getUsage(),
              },
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: result.output }],
            details: {
              agentId: handle.id,
              agentName: handle.name,
              mode: "foreground",
              runtimeMode: handle.runtimeMode,
              usage: handle.getUsage(),
            },
          };
        }

        // ── BACKGROUND: Return immediately ──────────────────────
        slotRelease(); // Release slot tracking — bg agents manage their own lifecycle
        // Note: The agent is still running and occupying resources, but the
        // concurrency slot is released because bg agents are fire-and-forget
        // from the tool's perspective. The pool tracks active agent count
        // separately for resource limiting.

        const mode = params.agent ? 'predefined' : 'runtime';
        return {
          content: [{
            type: "text",
            text: `Agent "${handle.name}" spawned (${mode} mode).\n` +
                  `Runtime: ${handle.runtimeMode}.\n` +
                  `Results will be delivered by the system as a notification when the agent completes.`,
          }],
          details: {
            agentId: handle.id,
            agentName: handle.name,
            runtimeMode: handle.runtimeMode,
            spawnMode: mode,
            mode: "background",
            task: params.task,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to spawn agent: ${err.message}` }],
          isError: true,
        };
      }
    },

    renderCall(args, options, theme) {
      const expanded = options?.expanded ?? true;
      const agentName = args.agent || args.name || "runtime";
      const task = args.task || "...";
      const isBg = args.background === true;

      if (!isBg) {
        // ── Foreground: compact single-line with spinner dot ──
        // Designed to stack visually as a group when multiple agents run
        const firstLine = task.split("\n")[0];
        const taskPreview = firstLine.length > 70 ? firstLine.slice(0, 70) + "\u2026" : firstLine;
        let text = theme.fg("accent", "\u25CB "); // ○ open circle (pending)
        text += theme.fg("toolTitle", theme.bold(agentName));
        text += theme.fg("dim", "  " + taskPreview);
        return new Text(text, 0, 0);
      }

      // ── Background: full display ──
      let text = theme.fg("toolTitle", theme.bold("spawn_agent "));
      text += theme.fg("accent", agentName);
      text += " " + theme.fg("muted", "(background)");

      if (expanded) {
        const taskLines = task.split("\n");
        for (const line of taskLines) {
          text += "\n  " + theme.fg("dim", line);
        }
      } else {
        const firstLine = task.split("\n")[0];
        const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + "\u2026" : firstLine;
        text += "\n  " + theme.fg("dim", preview);
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      if (args.model) {
        text += "\n  " + theme.fg("muted", `[model: ${args.model}]`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as any;

      if (result.isError) {
        const agentName = details?.agentName || "agent";
        const errorText = result.content[0];
        const errorMsg = errorText?.type === "text" ? errorText.text : "Failed";
        // Compact error line matching the group style
        let text = theme.fg("error", "\u2717 "); // ✗
        text += theme.fg("toolTitle", theme.bold(agentName));
        text += theme.fg("error", "  " + errorMsg.split("\n")[0].slice(0, 70));
        return new Text(text, 0, 0);
      }

      const mode = details?.mode || "foreground";

      if (mode === "foreground") {
        const agentName = details?.agentName || "agent";
        const usage = details?.usage;

        if (!expanded) {
          // ── Collapsed: compact completed line ──
          let text = theme.fg("success", "\u2713 "); // ✓
          text += theme.fg("toolTitle", theme.bold(agentName));
          if (usage?.turns) {
            text += theme.fg("dim", `  ${usage.turns}t`);
            if (usage.cost > 0) text += theme.fg("dim", ` $${usage.cost.toFixed(3)}`);
          }
          // Show a brief output preview
          const output = result.content[0];
          if (output?.type === "text" && output.text) {
            const preview = output.text.split("\n").find((l: string) => l.trim()) || "";
            const short = preview.length > 50 ? preview.slice(0, 50) + "\u2026" : preview;
            if (short) text += theme.fg("dim", "  " + short);
          }
          return new Text(text, 0, 0);
        }

        // ── Expanded: show full output ──
        let text = theme.fg("success", "\u2713 "); // ✓
        text += theme.fg("toolTitle", theme.bold(agentName));
        if (usage?.turns) {
          text += theme.fg("dim", `  ${usage.turns}t`);
          if (usage.cost > 0) text += theme.fg("dim", ` $${usage.cost.toFixed(3)}`);
        }
        const output = result.content[0];
        if (output?.type === "text" && output.text) {
          const outputLines = output.text.split("\n");
          for (const line of outputLines) {
            text += "\n" + theme.fg("dim", line);
          }
        }
        return new Text(text, 0, 0);
      }

      // ── Background: spawned status ──
      let text = theme.fg("success", "\u2713 spawned ") +
        theme.fg("dim", `(${details?.runtimeMode || "unknown"})`);

      if (expanded && details?.agentId) {
        text += "\n  " + theme.fg("dim", `Agent: ${details.agentId}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // stop_agent — Stop a running agent
  pi.registerTool({
    name: "stop_agent",
    label: "Stop Agent",
    description: "Stop a running agent by ID or name. Use when agent is stuck, unresponsive, or producing wrong output.",
    parameters: Type.Object({
      agent: Type.String({
        description: "Agent ID or name to stop. Use active_agents to see running agents.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const handle = manager.getAgent(params.agent);

      if (!handle) {
        return {
          content: [{ type: "text", text: `Agent "${params.agent}" not found.` }],
          isError: true,
        };
      }

      const wasIdle = handle.status === "idle";
      const wasWorking = handle.status === "working" || handle.status === "thinking";

      await manager.stop(handle.id);

      let message: string;
      if (wasIdle) {
        message = `Agent "${handle.name}" gracefully shut down. (It had already completed its task)`;
      } else if (wasWorking) {
        message = `Agent "${handle.name}" was aborted. (It was actively working)`;
      } else {
        message = `Agent "${handle.name}" stopped.`;
      }

      return {
        content: [{
          type: "text",
          text: message,
        }],
      };
    },
  });

  // list_agents — Discover available agent types (static definitions only)
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "Discover available agent types before spawning. Do NOT use to check agent progress — results are delivered automatically.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const definitions = manager.getAvailableDefinitions();

      if (definitions.length === 0) {
        return { content: [{ type: "text", text: "No agent definitions found." }] };
      }

      const lines: string[] = [];
      for (const def of definitions) {
        let line = `${def.name} — ${def.description}`;
        if (def.model) line += ` (${def.model})`;
        lines.push(line);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // active_agents — Minimal runtime status of running/recent agents
  pi.registerTool({
    name: "active_agents",
    label: "Active Agents",
    description: "Check status of running agents. Returns one line per agent. Do NOT poll — agent results are delivered automatically when they complete.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const running = manager.getRunningAgents();
      const all = manager.getAllAgents();
      const completed = all.filter(
        (a) => a.status === "completed" || a.status === "error" || a.status === "aborted"
      );

      if (running.length === 0 && completed.length === 0) {
        return { content: [{ type: "text", text: "No active agents." }] };
      }

      const lines: string[] = [];

      for (const agent of running) {
        const usage = agent.getUsage();
        lines.push(`${agent.name}  ${agent.id}  ${agent.status}  ${usage.turns}t  $${usage.cost.toFixed(3)}`);
      }

      if (completed.length > 0) {
        if (running.length > 0) lines.push("--");
        for (const agent of completed) {
          lines.push(`${agent.name}  ${agent.id}  ${agent.status}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // ─── 6. TUI setup ──────────────────────────────────────────────
  setupTUI(pi, manager);

  // ─── 7. /agents command ─────────────────────────────────────────
  pi.registerCommand("agents", {
    description: "List available and running agents",
    handler: async (_args, ctx) => {
      const defs = registry.discover(ctx.cwd);
      const running = manager.getRunningAgents();

      let text = "📋 Agent Definitions:\n";
      if (defs.length === 0) {
        text += "  (none found)\n";
      } else {
        for (const d of defs) {
          text += `  ${d.name}: ${d.description}`;
          if (d.model) text += ` [${d.model}]`;
          text += ` (${d.source})\n`;
        }
      }

      text += `\n🏃 Running Agents (${running.length}):\n`;
      if (running.length === 0) {
        text += "  (none)\n";
      } else {
        for (const a of running) {
          text += `  ${getStatusIcon(a.status)} ${a.name} (${a.id}) — ${a.status}\n`;
        }
      }

      ctx.ui.notify(text, "info");
    },
  });

  // ─── 8. /tell command — send message to running agent ─────────
  pi.registerCommand("tell", {
    description: "Send a message to a running agent: /tell <agentName> <message>",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(" ");
      if (parts.length <= 1) {
        const running = manager.getRunningAgents();
        const keyword = parts[0]?.toLowerCase() || "";
        return running
          .filter((a) => a.name.toLowerCase().startsWith(keyword))
          .map((a) => ({ label: `${a.name} — ${a.status}`, value: a.name + " " }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1 || !args.trim()) {
        ctx.ui.notify("Usage: /tell <agentName> <message>", "warning");
        return;
      }
      const agentName = args.slice(0, spaceIdx).trim();
      const message = args.slice(spaceIdx + 1).trim();

      if (!message) {
        ctx.ui.notify("Usage: /tell <agentName> <message>", "warning");
        return;
      }

      const handle = manager.getAgent(agentName);
      if (!handle) {
        const running = manager.getRunningAgents();
        const names = running.map((a) => a.name).join(", ") || "(none)";
        ctx.ui.notify(`Agent "${agentName}" not found. Running: ${names}`, "error");
        return;
      }

      if (handle.status === "completed" || handle.status === "error" || handle.status === "aborted") {
        ctx.ui.notify(`Agent "${agentName}" is ${handle.status} — cannot send message.`, "warning");
        return;
      }

      try {
        await handle.sendMessage(message);
        // Emit event for TUI feed to show the user message
        manager.emitUserMessage(handle.id, handle.name, message);
        ctx.ui.notify(`📨 Message sent to ${agentName}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to send message to ${agentName}: ${err.message}`, "error");
      }
    },
  });

  // ─── 9. Session shutdown — stop all agents ──────────────────────
  pi.on("session_shutdown", async () => {
    await manager.destroyAll();
  });

  // ─── 9. Session start — capture cwd + thinking level + model ─────
  pi.on("session_start", async (_event, ctx) => {
    // Double safety: destroy any remaining agents from previous session
    await manager.destroyAll();

    cwd = ctx.cwd;
    manager.setCwd(cwd);
    // Inherit main agent's thinking level
    const level = pi.getThinkingLevel?.() as any;
    if (level) manager.setMainThinkingLevel(level);
    // Inherit main agent's model (avoids model resolution issues in subagents)
    if (ctx.model) manager.setMainModel(ctx.model);
    // Store model registry for subprocess API key resolution (avoids OAuth lock contention)
    if (ctx.modelRegistry) manager.setModelRegistry(ctx.modelRegistry);
  });

  // ─── 10. Track thinking level + model changes ──────────────────
  pi.on("turn_start", async (_event, ctx) => {
    const level = pi.getThinkingLevel?.() as any;
    if (level) manager.setMainThinkingLevel(level);
    if (ctx.model) manager.setMainModel(ctx.model);
  });

  pi.on("model_select", async (event: any) => {
    if (event.model) manager.setMainModel(event.model);
  });
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format a 1-line progress string for foreground agent tool_execution_update.
 */
function formatProgressLine(handle: AgentHandle, event: AgentEvent): string {
  const elapsed = formatDuration(Date.now() - handle.startedAt);

  if (event.type === "tool:start") {
    const e = event as AgentToolStartEvent;
    const argSummary = summarizeToolArgs(e.args);
    return `${handle.name}: ${e.toolName}${argSummary ? " " + argSummary : ""} [${elapsed}]`;
  }

  if (event.type === "message:delta") {
    const e = event as AgentMessageDeltaEvent;
    const preview = e.text.slice(0, 60).replace(/\n/g, " ").trim();
    if (preview) {
      return `${handle.name}: writing... "${preview}" [${elapsed}]`;
    }
  }

  return `${handle.name}: ${handle.status} [${elapsed}]`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  if (!args) return "";
  // Show first string arg value as a short preview
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) {
      const preview = value.split("\n")[0];
      return preview.length > 50 ? preview.slice(0, 50) + "\u2026" : preview;
    }
  }
  return "";
}
