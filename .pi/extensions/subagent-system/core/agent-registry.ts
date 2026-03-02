/**
 * SubAgent System — Agent Registry
 *
 * Discovers and loads agent definitions from:
 * - ~/.pi/agent/agents/*.md  (global / user)
 * - .pi/agents/*.md          (project-local, searched upward from cwd)
 *
 * Project-local agents override global agents with the same name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition, HookConfig, MessagingConfig, ThinkingLevel } from "./types.js";
import { DEFAULT_MESSAGING_CONFIG } from "./types.js";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export class AgentRegistry {
  /**
   * Discover all agent definitions from global and project-local directories.
   * Project-local agents override global ones with the same name.
   */
  discover(cwd: string): AgentDefinition[] {
    const agents = new Map<string, AgentDefinition>();

    // 1. Global: ~/.pi/agent/agents/*.md
    const globalDir = path.join(getAgentDir(), "agents");
    for (const def of this.loadFromDir(globalDir, "user")) {
      agents.set(def.name, def);
    }

    // 2. Project-local: .pi/agents/*.md (search upward from cwd)
    const projectDir = this.findProjectAgentsDir(cwd);
    if (projectDir) {
      for (const def of this.loadFromDir(projectDir, "project")) {
        agents.set(def.name, def); // Override global
      }
    }

    return Array.from(agents.values());
  }

  /**
   * Find a specific agent definition by name.
   */
  findByName(cwd: string, name: string): AgentDefinition | undefined {
    return this.discover(cwd).find((d) => d.name === name);
  }

  /**
   * Load agent definitions from a directory.
   */
  private loadFromDir(dir: string, source: "user" | "project"): AgentDefinition[] {
    if (!fs.existsSync(dir)) return [];

    const results: AgentDefinition[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const filePath = path.join(dir, entry.name);

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter<Record<string, any>>(content);

        // Validate required fields
        if (!frontmatter.name || !frontmatter.description) {
          console.error(`[subagent] Skipping ${filePath}: missing name or description`);
          continue;
        }

        // Parse tools (comma-separated string → array)
        const tools = frontmatter.tools
          ?.split(",")
          .map((t: string) => t.trim())
          .filter(Boolean);

        // Parse hooks (YAML object)
        const hooks: HookConfig = frontmatter.hooks && typeof frontmatter.hooks === "object"
          ? frontmatter.hooks
          : {};

        // Parse thinking level
        const thinking = frontmatter.thinking && VALID_THINKING_LEVELS.has(frontmatter.thinking)
          ? frontmatter.thinking as ThinkingLevel
          : undefined;

        // Parse messaging config
        const messaging = parseMessagingConfig(frontmatter.messaging);

        results.push({
          name: frontmatter.name,
          description: frontmatter.description,
          tools: tools && tools.length > 0 ? tools : undefined,
          model: frontmatter.model,
          thinking,
          color: frontmatter.color,
          hooks,
          messaging,
          systemPrompt: body.trim(),
          source,
          filePath,
        });
      } catch (err) {
        console.error(`[subagent] Failed to parse ${filePath}:`, err);
      }
    }

    return results;
  }

  /**
   * Search upward from cwd for .pi/agents/ directory.
   */
  private findProjectAgentsDir(cwd: string): string | null  {
    let dir = cwd;
    while (true) {
      const candidate = path.join(dir, ".pi", "agents");
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // ignore
      }

      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * Parse messaging config from YAML frontmatter.
 *
 * Supported formats:
 *   messaging:
 *     can_send_to: "*"              # or [worker, planner]
 *     can_receive_from: "*"         # or [scout, main]
 *     max_messages: 20
 */
function parseMessagingConfig(raw: any): MessagingConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const canSendTo = parseStringListOrStar(raw.can_send_to);
  const canReceiveFrom = parseStringListOrStar(raw.can_receive_from);
  const maxMessages = typeof raw.max_messages === "number" ? raw.max_messages : DEFAULT_MESSAGING_CONFIG.maxMessages;

  // If no meaningful config, return undefined
  if (canSendTo === undefined && canReceiveFrom === undefined) return undefined;

  return {
    canSendTo: canSendTo ?? DEFAULT_MESSAGING_CONFIG.canSendTo,
    canReceiveFrom: canReceiveFrom ?? DEFAULT_MESSAGING_CONFIG.canReceiveFrom,
    maxMessages,
  };
}

function parseStringListOrStar(value: any): string[] | "*" | undefined {
  if (value === "*" || value === "all") return "*";
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    if (value === "*" || value === "all") return "*";
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
