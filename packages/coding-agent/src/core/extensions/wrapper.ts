/**
 * Tool wrappers for extensions.
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool, ToolCallEventResult } from "./types.js";

// ============================================================================
// Middleware
// ============================================================================

/**
 * The continuation function passed to each middleware in the chain.
 * Calling it advances execution to the next middleware, or to the underlying
 * tool execute when no more middleware remain.
 */
export type ToolMiddlewareNext = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
) => Promise<AgentToolResult<any>>;

/**
 * Middleware function for tool execution.
 *
 * Middleware runs inside the extension tool_call/tool_result interception layer,
 * so extension handlers still fire around the full middleware chain. Call `next`
 * to continue the chain; short-circuiting without calling `next` blocks execution.
 */
export type ToolMiddlewareFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	next: ToolMiddlewareNext,
) => Promise<AgentToolResult<any>>;

/**
 * Apply an ordered list of middleware functions to a tool, returning a new tool
 * whose execute function runs through the middleware chain before reaching the
 * original execute. Returns the tool unchanged if the middleware list is empty.
 *
 * Middleware is applied in registration order (index 0 is outermost).
 */
export function applyToolMiddleware(tool: AgentTool, middleware: ReadonlyArray<ToolMiddlewareFn>): AgentTool {
	if (middleware.length === 0) return tool;

	// Cast to AgentTool<any> so tool.execute accepts Record<string, unknown> params
	// without a Static<TSchema> constraint mismatch — the same pattern used by
	// wrapToolWithExtensions<T>(tool: AgentTool<any, T>, ...).
	const baseTool = tool as AgentTool<any>;

	const buildNext =
		(index: number): ToolMiddlewareNext =>
		(tcId, p, s, ou) => {
			if (index < middleware.length) {
				return middleware[index]!(tcId, p, s, ou, buildNext(index + 1));
			}
			return baseTool.execute(tcId, p, s, ou);
		};

	return {
		...baseTool,
		execute: (toolCallId, params, signal, onUpdate) =>
			buildNext(0)(toolCallId, params as Record<string, unknown>, signal, onUpdate),
	};
}

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const { definition } = registeredTool;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		sideEffects: definition.sideEffects,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, runner.createContext()),
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((rt) => wrapRegisteredTool(rt, runner));
}

/**
 * Wrap a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<T>,
		) => {
			// Emit tool_call event - extensions can block execution
			if (runner.hasHandlers("tool_call")) {
				try {
					const callResult = (await runner.emitToolCall({
						type: "tool_call",
						toolName: tool.name,
						toolCallId,
						input: params,
					})) as ToolCallEventResult | undefined;

					if (callResult?.block) {
						const reason = callResult.reason || "Tool execution was blocked by an extension";
						throw new Error(reason);
					}
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
			}

			// Execute the actual tool
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);

				// Emit tool_result event - extensions can modify the result
				if (runner.hasHandlers("tool_result")) {
					const resultResult = await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: result.content,
						details: result.details,
						isError: false,
					});

					if (resultResult) {
						return {
							content: resultResult.content ?? result.content,
							details: (resultResult.details ?? result.details) as T,
						};
					}
				}

				return result;
			} catch (err) {
				// Emit tool_result event for errors
				if (runner.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
						details: undefined,
						isError: true,
					});
				}
				throw err;
			}
		},
	};
}

/**
 * Wrap all tools with extension callbacks.
 */
export function wrapToolsWithExtensions<T>(tools: AgentTool<any, T>[], runner: ExtensionRunner): AgentTool<any, T>[] {
	return tools.map((tool) => wrapToolWithExtensions(tool, runner));
}
