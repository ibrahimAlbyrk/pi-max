/**
 * Shared prompt registry instance for the mom package.
 */

import { createPromptRegistry, getTemplatesDir, type PromptRegistry } from "@mariozechner/pi-prompt";

let _registry: PromptRegistry | null = null;

export function getPromptRegistry(): PromptRegistry {
	if (!_registry) {
		_registry = createPromptRegistry({
			templatesDir: getTemplatesDir(),
		});
	}
	return _registry;
}
