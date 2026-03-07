/**
 * Shared tool serialization helpers for all provider adapters.
 *
 * Each function converts the canonical Tool[] into the API-specific payload
 * shape required by a provider. Centralizing these conversions here keeps
 * provider files focused on streaming logic and makes tool schema changes
 * easy to apply uniformly.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";
import type OpenAI from "openai";
import type { Tool as OpenAIResponsesTool } from "openai/resources/responses/responses.js";
import type { OpenAICompletionsCompat, Tool } from "../types.js";

// =============================================================================
// Anthropic Messages API
// =============================================================================

/**
 * Serialize tools for the Anthropic Messages API.
 *
 * @param tools - Canonical tool definitions.
 * @param nameTransformer - Optional function to remap tool names.
 *   Used for OAuth/Claude Code stealth mode (toClaudeCodeName).
 */
export function serializeAnthropicTools(
	tools: Tool[],
	nameTransformer?: (name: string) => string,
): Anthropic.Messages.Tool[] {
	return tools.map((tool) => {
		const schema = tool.parameters as Record<string, unknown>;
		return {
			name: nameTransformer ? nameTransformer(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: (schema.properties as Record<string, unknown>) ?? {},
				required: (schema.required as string[]) ?? [],
			},
		};
	});
}

// =============================================================================
// OpenAI Responses API
// =============================================================================

export interface OpenAIResponsesToolOptions {
	strict?: boolean | null;
}

/**
 * Serialize tools for the OpenAI Responses API.
 */
export function serializeOpenAIResponsesTools(
	tools: Tool[],
	options?: OpenAIResponsesToolOptions,
): OpenAIResponsesTool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		strict,
	}));
}

// =============================================================================
// OpenAI Chat Completions API
// =============================================================================

export interface OpenAICompletionsToolOptions {
	/** Whether to include the `strict` field. Pass `false` to omit it entirely. */
	supportsStrictMode?: boolean;
}

/**
 * Serialize tools for the OpenAI Chat Completions API.
 *
 * Pass `compat.supportsStrictMode` as `options.supportsStrictMode` to control
 * whether the `strict` field is included (some providers reject unknown fields).
 */
export function serializeOpenAICompletionsTools(
	tools: Tool[],
	options?: OpenAICompletionsToolOptions,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
			...(options?.supportsStrictMode !== false && { strict: false }),
		},
	}));
}

/**
 * Convenience overload that accepts a full `Required<OpenAICompletionsCompat>` object
 * and extracts the relevant field, matching the existing `convertTools(tools, compat)` signature.
 */
export function serializeOpenAICompletionsToolsFromCompat(
	tools: Tool[],
	compat: Required<OpenAICompletionsCompat>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return serializeOpenAICompletionsTools(tools, { supportsStrictMode: compat.supportsStrictMode });
}

// =============================================================================
// Google Generative AI / Vertex AI
// =============================================================================

/**
 * Serialize tools for Google's Generative AI APIs.
 *
 * By default uses `parametersJsonSchema` (full JSON Schema, including anyOf/oneOf/const).
 * Set `useParameters` to `true` to use the legacy `parameters` field (OpenAPI 3.03 Schema)
 * — required for Cloud Code Assist with Claude models, where the API translates
 * `parameters` into Anthropic's `input_schema`.
 *
 * Returns `undefined` when the tools array is empty (caller should omit the `tools` field).
 */
export function serializeGoogleTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: tool.parameters as Record<string, unknown> }
					: { parametersJsonSchema: tool.parameters as Record<string, unknown> }),
			})),
		},
	];
}

// =============================================================================
// Amazon Bedrock Converse API
// =============================================================================

/**
 * Serialize the tool array for the Bedrock Converse API.
 *
 * This covers only the `tools` array portion of `ToolConfiguration`.
 * Wrapping in `ToolConfiguration` (including toolChoice) is still handled
 * by `convertToolConfig` in `amazon-bedrock.ts`.
 */
export function serializeBedrockTools(tools: Tool[]): BedrockTool[] {
	return tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			// tool.parameters is TSchema which has [prop: string]: any from SchemaOptions,
			// making it directly assignable to DocumentType without an explicit cast.
			inputSchema: { json: tool.parameters },
		},
	}));
}
