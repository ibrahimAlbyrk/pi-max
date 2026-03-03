/** Supported variable types in prompt templates */
export type VariableType = "string" | "number" | "boolean" | "string[]" | "object[]";
/** Definition of a template variable declared in frontmatter */
export interface VariableDefinition {
	/** Variable name (used as {{NAME}} in template) */
	name: string;
	/** Expected type */
	type: VariableType;
	/** Whether the variable must be provided at render time */
	required: boolean;
	/** Default value when not provided (only for required: false) */
	default?: unknown;
	/** Human-readable description */
	description?: string;
}
/** Parsed frontmatter metadata from a .prompt.md file */
export interface PromptMeta {
	/** Unique prompt identifier */
	name: string;
	/** Human-readable description */
	description: string;
	/** Schema version for tracking changes */
	version: number;
	/** Parent prompt to inherit from (single inheritance) */
	extends?: string;
	/** Partial prompts to include */
	includes?: string[];
	/** Variable definitions */
	variables: VariableDefinition[];
	/** Category derived from file path (e.g., "system", "tools", "agents") */
	category: string;
	/** Absolute file path */
	filePath: string;
	/** Extra frontmatter fields not part of the core schema (e.g., agentConfig) */
	extra: Record<string, unknown>;
}
/** Result of parsing a .prompt.md file */
export interface ParsedPrompt {
	/** Parsed frontmatter metadata */
	meta: PromptMeta;
	/** Raw template body (after frontmatter, before any rendering) */
	rawBody: string;
}
/** Cached prompt entry with resolved inheritance and includes */
export interface ResolvedPrompt {
	/** Parsed metadata */
	meta: PromptMeta;
	/** Raw body before extends/includes resolution */
	rawBody: string;
	/** Body after extends (parent prepended) and includes resolved */
	resolvedBody: string;
}
/** Result of validating a single prompt */
export interface ValidationResult {
	/** Prompt name that was validated */
	promptName: string;
	/** Critical issues that prevent rendering */
	errors: string[];
	/** Non-critical issues */
	warnings: string[];
}
/** Options for creating a PromptRegistry */
export interface PromptRegistryOptions {
	/** Root directory containing .prompt.md template files */
	templatesDir: string;
	/** Additional directories to scan for templates */
	additionalDirs?: string[];
	/** File extension to scan for (default: ".prompt.md") */
	extension?: string;
	/** Maximum inheritance depth to prevent circular references (default: 5) */
	maxExtendsDepth?: number;
}
/** Variables passed to render() - keys are variable names, values are their runtime values */
export type RenderVariables = Record<string, unknown>;
/** Context passed to the renderer for template evaluation */
export interface RendererContext {
	/** Variables available for replacement */
	variables: RenderVariables;
	/** Function to resolve a partial by name (for {{> partial}} syntax) */
	resolvePartial: (name: string) => string;
}
/** Public interface for the prompt registry */
export interface PromptRegistry {
	/** Render a prompt with variables applied */
	render(name: string, variables?: RenderVariables): string;
	/** Get prompt metadata without rendering */
	getMeta(name: string): PromptMeta;
	/** List all registered prompt names */
	list(): string[];
	/** List prompts in a specific category */
	listByCategory(category: string): string[];
	/** Clear cache (specific prompt or all) */
	invalidate(name?: string): void;
	/** Validate all prompts for errors */
	validate(): ValidationResult[];
}
//# sourceMappingURL=types.d.ts.map
