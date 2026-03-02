/**
 * DPS Prompt Composer
 *
 * Assembles active L0-L3 segments into a single prompt string.
 * Sorts by layer then priority.
 * Fingerprint caching: if active segments haven't changed, returns cached result.
 * Lazy join: array of parts joined once at the end.
 */

import type { ResolvedSegment, ComposeResult } from "./types.js";

// ============================================================================
// Prompt Composer
// ============================================================================

export class PromptComposer {
	private lastFingerprint: string = "";
	private lastResult: string = "";
	private lastActiveIds: string[] = [];

	/**
	 * Compose active L0-L3 segments into a single prompt string.
	 * Segments must already be filtered (only active ones) and resolved (variables replaced).
	 *
	 * @param maxChars If > 0, trim lower-priority segments from the end to fit budget.
	 */
	compose(segments: ResolvedSegment[], maxChars: number = 0): ComposeResult {
		// Filter to L0-L3 only (L4 = reminders, handled separately)
		let promptSegments = segments.filter((s) => s.layer <= 3);

		// Sort: layer ascending, then priority ascending (lower = first)
		promptSegments.sort((a, b) => {
			if (a.layer !== b.layer) return a.layer - b.layer;
			return a.priority - b.priority;
		});

		// Token budget enforcement: remove lowest-priority segments from end
		if (maxChars > 0) {
			promptSegments = applyTokenBudget(promptSegments, maxChars);
		}

		// Build fingerprint for change detection
		const fingerprint = buildFingerprint(promptSegments);

		// Cache hit: same segments, same content → return previous result
		if (fingerprint === this.lastFingerprint) {
			return {
				text: this.lastResult,
				fingerprint,
				activeSegmentIds: this.lastActiveIds,
			};
		}

		// Compose: lazy join
		const parts: string[] = [];
		for (const seg of promptSegments) {
			if (seg.resolvedContent.trim()) {
				parts.push(seg.resolvedContent);
			}
		}

		const text = parts.join("\n\n");
		const activeSegmentIds = promptSegments.map((s) => s.id);

		// Update cache
		this.lastFingerprint = fingerprint;
		this.lastResult = text;
		this.lastActiveIds = activeSegmentIds;

		return { text, fingerprint, activeSegmentIds };
	}

	/**
	 * Reset cache (on session start or reload).
	 */
	reset(): void {
		this.lastFingerprint = "";
		this.lastResult = "";
		this.lastActiveIds = [];
	}
}

// ============================================================================
// Fingerprint
// ============================================================================

/**
 * Simple djb2 hash for content-based fingerprinting.
 * Fast and sufficient for change detection (not cryptographic).
 */
function djb2Hash(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash) + str.charCodeAt(i);
	}
	return hash >>> 0;
}

/**
 * Build a fingerprint from segments for change detection.
 * Uses id + content hash to detect any content change,
 * including same-length variable resolutions (e.g. branch "main" → "feat").
 */
function buildFingerprint(segments: ResolvedSegment[]): string {
	return segments
		.map((s) => `${s.id}:${djb2Hash(s.resolvedContent)}`)
		.join("|");
}

// ============================================================================
// Token Budget
// ============================================================================

/**
 * Trim segments to fit within maxChars budget.
 * Removes from the end (highest layer + highest priority = least important).
 * L0 (core) segments are never removed.
 */
function applyTokenBudget(
	segments: ResolvedSegment[],
	maxChars: number,
): ResolvedSegment[] {
	let totalChars = 0;
	for (const seg of segments) {
		totalChars += seg.resolvedContent.length;
	}

	if (totalChars <= maxChars) return segments;

	// Remove from the end (lowest priority = first in list, highest = last)
	// We reverse-iterate and remove non-L0 segments until under budget
	const result = [...segments];
	for (let i = result.length - 1; i >= 0 && totalChars > maxChars; i--) {
		if (result[i].layer === 0) continue; // Never remove core segments
		totalChars -= result[i].resolvedContent.length;
		result.splice(i, 1);
	}

	return result;
}
