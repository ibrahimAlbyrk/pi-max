/**
 * Shared prompt registry instance for the coding agent.
 * Lazily initialized on first access.
 */

import { createPromptRegistry, getTemplatesDir, type PromptRegistry } from "@mariozechner/pi-prompt";

let _registry: PromptRegistry | null = null;

/**
 * Get the shared prompt registry instance.
 * Creates and caches it on first call.
 */
export function getPromptRegistry(): PromptRegistry {
	if (!_registry) {
		_registry = createPromptRegistry({
			templatesDir: getTemplatesDir(),
		});
	}
	return _registry;
}

/**
 * Invalidate the shared registry cache (e.g., on /reload).
 */
export function invalidatePromptRegistry(): void {
	if (_registry) {
		_registry.invalidate();
	}
}
