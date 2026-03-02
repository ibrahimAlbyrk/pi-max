/**
 * DPS Hook: tool_call + tool_result
 *
 * Tracks tool usage in state:
 * - tool_call → recordToolCall(toolName)
 */

import type { ToolCallEvent } from "@mariozechner/pi-coding-agent";
import type { StateManager } from "../core/state-manager.js";

export function handleToolCall(stateManager: StateManager) {
	return async (event: ToolCallEvent) => {
		stateManager.recordToolCall(event.toolName);
	};
}
