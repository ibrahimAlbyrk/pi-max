/**
 * DPS Hook: before_agent_start
 *
 * Runs before each LLM call:
 * 1. Preserves Pi's base prompt (event.systemPrompt)
 * 2. Invalidates per-prompt caches
 * 3. Updates runtime state (active tools, token usage)
 * 4. Evaluates conditions on all segments
 * 5. Resolves variables on active L0-L3 segments
 * 6. Composes final prompt = basePrompt + "\n\n" + dpsContent
 */

import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@mariozechner/pi-coding-agent";
import type { SegmentRegistry } from "../core/segment-registry.js";
import type { StateManager } from "../core/state-manager.js";
import type { PromptComposer } from "../core/prompt-composer.js";
import type { DPSConfig } from "../core/types.js";
import { evaluateSegments } from "../core/condition-engine.js";
import { resolveDependencies } from "../core/dependency-resolver.js";
import { resolveSegments, buildVariableContext } from "../core/variable-resolver.js";

export function handleBeforeAgentStart(
	pi: ExtensionAPI,
	registry: SegmentRegistry,
	stateManager: StateManager,
	composer: PromptComposer,
	config: DPSConfig,
) {
	return async (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<BeforeAgentStartEventResult | void> => {
		if (!config.enabled) return;

		const basePrompt = event.systemPrompt;

		// Invalidate turn-scoped caches
		stateManager.invalidatePerPromptCaches();

		// Update runtime state
		stateManager.setCwd(ctx.cwd);
		stateManager.setActiveTools(pi.getActiveTools());
		stateManager.setAllTools(pi.getAllTools().map((t) => t.name));

		// Update token usage
		const usage = ctx.getContextUsage();
		stateManager.setTokenUsage(usage?.percent ?? null);

		// Update model info
		if (ctx.model) {
			const capabilities: string[] = [];
			if (ctx.model.reasoning) capabilities.push("reasoning");
			if (ctx.model.input?.includes("image")) capabilities.push("image");
			stateManager.setModel(ctx.model.id || ctx.model.name || "", capabilities);
		}

		// Get state snapshot
		const state = stateManager.snapshot();

		// Evaluate conditions → active segments
		const allSegments = registry.getAll();
		const conditionActive = evaluateSegments(allSegments, state);

		// Resolve depends_on / conflicts_with
		const activeSegments = resolveDependencies(conditionActive);

		// Filter L0-L3 only (L4 handled by context hook)
		const promptSegments = activeSegments.filter((s) => s.layer <= 3);

		if (promptSegments.length === 0) return;

		// Resolve variables
		const varContext = buildVariableContext(state, config.variables);
		const resolved = resolveSegments(promptSegments, varContext);

		// Compose (with optional token budget)
		const result = composer.compose(resolved, config.maxSegmentChars);

		if (!result.text.trim()) return;

		return {
			systemPrompt: basePrompt + "\n\n" + result.text,
		};
	};
}
