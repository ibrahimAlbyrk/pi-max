/**
 * Auto Notes — Generate automatic notes from turn activity + agent messages
 *
 * Combines:
 *   1. Turn tracker data (files edited, commands run)
 *   2. A brief extract from the assistant's last explanation
 *
 * Example output:
 *   "[Auto] Edited: store.ts, types.ts | Ran: `npm test` | Added retry logic to store operations"
 */

import type { ActivityTracker, Task, TaskNote } from "../types.js";

// ─── Message Types ────────────────────────────────────────────────
// Minimal structural types for LLM conversation messages.
// We only care about role and content — no dependency on the AI package here.

interface MessageContentBlock {
	type: string;
	text?: string;
}

interface ConversationMessage {
	role: string;
	content: string | MessageContentBlock[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract text content from a conversation message.
 * Handles both plain string content and structured content blocks.
 */
export function extractTextFromMessage(msg: ConversationMessage): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: MessageContentBlock) => b.type === "text")
			.map((b: MessageContentBlock) => b.text ?? "")
			.join("\n");
	}
	return "";
}

/**
 * Extract a brief first-sentence summary from the last assistant message.
 * Skips code blocks and preamble — targets the "what", not the "how".
 */
function extractBriefSummary(messages: ConversationMessage[], maxLen: number = 120): string | null {
	if (!messages || !Array.isArray(messages)) return null;

	const lastAssistant = [...messages].reverse().find((m: ConversationMessage) => m.role === "assistant");
	if (!lastAssistant) return null;

	const text = extractTextFromMessage(lastAssistant);
	if (!text || text.length < 10) return null;

	// Strip code blocks — we want the explanation, not the code
	const withoutCode = text.replace(/```[\s\S]*?```/g, "").trim();
	if (withoutCode.length < 10) return null;

	// Take first meaningful sentence
	const lines = withoutCode
		.split("\n")
		.map((l: string) => l.trim())
		.filter((l: string) => l.length > 0);

	// Skip headings, horizontal rules, and very short lines
	const meaningful = lines.find(
		(l: string) => l.length > 15 && !l.startsWith("#") && !l.startsWith("```") && !l.startsWith("---"),
	);

	if (!meaningful) return null;

	if (meaningful.length <= maxLen) return meaningful;
	const cut = meaningful.slice(0, maxLen);
	const lastSpace = cut.lastIndexOf(" ");
	return lastSpace > maxLen * 0.6 ? `${cut.slice(0, lastSpace)}...` : `${cut}...`;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Build a rich auto-note combining turn activity + assistant summary.
 *
 * Format: "[Auto] <activity> | <brief summary>"
 * Example: "[Auto] Edited: store.ts, types.ts | Ran: `npm test` | Added retry logic"
 *
 * Returns null if there is nothing meaningful to record.
 */
export function buildAutoNote(messages: ConversationMessage[], turnTracker?: ActivityTracker): TaskNote | null {
	const activitySummary = turnTracker?.buildActivitySummary();
	const textSummary = extractBriefSummary(messages);

	// Need at least one meaningful piece
	if (!activitySummary && !textSummary) return null;

	let noteText: string;
	if (activitySummary && textSummary) {
		noteText = `[Auto] ${activitySummary} | ${textSummary}`;
	} else if (activitySummary) {
		noteText = `[Auto] ${activitySummary}`;
	} else {
		noteText = `[Auto] ${textSummary}`;
	}

	return {
		timestamp: new Date().toISOString(),
		author: "agent",
		text: noteText,
	};
}

/**
 * Append an auto-note to the given task. Returns true if a note was added.
 */
export function appendAutoNote(task: Task, messages: ConversationMessage[], turnTracker?: ActivityTracker): boolean {
	const note = buildAutoNote(messages, turnTracker);
	if (!note) return false;

	task.notes.push(note);
	return true;
}
