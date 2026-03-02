/**
 * DPS Hook: session_start
 *
 * Initializes DPS on session load:
 * - Resets state
 * - Discovers segment directories
 * - Loads all segments
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SegmentRegistry } from "../core/segment-registry.js";
import { discoverSegmentDirs } from "../core/segment-registry.js";
import type { StateManager } from "../core/state-manager.js";
import type { PromptComposer } from "../core/prompt-composer.js";

export function handleSessionStart(
	registry: SegmentRegistry,
	stateManager: StateManager,
	composer: PromptComposer,
	extensionDir: string,
) {
	return async (_event: any, ctx: ExtensionContext) => {
		// Reset state
		stateManager.reset();
		composer.reset();

		// Set CWD
		stateManager.setCwd(ctx.cwd);

		// Discover and load segments
		const dirs = discoverSegmentDirs(extensionDir, ctx.cwd);
		registry.loadAll(dirs);
	};
}
