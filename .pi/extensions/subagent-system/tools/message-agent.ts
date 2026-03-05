/**
 * SubAgent System — message_agent Tool
 *
 * A tool that allows agents to send messages to other running agents.
 * This tool is injected into an agent's tool set only if the agent
 * has messaging permissions configured.
 *
 * Permission enforcement:
 *   - Sender's `canSendTo` must include target agent name (or "*")
 *   - Receiver's `canReceiveFrom` must include sender name (or "*")
 *   - Rate limiting per agent session
 *   - Loop detection between agent pairs
 */

import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { AgentManager } from "../core/agent-manager.js";
import type { AgentHandle, InterAgentMessage } from "../core/types.js";

/**
 * Create a message_agent tool bound to a specific agent.
 * The tool knows its own agent identity for permission checks.
 */
export function createMessageAgentTool(manager: AgentManager, ownerHandle: AgentHandle) {
  return {
    name: "message_agent",
    label: "Message Agent",
    description: [
      "Send a message to another running agent for coordination.",
      "The message will be delivered to the target agent's context.",
      "Use this to share findings, request action, or coordinate work.",
      "",
      "Priority:",
      '- "normal" (default): Message queued, delivered after agent\'s current work',
      '- "urgent": Message interrupts agent\'s current work immediately',
      "",
      "You can only message agents you have permission to communicate with.",
    ].join("\n"),
    parameters: Type.Object({
      to: Type.String({
        description: "Name of the target agent to send the message to",
      }),
      message: Type.String({
        description: "The message content to send",
      }),
      priority: Type.Optional(Type.Union([
        Type.Literal("normal"),
        Type.Literal("urgent"),
      ], {
        description: 'Message priority. "normal" (default) queues after current work, "urgent" interrupts immediately.',
      })),
    }),

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      const { to, message, priority = "normal" } = params;

      // Find target agent
      const targetHandle = manager.getAgent(to);
      if (!targetHandle) {
        const running = manager.getRunningAgents();
        const names = running.map((a) => a.name).join(", ") || "(none)";
        return {
          content: [{ type: "text", text: `Agent "${to}" not found. Running agents: ${names}` }],
          isError: true,
        };
      }

      // Route message through manager (handles permissions, rate limiting, loop detection)
      const msg: InterAgentMessage = {
        fromId: ownerHandle.id,
        fromName: ownerHandle.name,
        toId: targetHandle.id,
        toName: targetHandle.name,
        message,
        priority,
        timestamp: Date.now(),
      };

      const result = await manager.routeMessage(msg);

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Message sent to "${targetHandle.name}" (priority: ${priority}).`,
        }],
      };
    },

    renderCall(args: any, _options: any, theme: any) {
      const to = args.to || "?";
      const msg = args.message || "...";
      const priority = args.priority || "normal";
      const icon = priority === "urgent" ? "⚡" : "📨";

      let text = theme.fg("toolTitle", theme.bold("message_agent "));
      text += `${icon} → ${theme.fg("accent", to)}`;
      const preview = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
      text += "\n  " + theme.fg("dim", preview);

      return new Text(text, 0, 0);
    },

    renderResult(result: any, _opts: any, theme: any) {
      if (result.isError) {
        const errorText = result.content?.[0]?.text || "Failed";
        return new Text(theme.fg("error", errorText), 0, 0);
      }
      const text = result.content?.[0]?.text || "Sent";
      return new Text(theme.fg("success", "✓ ") + theme.fg("dim", text), 0, 0);
    },
  };
}
