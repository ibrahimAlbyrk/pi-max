/**
 * Get the absolute path to the built-in templates directory.
 * Works both in development (source) and production (npm package).
 */
export declare function getTemplatesDir(): string;
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
//# sourceMappingURL=index.d.ts.map
