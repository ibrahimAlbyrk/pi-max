/**
 * DPS Segment Registry
 *
 * Loads .md segment files from 3 directories (builtin > global > project).
 * Same-id segments are overridden by higher-priority sources.
 * Parse-once caching: segments are parsed at load time and kept in memory.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import type { Segment, SegmentSource, Layer } from "./types.js";
import { SOURCE_PRIORITY } from "./types.js";
import { parseSegmentFile, parseConditions } from "./segment-parser.js";
import { compileConditions } from "./condition-engine.js";

// ============================================================================
// Registry
// ============================================================================

export class SegmentRegistry {
	/** All loaded segments, keyed by id. Higher-source overrides lower */
	private segments: Map<string, Segment> = new Map();

	/** All segments as array (cached after load) */
	private segmentArray: Segment[] = [];

	/**
	 * Load segments from all directories.
	 * Call order: builtin first, then global, then project.
	 * Later sources override earlier ones for same id.
	 */
	loadAll(dirs: SegmentDirectory[]): void {
		this.segments.clear();

		// Sort by source priority (builtin=0 first, project=2 last)
		const sorted = [...dirs].sort(
			(a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source],
		);

		for (const dir of sorted) {
			this.loadDirectory(dir.path, dir.source);
		}

		// Build cached array
		this.segmentArray = Array.from(this.segments.values());

		// Post-load validation: check depends_on and conflicts_with references
		const allIds = new Set(this.segments.keys());
		for (const segment of this.segmentArray) {
			for (const depId of segment.dependsOn) {
				if (!allIds.has(depId)) {
					console.warn(`[DPS] Segment '${segment.id}' depends_on '${depId}' which does not exist`);
				}
			}
			for (const conflictId of segment.conflictsWith) {
				if (!allIds.has(conflictId)) {
					console.warn(`[DPS] Segment '${segment.id}' conflicts_with '${conflictId}' which does not exist`);
				}
			}
		}
	}

	/**
	 * Get all loaded segments.
	 */
	getAll(): Segment[] {
		return this.segmentArray;
	}

	/**
	 * Get segment by id.
	 */
	get(id: string): Segment | undefined {
		return this.segments.get(id);
	}

	/**
	 * Get count of loaded segments.
	 */
	get size(): number {
		return this.segments.size;
	}

	// ========================================================================
	// Private
	// ========================================================================

	private loadDirectory(dirPath: string, source: SegmentSource): void {
		if (!existsSync(dirPath)) return;

		let entries: string[];
		try {
			entries = readdirSync(dirPath);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;

			const filePath = join(dirPath, entry);

			try {
				if (!statSync(filePath).isFile()) continue;
			} catch {
				continue;
			}

			const segment = this.parseFile(filePath, source);
			if (!segment) continue;

			const existing = this.segments.get(segment.id);
			if (existing) {
				// Override if same or higher priority source
				if (SOURCE_PRIORITY[source] >= SOURCE_PRIORITY[existing.source]) {
					this.segments.set(segment.id, segment);
				}
			} else {
				this.segments.set(segment.id, segment);
			}
		}
	}

	private parseFile(filePath: string, source: SegmentSource): Segment | null {
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}

		const parsed = parseSegmentFile(raw);
		if (!parsed) {
			console.warn(`[DPS] Skipping invalid segment file: ${filePath}`);
			return null;
		}

		const { metadata, content } = parsed;

		// Validate required fields
		if (!metadata.id || typeof metadata.id !== "string") {
			console.warn(`[DPS] Missing 'id' in: ${filePath}`);
			return null;
		}

		if (metadata.layer === undefined || ![0, 1, 2, 3, 4].includes(metadata.layer)) {
			console.warn(`[DPS] Invalid 'layer' in: ${filePath}`);
			return null;
		}

		// Parse conditions
		const conditions = parseConditions(metadata.conditions || []);

		// Compile evaluator
		const evaluator = compileConditions(conditions);

		// Validation: L4 (reminder) segments should have cooldown and max_triggers
		const layer = metadata.layer as Layer;
		if (layer === 4) {
			if (typeof metadata.cooldown !== "number") {
				console.warn(`[DPS] L4 segment '${metadata.id}' missing 'cooldown' — defaulting to 5. File: ${filePath}`);
			}
			if (typeof metadata.max_triggers !== "number") {
				console.warn(`[DPS] L4 segment '${metadata.id}' missing 'max_triggers' — defaulting to 1. File: ${filePath}`);
			}
		}

		// Validation: warn if content is empty
		if (!content.trim()) {
			console.warn(`[DPS] Segment '${metadata.id}' has empty content. File: ${filePath}`);
		}

		const segment: Segment = {
			id: metadata.id,
			layer,
			priority: typeof metadata.priority === "number" ? metadata.priority : 50,
			content,
			conditions,
			evaluator,
			dependsOn: Array.isArray(metadata.depends_on)
				? metadata.depends_on.map(String)
				: [],
			conflictsWith: Array.isArray(metadata.conflicts_with)
				? metadata.conflicts_with.map(String)
				: [],
			cooldown: typeof metadata.cooldown === "number" ? metadata.cooldown : (layer === 4 ? 5 : undefined),
			maxTriggers: typeof metadata.max_triggers === "number"
				? metadata.max_triggers
				: (layer === 4 ? 1 : undefined),
			filePath,
			source,
		};

		return segment;
	}
}

// ============================================================================
// Helper Types
// ============================================================================

export interface SegmentDirectory {
	path: string;
	source: SegmentSource;
}

// ============================================================================
// Directory Discovery
// ============================================================================

/**
 * Discover segment directories based on extension location and working directory.
 */
export function discoverSegmentDirs(
	extensionDir: string,
	cwd: string,
): SegmentDirectory[] {
	const dirs: SegmentDirectory[] = [];

	// 1. Built-in segments (inside extension)
	const builtinDir = resolve(extensionDir, "segments");
	if (existsSync(builtinDir)) {
		dirs.push({ path: builtinDir, source: "builtin" });
	}

	// 2. Global user segments
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	if (homeDir) {
		const globalDir = join(homeDir, ".pi", "agent", "prompts", "dps");
		if (existsSync(globalDir)) {
			dirs.push({ path: globalDir, source: "global" });
		}
	}

	// 3. Project-specific segments
	const projectDir = join(cwd, ".pi", "prompts", "dps");
	if (existsSync(projectDir)) {
		dirs.push({ path: projectDir, source: "project" });
	}

	return dirs;
}
