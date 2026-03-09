/**
 * Shared prompt registry instance for the coding agent.
 * Lazily initialized on first access.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPromptRegistry, getTemplatesDir, type PromptRegistry } from "@mariozechner/pi-prompt";

let _registry: PromptRegistry | null = null;
let _lastCwd: string | undefined;

/**
 * Get the shared prompt registry instance.
 * Creates and caches it on first call, or when cwd changes.
 *
 * additionalDirs (in priority order):
 *   1. ~/.pi/agent/prompts/   — global user prompts
 *   2. <cwd>/.pi/prompts/     — project prompts
 */
export function getPromptRegistry(cwd?: string): PromptRegistry {
	// Re-create if cwd changed
	if (_registry && cwd !== _lastCwd) {
		_registry = null;
	}

	if (!_registry) {
		_lastCwd = cwd;

		const additionalDirs: string[] = [];

		// Global user prompts
		const globalDir = join(homedir(), ".pi", "agent", "prompts");
		if (existsSync(globalDir)) {
			additionalDirs.push(globalDir);
		}

		// Project prompts
		if (cwd) {
			const projectDir = join(cwd, ".pi", "prompts");
			if (existsSync(projectDir)) {
				additionalDirs.push(projectDir);
			}
		}

		_registry = createPromptRegistry({
			templatesDir: getTemplatesDir(),
			additionalDirs,
		});
	}

	return _registry;
}

/**
 * Invalidate the shared registry cache.
 * Forces re-creation on next call to getPromptRegistry().
 */
export function invalidatePromptRegistry(): void {
	_registry = null;
	_lastCwd = undefined;
}
