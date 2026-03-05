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

  // spawn_agent — Async agent spawning
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: [
      "Spawn a subagent for delegated tasks.",
      "",
      "When to use:",
      "• Any task requiring reading, searching, or analyzing code",
      "• You don't know which files to look at",
      "• Task needs more than 1 file read",
      "",
      "When NOT to use:",
      "• Reading a single known file you're about to edit — use read directly",
      "",
      "After spawning:",
      "• Results arrive automatically as new messages — do NOT poll or call list_agents",
      "• STOP immediately — do NOT make any more tool calls or continue working",
      "• Send a brief status to the user and end your turn",
      "",
      "Modes:",
      "• Predefined: 'agent' + 'task' only. System loads config automatically.",
      "• Runtime: 'name' + 'systemPrompt' + 'task' for custom agents.",
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
        });

        const agentLabel = params.agent || params.name || "unnamed";
        const mode = params.agent ? 'predefined' : 'runtime';
        return {
          content: [{
            type: "text",
            text: `Agent "${agentLabel}" started (${mode} mode, id: ${handle.id}).\n` +
                  `Task: ${params.task}\n` +
                  `Runtime: ${handle.runtimeMode}.\n` +
                  `You will be notified when it completes.`,
          }],
          details: {
            agentId: handle.id,
            agentName: handle.name,
            runtimeMode: handle.runtimeMode,
            spawnMode: mode,
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

      let text = theme.fg("toolTitle", theme.bold("spawn_agent "));
      text += theme.fg("accent", agentName);

      if (expanded) {
        const taskLines = task.split("\n");
        for (const line of taskLines) {
          text += "\n  " + theme.fg("dim", line);
        }
      } else {
        const firstLine = task.split("\n")[0];
        const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
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

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;

      if (result.isError) {
        const errorText = result.content[0];
        return new Text(
          theme.fg("error", errorText?.type === "text" ? errorText.text : "Failed"),
          0, 0
        );
      }

      let text = theme.fg("success", "✓ spawned ") +
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
        description: "Agent ID or name to stop. Use list_agents to see running agents.",
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

  // list_agents — List available and running agents
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "Discover available agent types before spawning. Do NOT use to check agent progress — results are delivered automatically.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const definitions = manager.getAvailableDefinitions();
      const running = manager.getRunningAgents();
      const all = manager.getAllAgents();

      let text = "## Available Agent Definitions\n\n";
      if (definitions.length === 0) {
        text += "No agent definitions found in .pi/agents/\n";
      } else {
        for (const def of definitions) {
          text += `- **${def.name}**: ${def.description}`;
          if (def.model) text += ` (model: ${def.model})`;
          if (def.tools) text += ` [tools: ${def.tools.join(", ")}]`;
          text += ` (${def.source})\n`;
        }
      }

      text += "\n## Running Agents\n\n";
      if (running.length === 0) {
        text += "No agents currently running.\n";
      } else {
        for (const agent of running) {
          const usage = agent.getUsage();
          text += `- **${agent.name}** (${agent.id}) — ${agent.status}`;
          text += ` | ${usage.turns} turns | $${usage.cost.toFixed(4)}`;
          text += ` | runtime: ${agent.runtimeMode}\n`;
        }
      }

      if (all.length > running.length) {
        text += "\n## Recently Completed\n\n";
        for (const agent of all) {
          if (agent.status === "completed" || agent.status === "error" || agent.status === "aborted") {
            text += `- **${agent.name}** (${agent.id}) — ${agent.status}\n`;
          }
        }
      }

      return { content: [{ type: "text", text }] };
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
