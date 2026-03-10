/**
 * Dynamic Prompt System (DPS) — Condition Engine
 *
 * Parses raw YAML condition objects into typed Condition[], compiles them
 * into evaluator functions (compile-once, evaluate-many), and filters
 * DpsEntry arrays by running those evaluators against a RuntimeState snapshot.
 *
 * FileCheckCache: module-level Map<string, boolean> for fs.existsSync results,
 * keyed by absolute path. Cleared once per prompt composition via
 * clearFileCheckCache() (called from StateManager.invalidatePerPromptCaches()).
 */

import * as fs from "fs";
import * as path from "path";
import type { Condition, ConditionEvaluator, DpsEntry, RuntimeState } from "./types.js";

// ─── File Check Cache ─────────────────────────────────────────────────────────

/**
 * Turn-scoped cache for fs.existsSync results.
 * Keyed by absolute path. Prevents redundant syscalls within a single
 * prompt composition cycle when multiple conditions check the same path.
 */
const fileCheckCache: Map<string, boolean> = new Map();

/**
 * Clear the file existence cache.
 * Must be called once per prompt composition cycle (before condition evaluation)
 * so stale results from a previous turn are not used.
 */
export function clearFileCheckCache(): void {
	fileCheckCache.clear();
}

/**
 * Check whether a path exists, using the module-level cache.
 * `relativePath` is resolved against `cwd`.
 */
