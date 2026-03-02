/**
 * Auto Notes — Generate automatic notes from turn activity + agent messages
 *
 * v2: Instead of just slicing the last assistant message, combines:
 *   1. Turn tracker data (files edited, commands run)
 *   2. A brief extract from the assistant's explanation
 *
 * This gives each auto-note real, actionable content like:
 *   "[Auto] Edited: store.ts, types.ts | Ran: `npm test` | Tests: 1 | Added retry logic to store operations"
 *
 * Instead of the old approach:
 *   "[Auto] I've updated the store module to add retry logic for database operations when..."
 */

import type { Task, TaskNote } from "../types.js";
import type { TurnTracker } from "./turn-tracker.js";

/**
 * Extract text content from an assistant message (handles string or content blocks).
 */
export function extractTextFromMessage(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text ?? "")
			.join("\n");
	}
	return "";
}

/**
 * Extract a brief first-sentence summary from the last assistant message.
 * Tries to get the "what" not the "how" — skips code blocks and preamble.
 */
function extractBriefSummary(messages: any[], maxLen: number = 120): string | null {
	if (!messages || !Array.isArray(messages)) return null;

	const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
	if (!lastAssistant) return null;

	const text = extractTextFromMessage(lastAssistant);
	if (!text || text.length < 10) return null;

	// Strip code blocks — we want the explanation, not the code
	const withoutCode = text.replace(/```[\s\S]*?```/g, "").trim();
	if (withoutCode.length < 10) return null;

	// Take first meaningful sentence
	const lines = withoutCode.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

	// Skip lines that are just headings, bullets starting with -, or very short
	const meaningful = lines.find((l) =>
		l.length > 15 &&
		!l.startsWith("#") &&
		!l.startsWith("```") &&
		!l.startsWith("---"),
	);

	if (!meaningful) return null;

	// Truncate to maxLen at word boundary
	if (meaningful.length <= maxLen) return meaningful;
	const cut = meaningful.slice(0, maxLen);
	const lastSpace = cut.lastIndexOf(" ");
	return lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) + "..." : cut + "...";
}

/**
 * Build a rich auto-note combining turn activity + assistant summary.
 *
 * Format: "[Auto] <activity> | <brief summary>"
 * Example: "[Auto] Edited: store.ts, types.ts | Ran: `npm test` | Added retry logic to store operations"
 */
export function buildAutoNote(
	messages: any[],
	turnTracker?: TurnTracker,
): TaskNote | null {
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
 * Append an auto-note to the given task. Returns true if note was added.
 */
export function appendAutoNote(
	task: Task,
	messages: any[],
	turnTracker?: TurnTracker,
): boolean {
	const note = buildAutoNote(messages, turnTracker);
	if (!note) return false;

	task.notes.push(note);
	return true;
}
