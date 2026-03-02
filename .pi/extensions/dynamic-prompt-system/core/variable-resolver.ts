/**
 * DPS Variable Resolver
 *
 * Resolves ${VAR} placeholders in segment content.
 * Built-in variables: CWD, DATE_TIME, MODEL_NAME, ACTIVE_TOOLS,
 *                     GIT_BRANCH, TOKEN_USAGE, TURN_COUNT
 * Custom variables from config.
 * Git branch uses turn-scoped cache with 500ms timeout.
 */

import { execSync } from "child_process";
import type { Segment, ResolvedSegment, VariableContext, RuntimeState, CustomVariables } from "./types.js";

// ============================================================================
// Git Branch Cache (Turn-Scoped)
// ============================================================================

export class GitBranchCache {
	private branch: string | null = null;
	private resolved = false;

	get(cwd: string): string | null {
		if (this.resolved) return this.branch;
		try {
			this.branch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd,
				timeout: 500,
				stdio: ["pipe", "pipe", "pipe"],
			})
				.toString()
				.trim();
		} catch {
			this.branch = null;
		}
		this.resolved = true;
		return this.branch;
	}

	invalidate(): void {
		this.branch = null;
		this.resolved = false;
	}
}

// Global instance — invalidated at each prompt
export const gitBranchCache = new GitBranchCache();

// ============================================================================
// Variable Resolution
// ============================================================================

/** Variable pattern: ${VARIABLE_NAME} */
const VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Resolve variables in a single segment's content.
 */
export function resolveSegment(segment: Segment, context: VariableContext): ResolvedSegment {
	const resolvedContent = resolveVariables(segment.content, context);
	return {
		id: segment.id,
		layer: segment.layer,
		priority: segment.priority,
		resolvedContent,
		source: segment.source,
	};
}

/**
 * Resolve variables in multiple segments.
 */
export function resolveSegments(
	segments: Segment[],
	context: VariableContext,
): ResolvedSegment[] {
	return segments.map((s) => resolveSegment(s, context));
}

/**
 * Resolve all ${VAR} placeholders in text.
 */
export function resolveVariables(text: string, context: VariableContext): string {
	// Fast path: no variables in text
	if (!text.includes("${")) return text;

	return text.replace(VAR_PATTERN, (match, varName: string) => {
		const value = getVariableValue(varName, context);
		return value !== undefined ? value : match; // Keep original if unknown
	});
}

/**
 * Get value for a named variable.
 */
function getVariableValue(name: string, context: VariableContext): string | undefined {
	const { state, customVariables, gitBranch } = context;

	switch (name) {
		case "CWD":
			return state.cwd;

		case "DATE_TIME":
			return new Date().toLocaleString();

		case "MODEL_NAME":
			return state.modelName || "unknown";

		case "ACTIVE_TOOLS":
			return Array.from(state.activeTools).join(", ");

		case "GIT_BRANCH":
			return gitBranch ?? "N/A";

		case "TOKEN_USAGE":
			return state.tokenUsagePercent !== null
				? `${Math.round(state.tokenUsagePercent)}%`
				: "unknown";

		case "TURN_COUNT":
			return String(state.turnCount);

		default:
			// Check custom variables
			return customVariables[name];
	}
}

/**
 * Build a VariableContext from runtime state and config.
 */
export function buildVariableContext(
	state: RuntimeState,
	customVariables: CustomVariables,
): VariableContext {
	const gitBranch = gitBranchCache.get(state.cwd);
	return { state, customVariables, gitBranch };
}
