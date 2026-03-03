/** Base error class for all prompt-related errors */
export class PromptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptError";
	}
}

/** Thrown when a prompt file cannot be found by name */
export class PromptNotFoundError extends PromptError {
	constructor(public readonly promptName: string) {
		super(`Prompt not found: "${promptName}"`);
		this.name = "PromptNotFoundError";
	}
}

/** Thrown when a required variable is not provided at render time */
export class VariableRequiredError extends PromptError {
	constructor(
		public readonly variableName: string,
		public readonly promptName: string,
	) {
		super(`Required variable "${variableName}" not provided for prompt "${promptName}"`);
		this.name = "VariableRequiredError";
	}
}

/** Thrown when circular extends/includes references are detected */
export class CircularReferenceError extends PromptError {
	constructor(public readonly chain: string[]) {
		super(`Circular reference detected: ${chain.join(" -> ")}`);
		this.name = "CircularReferenceError";
	}
}

/** Thrown when template rendering fails (syntax errors, invalid expressions) */
export class TemplateRenderError extends PromptError {
	constructor(
		message: string,
		public readonly promptName: string,
	) {
		super(`Template render error in "${promptName}": ${message}`);
		this.name = "TemplateRenderError";
	}
}

/** Thrown when a .prompt.md file has invalid frontmatter or structure */
export class PromptParseError extends PromptError {
	constructor(
		message: string,
		public readonly filePath: string,
	) {
		super(`Parse error in "${filePath}": ${message}`);
		this.name = "PromptParseError";
	}
}

/** Thrown when extends depth exceeds the maximum allowed */
export class ExtendsDepthError extends PromptError {
	constructor(
		public readonly promptName: string,
		public readonly maxDepth: number,
	) {
		super(`Extends depth exceeded maximum of ${maxDepth} for prompt "${promptName}"`);
		this.name = "ExtendsDepthError";
	}
}
