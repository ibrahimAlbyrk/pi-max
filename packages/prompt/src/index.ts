// Public API

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
