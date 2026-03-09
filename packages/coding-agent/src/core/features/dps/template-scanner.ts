/**
 * Dynamic Prompt System (DPS) — Template Scanner
 *
 * Scans the PromptRegistry for all templates that have a `dps:` block in their
 * YAML frontmatter. Parses each dps block into a DpsEntry with typed conditions,
 * a compiled evaluator, and dependency/conflict metadata.
 *
 * Called once during DPS feature setup (and again on /dps:reload).
 * The registry's list() + getMeta() API is the discovery mechanism — DPS never
 * reads the filesystem directly; all template access goes through the registry.
 */

import type { PromptRegistry } from "@mariozechner/pi-prompt";
import { compileConditions, parseConditions } from "./condition-engine.js";
import type { DpsEntry, Layer } from "./types.js";

/** Valid layer values */
const VALID_LAYERS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

/**
 * Scan the registry for all templates that have a `dps:` block in frontmatter.
 * Parse each dps block into a DpsEntry object ready for condition evaluation.
 *
 * Validation:
 * - Templates without `dps:` in meta.extra are silently skipped.
 * - Templates with an invalid or missing `dps.layer` emit a console.warn and are skipped.
 *
 * Reference validation (after building all entries):
 * - depends_on references to unknown template names emit a console.warn.
 * - conflicts_with references to unknown template names emit a console.warn.
 * - These warnings are informational; the entry is still included.
 */
export function scanDpsTemplates(registry: PromptRegistry): DpsEntry[] {
	const entries: DpsEntry[] = [];

	for (const name of registry.list()) {
		const meta = registry.getMeta(name);
		const dpsBlock = meta.extra.dps as Record<string, unknown> | undefined;
		if (!dpsBlock) continue;

		// Validate required dps.layer field
		const layer = dpsBlock.layer as number | undefined;
		if (layer === undefined || !VALID_LAYERS.has(layer)) {
			console.warn(`DPS: template "${name}" has invalid dps.layer: ${JSON.stringify(layer)}, skipping`);
			continue;
		}

		// Parse conditions array (defaults to empty = always active)
		const rawConditions = Array.isArray(dpsBlock.conditions) ? (dpsBlock.conditions as unknown[]) : [];
		const conditions = parseConditions(rawConditions);
		const evaluator = compileConditions(conditions);

		entries.push({
			templateName: name,
			layer: layer as Layer,
			priority: typeof dpsBlock.priority === "number" ? dpsBlock.priority : 50,
			conditions,
			evaluator,
			dependsOn: Array.isArray(dpsBlock.depends_on) ? (dpsBlock.depends_on as string[]) : [],
			conflictsWith: Array.isArray(dpsBlock.conflicts_with) ? (dpsBlock.conflicts_with as string[]) : [],
			cooldown: typeof dpsBlock.cooldown === "number" ? dpsBlock.cooldown : undefined,
			maxTriggers: typeof dpsBlock.max_triggers === "number" ? dpsBlock.max_triggers : undefined,
		});
	}

	// Warn on broken depends_on / conflicts_with references.
	// References pointing to template names not discovered in this scan are likely typos
	// or missing templates — warn so the author can catch them early.
	const nameSet = new Set(entries.map((e) => e.templateName));

	for (const entry of entries) {
		for (const dep of entry.dependsOn) {
			if (!nameSet.has(dep)) {
				console.warn(`DPS: "${entry.templateName}" depends_on unknown template "${dep}"`);
			}
		}
		for (const conflict of entry.conflictsWith) {
			if (!nameSet.has(conflict)) {
				console.warn(`DPS: "${entry.templateName}" conflicts_with unknown template "${conflict}"`);
			}
		}
	}

	return entries;
}
