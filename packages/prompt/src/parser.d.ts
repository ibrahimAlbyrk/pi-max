import type { ParsedPrompt } from "./types.js";
/**
 * Derive prompt name from file path relative to templates root.
 * e.g., "templates/system/coding-agent.prompt.md" -> "system/coding-agent"
 * e.g., "templates/tools/read.prompt.md" -> "tools/read"
 */
export declare function derivePromptName(filePath: string, templatesDir: string, extension: string): string;
/**
 * Parse a .prompt.md file from disk.
 */
export declare function parsePromptFile(filePath: string, templatesDir: string, extension: string): ParsedPrompt;
/**
 * Parse prompt content (frontmatter + body) from a string.
 */
export declare function parsePromptContent(
	content: string,
	filePath: string,
	templatesDir: string,
	extension: string,
): ParsedPrompt;
//# sourceMappingURL=parser.d.ts.map
