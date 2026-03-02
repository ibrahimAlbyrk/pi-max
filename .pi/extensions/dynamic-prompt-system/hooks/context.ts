/**
 * DPS Hook: context
 *
 * Injects L4 (reminder) segments as custom messages into the conversation.
 * Runs before messages are sent to LLM.
 *
 * Reminder flow:
 * 1. Evaluate L4 segments against current state
 * 2. Apply cooldown (skip if recently triggered)
 * 3. Apply maxTriggers (skip if exceeded)
 * 4. Resolve variables in active reminders
 * 5. Convert to CustomMessage with display: false
 * 6. Append to message list
 * 7. Record trigger in state
 */

import type { ExtensionContext, ContextEvent, ContextEventResult } from "@mariozechner/pi-coding-agent";
import type { SegmentRegistry } from "../core/segment-registry.js";
import type { StateManager } from "../core/state-manager.js";
import type { Segment, DPSConfig } from "../core/types.js";
import { evaluateSegments } from "../core/condition-engine.js";
import { resolveDependencies } from "../core/dependency-resolver.js";
import { resolveVariables, buildVariableContext } from "../core/variable-resolver.js";

export function handleContext(
	registry: SegmentRegistry,
	stateManager: StateManager,
	config: DPSConfig,
) {
	return async (
		event: ContextEvent,
		ctx: ExtensionContext,
	): Promise<ContextEventResult | void> => {
		if (!config.enabled) return;

		const state = stateManager.snapshot();

		// Get all L4 segments
		const allSegments = registry.getAll();
		const l4Segments = allSegments.filter((s) => s.layer === 4);

		if (l4Segments.length === 0) return;

		// Evaluate conditions + dependency resolution
		const conditionActive = evaluateSegments(l4Segments, state);
		const activeL4 = resolveDependencies(conditionActive);

		if (activeL4.length === 0) return;

		// Apply cooldown and maxTriggers
		const eligibleReminders = activeL4.filter((segment) => {
			// Check cooldown
			if (segment.cooldown !== undefined) {
				if (!stateManager.isReminderCooledDown(segment.id, segment.cooldown)) {
					return false;
				}
			}

			// Check maxTriggers
			if (segment.maxTriggers !== undefined) {
				if (stateManager.isReminderMaxed(segment.id, segment.maxTriggers)) {
					return false;
				}
			}

			return true;
		});

		if (eligibleReminders.length === 0) return;

		// Resolve variables
		const varContext = buildVariableContext(state, config.variables);

		// Create reminder messages
		const reminderMessages = eligibleReminders.map((segment) => {
			const resolvedContent = resolveVariables(segment.content, varContext);

			// Record trigger
			stateManager.recordReminderTriggered(segment.id);

			return {
				role: "custom" as const,
				customType: "dps-reminder",
				content: resolvedContent,
				display: false,
				timestamp: Date.now(),
			};
		});

		// Append to existing messages
		return {
			messages: [...event.messages, ...reminderMessages] as any,
		};
	};
}
