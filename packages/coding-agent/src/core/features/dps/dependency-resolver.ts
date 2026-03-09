/**
 * Dynamic Prompt System (DPS) — Dependency Resolver
 *
 * Resolves `depends_on` and `conflicts_with` constraints among DPS entries
 * after condition evaluation. Uses an iterative approach because removing an
 * entry may invalidate another entry's dependencies, which in turn may need
 * to be removed, etc.
 */

import type { DpsEntry } from "./types.js";

const MAX_ITERATIONS = 10;

/**
 * Resolve depends_on and conflicts_with constraints.
 *
 * - depends_on: entry is active only if ALL listed template names are active
 * - conflicts_with: entry is deactivated if ANY listed template name is active
 *
 * Iterates up to MAX_ITERATIONS times until the active set is stable
 * (no entries were removed in the last pass). This handles chains: removing
 * entry A may cause entry B (which depends on A) to also be removed.
 *
 * Fast path: if no entries declare any deps or conflicts, the input is
 * returned immediately without any iteration.
 */
export function resolveDependencies(entries: DpsEntry[]): DpsEntry[] {
	// Fast path: skip iteration entirely if no entry has any constraints.
	const hasDepsOrConflicts = entries.some((e) => e.dependsOn.length > 0 || e.conflictsWith.length > 0);
	if (!hasDepsOrConflicts) {
		return entries;
	}

	// Work with a mutable Set of active template names for O(1) lookups.
	const activeNames = new Set(entries.map((e) => e.templateName));

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		const removed: string[] = [];

		for (const entry of entries) {
			// Skip entries that are already inactive.
			if (!activeNames.has(entry.templateName)) continue;

			// depends_on: ALL listed names must be in the active set.
			const depsFailed = entry.dependsOn.some((dep) => !activeNames.has(dep));
			if (depsFailed) {
				removed.push(entry.templateName);
				continue;
			}

			// conflicts_with: NONE of the listed names may be in the active set.
			const hasConflict = entry.conflictsWith.some((conflict) => activeNames.has(conflict));
			if (hasConflict) {
				removed.push(entry.templateName);
			}
		}

		// If nothing changed this pass, the set is stable — stop early.
		if (removed.length === 0) break;

		for (const name of removed) {
			activeNames.delete(name);
		}
	}

	// Return original entries in original order, filtered to active names only.
	return entries.filter((e) => activeNames.has(e.templateName));
}
