/**
 * Shared prompt registry instance for the coding agent.
 * Lazily initialized on first access.
 */
import { createPromptRegistry, getTemplatesDir } from "./prompt/index.js";
let _registry = null;
/**
 * Get the shared prompt registry instance.
 * Creates and caches it on first call.
 */
export function getPromptRegistry() {
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
export function invalidatePromptRegistry() {
    if (_registry) {
        _registry.invalidate();
    }
}
//# sourceMappingURL=prompt-registry.js.map