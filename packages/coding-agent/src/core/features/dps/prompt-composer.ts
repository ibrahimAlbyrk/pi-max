/**
 * Dynamic Prompt System (DPS) — Prompt Composer
 *
 * Handles the final assembly step: layer/priority sorting, token budget
 * enforcement, DJB2 fingerprint caching, and joining resolved entries
 * into the final system prompt text.
 */

import type { ComposeResult, ResolvedEntry } from "./types.js";

// ─── DJB2 Hash ───────────────────────────────────────────────────

/**
 * DJB2 hash function for change detection fingerprints.
 * Returns a stable hex string for the given input.
 */
function djb2(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		// hash = hash * 33 + charCode  (using bit shift for performance)
		hash = (hash << 5) + hash + input.charCodeAt(i);
		// Keep as 32-bit integer
		hash |= 0;
	}
	// Convert to unsigned 32-bit hex string
	return (hash >>> 0).toString(16);
}

/**
 * Build a fingerprint over a set of resolved entries.
 * Combines each entry's id and content so any change (add, remove,
 * reorder, or edit) produces a different fingerprint.
 */
function buildFingerprint(entries: ResolvedEntry[]): string {
	// Concatenate id + content for every entry in current order
	let combined = "";
	for (const entry of entries) {
		combined += `${entry.id}\x00${entry.content}\x01`;
	}
	return djb2(combined);
}

// ─── Prompt Composer ─────────────────────────────────────────────

/**
 * PromptComposer assembles resolved DPS entries into the final system
 * prompt text. It handles:
 *
 * 1. Filtering to L0-L3 (L4 reminders are injected as conversation messages)
 * 2. Sorting by layer ascending, then priority ascending
 * 3. Token budget enforcement (trim low-importance entries from the end,
 *    L0 entries are never removed)
 * 4. DJB2 fingerprint caching (skip recomposition when nothing changed)
 * 5. Joining entries with \n\n
 */
export class PromptComposer {
	private lastFingerprint: string = "";
	private lastResult: ComposeResult | null = null;
	private lastResolvedEntries: ResolvedEntry[] = [];

	/**
	 * Compose resolved entries into a final system prompt.
	 *
	 * @param entries - All resolved entries (may include L4).
	 * @param maxChars - Maximum character budget. 0 = unlimited.
	 * @returns ComposeResult with the composed text, fingerprint, and active IDs.
	 */
	compose(entries: ResolvedEntry[], maxChars: number): ComposeResult {
		// 1. Filter to L0-L3 only
		const filtered = entries.filter((e) => e.layer <= 3);

		// 2. Sort by layer ascending, then priority ascending
		const sorted = filtered.slice().sort((a, b) => {
			if (a.layer !== b.layer) return a.layer - b.layer;
			return a.priority - b.priority;
		});

		// 3. Apply token budget (trim from end, never remove L0)
		const budgeted = maxChars > 0 ? applyTokenBudget(sorted, maxChars) : sorted;

		// 4. Build fingerprint over the final set
		const fingerprint = buildFingerprint(budgeted);

		// 5. Cache hit — return previous result unchanged
		if (fingerprint === this.lastFingerprint && this.lastResult !== null) {
			return this.lastResult;
		}

		// 6. Store resolved entries (for debug inspection via getLastResolvedEntries)
		this.lastResolvedEntries = budgeted;

		// 7. Join entries with \n\n
		const text = budgeted.map((e) => e.content).join("\n\n");

		// 8. Collect active IDs
		const activeIds = budgeted.map((e) => e.id);

		const result: ComposeResult = { text, fingerprint, activeIds };

		// Update cache
		this.lastFingerprint = fingerprint;
		this.lastResult = result;

		return result;
	}

	/**
	 * Return the resolved entries from the last non-cached composition.
	 * Used by debug commands to inspect what was included and with what content.
	 */
	getLastResolvedEntries(): ResolvedEntry[] {
		return this.lastResolvedEntries.slice();
	}

	/**
	 * Return the last compose result, or null if compose() has never been called.
	 */
	getLastResult(): ComposeResult | null {
		return this.lastResult;
	}

	/**
	 * Clear the cached result. Call this when the template registry is
	 * reloaded or session state is reset, so the next compose() call
	 * unconditionally recomposes even if content is unchanged.
	 */
	reset(): void {
		this.lastFingerprint = "";
		this.lastResult = null;
		this.lastResolvedEntries = [];
	}
}

// ─── Token Budget Enforcement ────────────────────────────────────

/**
 * Trim entries from the sorted list until the total character count
 * fits within maxChars. Entries are removed from the end of the list
 * (highest layer + highest priority number = lowest importance).
 * L0 entries (layer === 0) are never removed.
 *
 * If L0 entries alone already exceed the budget, they are kept regardless.
 */
function applyTokenBudget(sorted: ResolvedEntry[], maxChars: number): ResolvedEntry[] {
	// Calculate total chars including separators (\n\n between entries)
	const totalChars = (entries: ResolvedEntry[]): number => {
		if (entries.length === 0) return 0;
		return entries.reduce((sum, e) => sum + e.content.length, 0) + (entries.length - 1) * 2; // "\n\n" = 2 chars per separator
	};

	if (totalChars(sorted) <= maxChars) {
		return sorted;
	}

	// Work on a mutable copy; remove from the end
	const result = sorted.slice();

	for (let i = result.length - 1; i >= 0; i--) {
		if (totalChars(result) <= maxChars) break;

		// Never remove L0 entries
		if (result[i].layer === 0) continue;

		result.splice(i, 1);
	}

	return result;
}
