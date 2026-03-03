/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types.js";

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "turn_end", message, toolResults: [] });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
					config.maxParallelTools,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

/**
 * A group of tool calls that can be executed together.
 * Parallel groups run all calls concurrently; sequential groups run one at a time.
 */
type ToolCallGroup = {
	calls: Extract<AssistantMessage["content"][number], { type: "toolCall" }>[];
	parallel: boolean;
};

/**
 * Group tool calls into parallel (read-only) and sequential (side-effect) batches.
 * Consecutive read-only tools form a parallel group; each side-effect tool is its own sequential group.
 * Tools with sideEffects undefined default to true (safe fallback for unknown/extension tools).
 */
function groupToolCalls(
	toolCalls: Extract<AssistantMessage["content"][number], { type: "toolCall" }>[],
	tools: AgentTool<any>[] | undefined,
): ToolCallGroup[] {
	const groups: ToolCallGroup[] = [];
	let currentReadOnly: typeof toolCalls = [];

	for (const tc of toolCalls) {
		const tool = tools?.find((t) => t.name === tc.name);
		// Default to true (has side effects) for unknown tools — safe fallback
		const hasSideEffects = tool?.sideEffects !== false;

		if (hasSideEffects) {
			if (currentReadOnly.length > 0) {
				groups.push({ calls: currentReadOnly, parallel: true });
				currentReadOnly = [];
			}
			groups.push({ calls: [tc], parallel: false });
		} else {
			currentReadOnly.push(tc);
		}
	}

	if (currentReadOnly.length > 0) {
		groups.push({ calls: currentReadOnly, parallel: true });
	}

	return groups;
}

/**
 * Execute a single tool call, emitting start/update/end events.
 */
async function executeSingleToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	tools: AgentTool<any>[] | undefined,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolResultMessage> {
	const tool = tools?.find((t) => t.name === toolCall.name);

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});

	let result: AgentToolResult<any>;
	let isError = false;

	try {
		if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

		const validatedArgs = validateToolArguments(tool, toolCall);

		result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
			stream.push({
				type: "tool_execution_update",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
				partialResult,
			});
		});
	} catch (e) {
		result = {
			content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
			details: {},
		};
		isError = true;
	}

	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

/**
 * Execute tool calls with concurrency limit using a worker pool pattern.
 */
async function executeWithConcurrencyLimit<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;

	const workers = Array.from({ length: limit }, async () => {
		while (nextIndex < items.length) {
			const current = nextIndex++;
			if (current < items.length) {
				await fn(items[current]);
			}
		}
	});

	await Promise.all(workers);
}

/**
 * Execute tool calls from an assistant message.
 * Groups consecutive read-only tools for parallel execution; side-effect tools run sequentially.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
	maxParallelTools?: number,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const concurrency = Math.max(1, maxParallelTools ?? 5);
	const groups = groupToolCalls(toolCalls, tools);

	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	// Track how many tool calls we've processed for skipping on steering
	let processedCount = 0;

	for (const group of groups) {
		if (steeringMessages) break;

		if (group.parallel && group.calls.length > 1 && concurrency > 1) {
			// Parallel execution for read-only tools
			const groupResults: ToolResultMessage[] = new Array(group.calls.length);

			await executeWithConcurrencyLimit(
				group.calls.map((call, index) => ({ call, index })),
				concurrency,
				async ({ call, index }) => {
					groupResults[index] = await executeSingleToolCall(call, tools, signal, stream);
				},
			);

			results.push(...groupResults);
			processedCount += group.calls.length;
		} else {
			// Sequential execution for side-effect tools or single-item groups
			for (const toolCall of group.calls) {
				if (steeringMessages) break;

				const toolResult = await executeSingleToolCall(toolCall, tools, signal, stream);
				results.push(toolResult);
				processedCount++;

				// Check for steering messages after each sequential tool
				if (getSteeringMessages) {
					const steering = await getSteeringMessages();
					if (steering.length > 0) {
						steeringMessages = steering;
						break;
					}
				}
			}
		}

		// Check for steering messages after each group
		if (!steeringMessages && getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
			}
		}
	}

	// Skip remaining tool calls if steering interrupted
	if (steeringMessages) {
		const allToolCalls = groups.flatMap((g) => g.calls);
		const remainingCalls = allToolCalls.slice(processedCount);
		for (const skipped of remainingCalls) {
			results.push(skipToolCall(skipped, stream));
		}
	}

	return { toolResults: results, steeringMessages };
}

function skipToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
