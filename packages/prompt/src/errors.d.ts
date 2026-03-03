/** Base error class for all prompt-related errors */
export declare class PromptError extends Error {
	constructor(message: string);
}
/** Thrown when a prompt file cannot be found by name */
export declare class PromptNotFoundError extends PromptError {
	readonly promptName: string;
	constructor(promptName: string);
}
/** Thrown when a required variable is not provided at render time */
export declare class VariableRequiredError extends PromptError {
	readonly variableName: string;
	readonly promptName: string;
	constructor(variableName: string, promptName: string);
}
/** Thrown when circular extends/includes references are detected */
export declare class CircularReferenceError extends PromptError {
	readonly chain: string[];
	constructor(chain: string[]);
}
/** Thrown when template rendering fails (syntax errors, invalid expressions) */
export declare class TemplateRenderError extends PromptError {
	readonly promptName: string;
	constructor(message: string, promptName: string);
}
/** Thrown when a .prompt.md file has invalid frontmatter or structure */
export declare class PromptParseError extends PromptError {
	readonly filePath: string;
	constructor(message: string, filePath: string);
}
/** Thrown when extends depth exceeds the maximum allowed */
export declare class ExtendsDepthError extends PromptError {
	readonly promptName: string;
	readonly maxDepth: number;
	constructor(promptName: string, maxDepth: number);
}
//# sourceMappingURL=errors.d.ts.map
