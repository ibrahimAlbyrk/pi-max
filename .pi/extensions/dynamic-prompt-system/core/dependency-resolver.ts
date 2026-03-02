/**
 * DPS Dependency Resolver
 *
 * Resolves depends_on and conflicts_with relationships between segments.
 * Called AFTER condition evaluation — works on already-active segments.
 *
 * Rules:
 * - depends_on: segment stays active only if ALL listed dependencies are also active
 * - conflicts_with: segment is deactivated if ANY listed conflict is active
 * - Resolution runs iteratively until stable (dependency chains)
 */

import type { Segment } from "./types.js";

/**
 * Resolve dependencies and conflicts for a set of condition-active segments.
 * Returns the filtered list with unmet dependencies and conflicts removed.
 *
 * Uses iterative resolution: removing a segment may invalidate
 * another segment's depends_on, so we loop until stable.
 */
export function resolveDependencies(segments: Segment[]): Segment[] {
	// Fast path: no dependencies or conflicts at all
	const hasDeps = segments.some(
		(s) => s.dependsOn.length > 0 || s.conflictsWith.length > 0,
	);
	if (!hasDeps) return segments;

	let current = [...segments];
	let changed = true;
	const maxIterations = 10; // Guard against infinite loops
	let iteration = 0;

	while (changed && iteration < maxIterations) {
		changed = false;
		iteration++;

		const activeIds = new Set(current.map((s) => s.id));
		const next: Segment[] = [];

		for (const segment of current) {
			// Check depends_on: ALL must be active
			if (segment.dependsOn.length > 0) {
				const allDepsActive = segment.dependsOn.every((depId) =>
					activeIds.has(depId),
				);
				if (!allDepsActive) {
					changed = true;
					continue; // Skip this segment
				}
			}

			// Check conflicts_with: NONE should be active
			if (segment.conflictsWith.length > 0) {
				const hasConflict = segment.conflictsWith.some((conflictId) =>
					activeIds.has(conflictId),
				);
				if (hasConflict) {
					changed = true;
					continue; // Skip this segment
				}
			}

			next.push(segment);
		}

		current = next;
	}

	return current;
}
