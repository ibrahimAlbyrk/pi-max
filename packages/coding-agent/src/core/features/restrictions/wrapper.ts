/**
 * Tool wrapper for restriction enforcement.
 *
 * Wraps a tool's execute function to check restrictions before allowing execution.
 * Same pattern as wrapToolWithExtensions in extensions/wrapper.ts.
 */

import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { RestrictionChecker } from "./types.js";

/**
 * Wrap a tool with restriction checking.
 * Before each execution, the checker evaluates the tool call.
 * If blocked, an Error is thrown with the reason (preventing execution).
 */
export function wrapToolWithRestrictions<T>(tool: AgentTool<any, T>, checker: RestrictionChecker): AgentTool<any, T> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<T>,
		) => {
			const result = await checker.check(tool.name, params);
			if (result?.block) {
				throw new Error(result.reason || "Tool execution was blocked by restrictions");
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}
