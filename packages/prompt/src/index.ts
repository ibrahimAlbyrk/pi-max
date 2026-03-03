// Public API
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get the absolute path to the built-in templates directory.
 * Works both in development (source) and production (npm package).
 */
export function getTemplatesDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	// In dev: packages/prompt/src/index.ts -> packages/prompt/templates
	// In dist: packages/prompt/dist/index.js -> packages/prompt/templates
	const packageRoot = resolve(thisFile, "..", "..");
	return resolve(packageRoot, "templates");
}

// Errors
export {
	CircularReferenceError,
	ExtendsDepthError,
	PromptError,
	PromptNotFoundError,
	PromptParseError,
	TemplateRenderError,
	VariableRequiredError,
} from "./errors.js";
export { derivePromptName, parsePromptContent, parsePromptFile } from "./parser.js";
export { createPromptRegistry } from "./registry.js";
export { renderTemplate } from "./renderer.js";
// Types
export type {
	ParsedPrompt,
	PromptMeta,
	PromptRegistry,
	PromptRegistryOptions,
	RendererContext,
	RenderVariables,
	ResolvedPrompt,
	ValidationResult,
	VariableDefinition,
	VariableType,
} from "./types.js";
