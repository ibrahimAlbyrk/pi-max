/**
 * Shared prompt registry instance for the coding agent.
 * Lazily initialized on first access.
 */
import { type PromptRegistry } from "./prompt/index.js";
/**
 * Get the shared prompt registry instance.
 * Creates and caches it on first call.
 */
export declare function getPromptRegistry(): PromptRegistry;
/**
 * Invalidate the shared registry cache (e.g., on /reload).
 */
export declare function invalidatePromptRegistry(): void;
//# sourceMappingURL=prompt-registry.d.ts.map
