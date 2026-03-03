/**
 * SubAgent System — Agent Registry
 *
 * Discovers and loads agent definitions from (lowest to highest priority):
 * - Built-in agents from prompt registry (packages/prompt/templates/agents/)
 * - ~/.pi/agent/agents/*.md  (global / user)
 * - .pi/agents/*.md          (project-local, searched upward from cwd)
 *
 * Higher priority sources override lower priority ones with the same name.
 * Built-in agents support template features (variables, extends, includes).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { createPromptRegistry, getTemplatesDir, type PromptRegistry } from "@mariozechner/pi-prompt";
import type { AgentDefinition, HookConfig, MessagingConfig, ThinkingLevel } from "./types.js";
import { DEFAULT_MESSAGING_CONFIG } from "./types.js";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export class AgentRegistry {
  private _promptRegistry: PromptRegistry | null = null;

  private getPromptRegistry(): PromptRegistry {
    if (!this._promptRegistry) {
      this._promptRegistry = createPromptRegistry({ templatesDir: getTemplatesDir() });
    }
    return this._promptRegistry;
  }

  /**
   * Discover all agent definitions from built-in, global, and project-local directories.
   * Priority: built-in < global < project-local.
   */
  discover(cwd: string): AgentDefinition[] {
    const agents = new Map<string, AgentDefinition>();

    // 1. Built-in: from prompt registry (templates/agents/)
    for (const def of this.loadBuiltinAgents()) {
      agents.set(def.name, def);
    }

    // 2. Global: ~/.pi/agent/agents/*.md
    const globalDir = path.join(getAgentDir(), "agents");
    for (const def of this.loadFromDir(globalDir, "user")) {
      agents.set(def.name, def);
    }

    // 3. Project-local: .pi/agents/*.md (search upward from cwd)
    const projectDir = this.findProjectAgentsDir(cwd);
    if (projectDir) {
      for (const def of this.loadFromDir(projectDir, "project")) {
        agents.set(def.name, def); // Override global and built-in
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
   * Load built-in agent definitions from the prompt registry.
   * These are the default agents shipped with the prompt package.
   * Their systemPrompt is rendered through the template engine,
   * supporting variables, extends, and includes.
   *
   * Agent-specific config (tools, model, thinking, color) is read from
   * the `agentConfig` frontmatter field. Tools are also passed as render
   * variables so the template body can reference them dynamically.
   */
  private loadBuiltinAgents(): AgentDefinition[] {
    const results: AgentDefinition[] = [];
    try {
      const registry = this.getPromptRegistry();
      const agentPrompts = registry.listByCategory("agents");

      for (const promptName of agentPrompts) {
        try {
          const meta = registry.getMeta(promptName);

          // Read agent config from extra frontmatter
          const agentConfig = (meta.extra?.agentConfig ?? {}) as Record<string, unknown>;

          // Parse tools
          const toolsStr = typeof agentConfig.tools === "string" ? agentConfig.tools : undefined;
          const tools = toolsStr?.split(",").map((t: string) => t.trim()).filter(Boolean);

          // Parse thinking
          const thinkingStr = typeof agentConfig.thinking === "string" ? agentConfig.thinking : undefined;
          const thinking = thinkingStr && VALID_THINKING_LEVELS.has(thinkingStr)
            ? thinkingStr as ThinkingLevel
            : undefined;

          // Build render variables from tools for dynamic body content
          const renderVars: Record<string, unknown> = {};
          if (tools) {
            renderVars.TOOLS_LIST = tools.join(", ");
            // Set HAS_* flags for each tool
            for (const tool of tools) {
              renderVars[`HAS_${tool.toUpperCase().replace(/-/g, "_")}`] = true;
            }
            // Common group flags
            renderVars.HAS_LSP = tools.some(t => t.startsWith("lsp_"));
          }

          const renderedBody = registry.render(promptName, renderVars);

          // Extract agent name: "agents/explorer" -> "explorer"
          const agentName = promptName.replace("agents/", "");

          results.push({
            name: agentName,
            description: meta.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: typeof agentConfig.model === "string" ? agentConfig.model : undefined,
            thinking,
            color: typeof agentConfig.color === "string" ? agentConfig.color : undefined,
            hooks: {},
            systemPrompt: renderedBody.trim(),
            source: "project",
            filePath: meta.filePath,
          });
        } catch (err) {
          console.error(`[subagent] Failed to load built-in agent "${promptName}":`, err);
        }
      }
    } catch {
      // Prompt registry not available — skip built-in agents
    }
    return results;
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
