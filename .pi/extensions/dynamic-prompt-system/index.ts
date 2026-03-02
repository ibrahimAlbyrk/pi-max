/**
 * DPS — Dynamic Prompt System Extension for Pi CLI
 *
 * Transforms Pi's static system prompt into a modular, runtime-aware system
 * where prompt segments are automatically added/removed based on context.
 *
 * Architecture:
 * - Segments: .md files with YAML frontmatter (conditions + content)
 * - Layers: L0 Core, L1 Environment, L2 Tool, L3 Custom → system prompt
 *           L4 Reminder → context messages
 * - Directories: extension/segments/ (builtin) → ~/.pi/agent/prompts/dps/ (global)
 *                → .pi/prompts/dps/ (project) — later overrides earlier
 *
 * Hooks:
 * - session_start → load segments, reset state
 * - before_agent_start → evaluate conditions, compose L0-L3, inject into systemPrompt
 * - context → evaluate L4 reminders, inject as custom messages
 * - tool_call → track tool usage
 * - turn_end → increment turn counter
 * - model_select → track model capabilities
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Core modules
import { SegmentRegistry } from "./core/segment-registry.js";
import { StateManager } from "./core/state-manager.js";
import { PromptComposer } from "./core/prompt-composer.js";
import { DEFAULT_CONFIG } from "./core/types.js";
import type { DPSConfig } from "./core/types.js";

// Hooks
import { handleSessionStart } from "./hooks/session-start.js";
import { handleBeforeAgentStart } from "./hooks/before-agent-start.js";
import { handleContext } from "./hooks/context.js";
import { handleToolCall } from "./hooks/tool-tracking.js";
import { handleTurnEnd } from "./hooks/turn-tracking.js";
import { handleModelSelect } from "./hooks/model-tracking.js";

// Debug
import { registerDpsLogCommand } from "./debug/dps-log.js";

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	// Resolve extension directory (for builtin segments)
	const extensionDir = dirname(fileURLToPath(import.meta.url));

	// Initialize core modules
	const registry = new SegmentRegistry();
	const stateManager = new StateManager();
	const composer = new PromptComposer();
	const config: DPSConfig = { ...DEFAULT_CONFIG };

	// ========================================================================
	// Register Hooks
	// ========================================================================

	// Session lifecycle
	pi.on("session_start", handleSessionStart(registry, stateManager, composer, extensionDir));
	pi.on("session_switch", handleSessionStart(registry, stateManager, composer, extensionDir));
	pi.on("session_fork", handleSessionStart(registry, stateManager, composer, extensionDir));

	// Prompt composition (L0-L3 → system prompt)
	pi.on("before_agent_start", handleBeforeAgentStart(pi, registry, stateManager, composer, config));

	// Reminder injection (L4 → context messages)
	pi.on("context", handleContext(registry, stateManager, config));

	// Tool usage tracking
	pi.on("tool_call", handleToolCall(stateManager));

	// Turn tracking
	pi.on("turn_end", handleTurnEnd(stateManager));

	// Model tracking
	pi.on("model_select", handleModelSelect(stateManager));

	// ========================================================================
	// Debug Commands
	// ========================================================================

	registerDpsLogCommand(pi, registry, stateManager, composer, config, extensionDir);
}
