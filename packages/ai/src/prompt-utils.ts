import type { SystemPromptBlock } from "./types.js";

/**
 * Normalize a system prompt to an array of blocks.
 * - undefined → []
 * - string → [{ text: string }]
 * - SystemPromptBlock[] → as-is
 */
export function normalizeSystemPrompt(prompt: string | SystemPromptBlock[] | undefined): SystemPromptBlock[] {
	if (!prompt) return [];
	if (typeof prompt === "string") return [{ text: prompt }];
	return prompt;
}

/**
 * Flatten a system prompt (string or blocks) to a single string.
 * Blocks are joined with double newlines. Returns undefined when empty.
 */
export function flattenSystemPrompt(prompt: string | SystemPromptBlock[] | undefined): string | undefined {
	if (!prompt) return undefined;
	if (typeof prompt === "string") return prompt;
	if (prompt.length === 0) return undefined;
	return prompt.map((b) => b.text).join("\n\n");
}
