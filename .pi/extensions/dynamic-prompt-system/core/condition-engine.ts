/**
 * DPS Condition Engine
 *
 * Evaluates conditions against runtime state.
 * Compiled conditions: parse-time → closure function.
 * Early exit: all() stops at first false, any() stops at first true.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import type { Condition, ConditionEvaluator, RuntimeState, Segment } from "./types.js";

// ============================================================================
// File System Cache (Turn-Scoped)
// ============================================================================

export class FileCheckCache {
	private cache = new Map<string, boolean>();

	exists(path: string): boolean {
		if (this.cache.has(path)) return this.cache.get(path)!;
		const result = existsSync(path);
		this.cache.set(path, result);
		return result;
	}

	invalidate(): void {
		this.cache.clear();
	}
}

// Global instance — invalidated at each prompt
export const fileCheckCache = new FileCheckCache();

// ============================================================================
// Condition Compiler
// ============================================================================

/**
 * Compile conditions array into a single evaluator function.
 * If conditions is empty → always active (returns true).
 * Multiple conditions → AND (all must pass).
 */
export function compileConditions(conditions: Condition[]): ConditionEvaluator {
	if (conditions.length === 0) {
		return () => true;
	}

	if (conditions.length === 1) {
		return compileSingle(conditions[0]);
	}

	// Multiple conditions → AND
	const evaluators = conditions.map(compileSingle);
	return (state: RuntimeState) => evaluators.every((fn) => fn(state));
}

/**
 * Compile a single condition into an evaluator function.
 */
function compileSingle(condition: Condition): ConditionEvaluator {
	switch (condition.type) {
		case "tool_active":
			return (state) => state.activeTools.has(condition.tool);

		case "tool_inactive":
			return (state) => !state.activeTools.has(condition.tool);

		case "file_exists":
			return (state) => {
				const fullPath = resolve(state.cwd, condition.path);
				return fileCheckCache.exists(fullPath);
			};

		case "dir_exists":
			return (state) => {
				const fullPath = resolve(state.cwd, condition.path);
				return fileCheckCache.exists(fullPath);
			};

		case "turns_since_tool_use": {
			const { tool, min } = condition;
			return (state) => {
				const lastUsed = state.toolLastUsedAtTurn.get(tool);
				if (lastUsed === undefined) {
					// Never used → always passes if we're past min turns
					return state.turnCount >= min;
				}
				return state.turnCount - lastUsed >= min;
			};
		}

		case "token_usage_above":
			return (state) =>
				state.tokenUsagePercent !== null &&
				state.tokenUsagePercent > condition.percent;

		case "token_usage_below":
			return (state) =>
				state.tokenUsagePercent !== null &&
				state.tokenUsagePercent < condition.percent;

		case "turn_count_above":
			return (state) => state.turnCount > condition.count;

		case "turn_count_below":
			return (state) => state.turnCount < condition.count;

		case "model_supports":
			return (state) => state.modelCapabilities.has(condition.capability);

		case "all": {
			const evaluators = condition.conditions.map(compileSingle);
			return (state) => evaluators.every((fn) => fn(state));
		}

		case "any": {
			const evaluators = condition.conditions.map(compileSingle);
			return (state) => evaluators.some((fn) => fn(state));
		}

		case "not": {
			const inner = compileSingle(condition.condition);
			return (state) => !inner(state);
		}

		default:
			// Unknown condition → treat as always false
			return () => false;
	}
}

// ============================================================================
// Segment Evaluation
// ============================================================================

/**
 * Evaluate all segments and return only the active ones.
 */
export function evaluateSegments(segments: Segment[], state: RuntimeState): Segment[] {
	return segments.filter((segment) => segment.evaluator(state));
}

/**
 * Evaluate segments for a specific layer range.
 */
export function evaluateSegmentsByLayer(
	segments: Segment[],
	state: RuntimeState,
	minLayer: number,
	maxLayer: number,
): Segment[] {
	return segments.filter(
		(segment) =>
			segment.layer >= minLayer &&
			segment.layer <= maxLayer &&
			segment.evaluator(state),
	);
}