function cachedExists(cwd: string, relativePath: string): boolean {
	const absPath = path.resolve(cwd, relativePath);
	const cached = fileCheckCache.get(absPath);
	if (cached !== undefined) return cached;
	const result = fs.existsSync(absPath);
	fileCheckCache.set(absPath, result);
	return result;
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a single raw YAML condition object into a typed Condition.
 * Returns null for unknown or malformed conditions (caller should skip).
 *
 * YAML condition format: a plain object with exactly one key whose name is
 * the condition type (e.g., `{ tool_active: "bash" }`, `{ all: [...] }`).
 */
function parseCondition(raw: unknown): Condition | null {
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		console.warn(`DPS condition-engine: Skipping malformed condition (expected object): ${JSON.stringify(raw)}`);
		return null;
	}

	const obj = raw as Record<string, unknown>;
	const keys = Object.keys(obj);

	if (keys.length === 0) {
		console.warn(`DPS condition-engine: Skipping empty condition object`);
		return null;
	}

	// Conditions are single-key objects: the key is the condition type.
	const key = keys[0];
	const value = obj[key];

	switch (key) {
		case "tool_active":
			if (typeof value !== "string") {
				console.warn(`DPS condition-engine: "tool_active" requires a string value, got: ${JSON.stringify(value)}`);
				return null;
			}
			return { type: "tool_active", tool: value };

		case "tool_inactive":
			if (typeof value !== "string") {
				console.warn(
					`DPS condition-engine: "tool_inactive" requires a string value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "tool_inactive", tool: value };

		case "file_exists":
			if (typeof value !== "string") {
				console.warn(`DPS condition-engine: "file_exists" requires a string value, got: ${JSON.stringify(value)}`);
				return null;
			}
			return { type: "file_exists", path: value };

		case "dir_exists":
			if (typeof value !== "string") {
				console.warn(`DPS condition-engine: "dir_exists" requires a string value, got: ${JSON.stringify(value)}`);
				return null;
			}
			return { type: "dir_exists", path: value };

		case "token_usage_above":
			if (typeof value !== "number") {
				console.warn(
					`DPS condition-engine: "token_usage_above" requires a number value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "token_usage_above", percent: value };

		case "token_usage_below":
			if (typeof value !== "number") {
				console.warn(
					`DPS condition-engine: "token_usage_below" requires a number value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "token_usage_below", percent: value };

		case "turn_count_above":
			if (typeof value !== "number") {
				console.warn(
					`DPS condition-engine: "turn_count_above" requires a number value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "turn_count_above", count: value };

		case "turn_count_below":
			if (typeof value !== "number") {
				console.warn(
					`DPS condition-engine: "turn_count_below" requires a number value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "turn_count_below", count: value };

		case "model_supports":
			if (typeof value !== "string") {
				console.warn(
					`DPS condition-engine: "model_supports" requires a string value, got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "model_supports", capability: value };

		case "has_skills":
			return { type: "has_skills" };

		case "turns_since_tool_use": {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				console.warn(
					`DPS condition-engine: "turns_since_tool_use" requires an object with "tool" and "min", got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			const v = value as Record<string, unknown>;
			if (typeof v.tool !== "string" || typeof v.min !== "number") {
				console.warn(
					`DPS condition-engine: "turns_since_tool_use" requires "tool" (string) and "min" (number), got: ${JSON.stringify(value)}`,
				);
				return null;
			}
			return { type: "turns_since_tool_use", tool: v.tool, min: v.min };
		}

		case "all": {
			if (!Array.isArray(value)) {
				console.warn(`DPS condition-engine: "all" requires an array of conditions, got: ${JSON.stringify(value)}`);
				return null;
			}
			const conditions = parseConditions(value);
			return { type: "all", conditions };
		}

		case "any": {
			if (!Array.isArray(value)) {
				console.warn(`DPS condition-engine: "any" requires an array of conditions, got: ${JSON.stringify(value)}`);
				return null;
			}
			const conditions = parseConditions(value);
			return { type: "any", conditions };
		}

		case "not": {
			// "not" value is a single condition object, e.g. `not: { tool_active: spawn_agent }`.
			// When given an array, treat it as an implicit "all" of those conditions.
			let inner: Condition | null;
			if (Array.isArray(value)) {
				const conditions = parseConditions(value);
				inner = { type: "all", conditions };
			} else {
				inner = parseCondition(value);
			}
			if (!inner) {
				console.warn(`DPS condition-engine: "not" condition could not parse its inner condition`);
				return null;
			}
			return { type: "not", condition: inner };
		}

		default:
			console.warn(`DPS condition-engine: Unknown condition type "${key}", skipping`);
			return null;
	}
}

/**
 * Parse raw YAML condition list into typed Condition[].
 * Skips unknown or malformed entries with a console.warn.
 *
 * Called by template-scanner.ts when building DpsEntry objects.
 */
export function parseConditions(raw: unknown[]): Condition[] {
	const conditions: Condition[] = [];
	for (const item of raw) {
		const condition = parseCondition(item);
		if (condition !== null) {
			conditions.push(condition);
		}
	}
	return conditions;
}

// ─── Compile ──────────────────────────────────────────────────────────────────

/**
 * Compile a single Condition into a reusable evaluator function.
 * Recursively compiles nested conditions (all, any, not).
 * Closures capture the condition's parameters at compile time.
 */
function compileCondition(condition: Condition): ConditionEvaluator {
	switch (condition.type) {
		case "tool_active": {
			const { tool } = condition;
			return (state) => state.activeTools.has(tool);
		}

		case "tool_inactive": {
			const { tool } = condition;
			return (state) => !state.activeTools.has(tool);
		}

		case "file_exists": {
			const { path: filePath } = condition;
			return (state) => cachedExists(state.cwd, filePath);
		}

		case "dir_exists": {
			const { path: dirPath } = condition;
			return (state) => cachedExists(state.cwd, dirPath);
		}

		case "turns_since_tool_use": {
			const { tool, min } = condition;
			return (state) => {
				const lastUsed = state.toolLastUsedAtTurn.get(tool);
				if (lastUsed === undefined) return false;
				return state.turnCount - lastUsed >= min;
			};
		}

		case "token_usage_above": {
			const { percent } = condition;
			return (state) => state.tokenUsagePercent !== null && state.tokenUsagePercent > percent;
		}

		case "token_usage_below": {
			const { percent } = condition;
			return (state) => state.tokenUsagePercent !== null && state.tokenUsagePercent < percent;
		}

		case "turn_count_above": {
			const { count } = condition;
			return (state) => state.turnCount > count;
		}

		case "turn_count_below": {
			const { count } = condition;
			return (state) => state.turnCount < count;
		}

		case "model_supports": {
			const { capability } = condition;
			return (state) => state.modelCapabilities.has(capability);
		}

		case "has_skills":
			return (state) => state.skillsCount > 0;

		case "all": {
			const evaluators = condition.conditions.map(compileCondition);
			return (state) => evaluators.every((fn) => fn(state));
		}

		case "any": {
			const evaluators = condition.conditions.map(compileCondition);
			return (state) => evaluators.some((fn) => fn(state));
		}

		case "not": {
			const inner = compileCondition(condition.condition);
			return (state) => !inner(state);
		}
	}
}

/**
 * Compile a Condition[] into a single ConditionEvaluator function.
 *
 * Compile-once, evaluate-many: call this once when building a DpsEntry,
 * then call the returned function on every prompt composition cycle.
 *
 * - Empty conditions → always returns true (entry is unconditionally active)
 * - Single condition → directly compiled
 * - Multiple conditions → implicit AND (all must pass)
 */
export function compileConditions(conditions: Condition[]): ConditionEvaluator {
	if (conditions.length === 0) {
		return () => true;
	}
	if (conditions.length === 1) {
		return compileCondition(conditions[0]);
	}
	const evaluators = conditions.map(compileCondition);
	return (state) => evaluators.every((fn) => fn(state));
}

// ─── Evaluate Entries ─────────────────────────────────────────────────────────

/**
 * Filter DPS entries whose compiled conditions pass against the given runtime state.
 * Entries with failing conditions are excluded from the result.
 *
 * Expects that each DpsEntry.evaluator was produced by compileConditions()
 * (i.e., the compile step has already been done by template-scanner.ts).
 */
export function evaluateEntries(entries: DpsEntry[], state: RuntimeState): DpsEntry[] {
	return entries.filter((entry) => entry.evaluator(state));
}
