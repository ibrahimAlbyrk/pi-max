/**
 * SubAgent System — Hook Engine
 *
 * Parses YAML hook configurations from agent definitions and evaluates
 * them against incoming agent events. Dispatches matching actions.
 *
 * Supports template interpolation ({agentName}, {toolName}, etc.)
 * and extensible action registration.
 */

import type {
  AgentEvent,
  AgentToolCallEvent,
  AgentToolStartEvent,
  HookActionHandler,
  HookActionResult,
  HookConfig,
  HookMatch,
  HookRule,
} from "./types.js";

export class HookEngine {
  private rules = new Map<string, HookRule[]>();
  private actionRegistry = new Map<string, HookActionHandler>();

  /**
   * Load hook rules from a HookConfig object (from agent frontmatter).
   */
  loadConfig(hookConfig: HookConfig): void {
    this.rules.clear();
    for (const [eventName, rules] of Object.entries(hookConfig)) {
      if (Array.isArray(rules)) {
        // Normalize event names: "tool:call:" → "tool:call"
        const normalizedEvent = eventName.replace(/:$/, "");
        this.rules.set(normalizedEvent, rules);
      }
    }
  }

  /**
   * Register a custom action handler.
   */
  registerAction(name: string, handler: HookActionHandler): void {
    this.actionRegistry.set(name, handler);
  }

  /**
   * Evaluate an event against all matching rules and execute the first matching action.
   */
  async evaluate(
    event: AgentEvent,
    ctx: { notify: (msg: string, level?: string) => void; log: (msg: string) => void }
  ): Promise<HookActionResult | null> {
    const rules = this.rules.get(event.type) || [];

    for (const rule of rules) {
      if (this.matches(rule.match, event)) {
        const handler = this.actionRegistry.get(rule.action);
        if (handler) {
          try {
            // Build params from rule (excluding match and action)
            const params: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(rule)) {
              if (key !== "match" && key !== "action") {
                params[key] = typeof value === "string"
                  ? this.interpolate(value, event)
                  : value;
              }
            }

            const result = await handler(params, event, ctx);
            return result ?? null;
          } catch (err) {
            console.error(`[subagent] Hook action "${rule.action}" error:`, err);
          }
        } else {
          console.error(`[subagent] Unknown hook action: "${rule.action}"`);
        }
      }
    }

    return null;
  }

  /**
   * Check if a rule's match condition matches the given event.
   */
  private matches(match: HookMatch | undefined, event: AgentEvent): boolean {
    if (!match) return true; // No match = always matches

    // Tool name match
    if (match.tool) {
      if (event.type === "tool:call" || event.type === "tool:start") {
        const toolEvent = event as AgentToolCallEvent | AgentToolStartEvent;
        const toolName = "toolName" in toolEvent ? toolEvent.toolName : undefined;
        if (toolName !== match.tool) return false;
      } else {
        return false; // tool match on non-tool event
      }
    }

    // Contains match (search in input JSON)
    if (match.contains) {
      const input = this.getEventInput(event);
      if (!input.includes(match.contains)) return false;
    }

    // Pattern match (regex on input JSON)
    if (match.pattern) {
      const input = this.getEventInput(event);
      try {
        if (!new RegExp(match.pattern).test(input)) return false;
      } catch {
        return false; // Invalid regex
      }
    }

    // Path match (glob-like, simplified)
    if (match.path) {
      const eventPath = this.getEventPath(event);
      if (!this.matchGlob(eventPath, match.path)) return false;
    }

    return true;
  }

  /**
   * Extract input as string from an event for matching.
   */
  private getEventInput(event: AgentEvent): string {
    if ("input" in event) return JSON.stringify((event as any).input || "");
    if ("args" in event) return JSON.stringify((event as any).args || "");
    return "";
  }

  /**
   * Extract file path from an event (for path glob matching).
   */
  private getEventPath(event: AgentEvent): string {
    const e = event as any;
    return e.input?.path || e.args?.path || e.input?.file_path || e.args?.file_path || "";
  }

  /**
   * Simple glob matching (supports * and **).
   */
  private matchGlob(value: string, pattern: string): boolean {
    if (!value || !pattern) return false;

    // Convert glob to regex
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§DOUBLESTAR§")
      .replace(/\*/g, "[^/]*")
      .replace(/§DOUBLESTAR§/g, ".*");

    try {
      return new RegExp(`^${regexStr}$`).test(value);
    } catch {
      return false;
    }
  }

  /**
   * Interpolate {placeholders} in a message template.
   */
  private interpolate(template: string, event: AgentEvent): string {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      switch (key) {
        case "agentName": return event.agentName;
        case "agentId": return event.agentId;
        case "toolName": {
          const e = event as any;
          return e.toolName || "";
        }
        case "path": {
          return this.getEventPath(event);
        }
        case "command": {
          const e = event as any;
          return e.input?.command || e.args?.command || "";
        }
        case "turnIndex": {
          const e = event as any;
          return String(e.turnIndex ?? "");
        }
        default: return match;
      }
    });
  }
}
