import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { PromptParseError } from "./errors.js";
import type { ParsedPrompt, PromptMeta, VariableDefinition, VariableType } from "./types.js";

/** Raw frontmatter shape before validation */
interface RawFrontmatter {
	name?: string;
	description?: string;
	version?: number;
	extends?: string;
	includes?: string[];
	variables?: RawVariableDefinition[];
}

interface RawVariableDefinition {
	name?: string;
	type?: string;
	required?: boolean;
	default?: unknown;
	description?: string;
}

const VALID_VARIABLE_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "string[]", "object[]"]);

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Extract YAML frontmatter and body from raw content.
 * Returns null frontmatter if no valid frontmatter block found.
 */
function extractFrontmatter(content: string): { yaml: string | null; body: string } {
	const match = FRONTMATTER_REGEX.exec(content);
	if (!match) {
		return { yaml: null, body: content };
	}
	return { yaml: match[1], body: match[2] };
}

/**
 * Validate and normalize a single variable definition from frontmatter.
 */
function validateVariable(raw: RawVariableDefinition, filePath: string): VariableDefinition {
	if (!raw.name || typeof raw.name !== "string") {
		throw new PromptParseError("Variable missing required 'name' field", filePath);
	}

	const type = (raw.type ?? "string") as VariableType;
	if (!VALID_VARIABLE_TYPES.has(type)) {
		throw new PromptParseError(
			`Variable "${raw.name}" has invalid type "${raw.type}". Valid types: ${[...VALID_VARIABLE_TYPES].join(", ")}`,
			filePath,
		);
	}

	return {
		name: raw.name,
		type,
		required: raw.required ?? true,
		default: raw.default,
		description: raw.description,
	};
}

/**
 * Derive category from file path relative to templates root.
 * e.g., "templates/system/coding-agent.prompt.md" -> "system"
 * e.g., "templates/tools/read.prompt.md" -> "tools"
 * e.g., "templates/base.prompt.md" -> "root"
 */
function deriveCategory(filePath: string, templatesDir: string): string {
	const rel = relative(templatesDir, filePath);
	const dir = dirname(rel);
	if (dir === ".") return "root";
	// Take the first path segment as category
	return dir.split("/")[0];
}

/**
 * Derive prompt name from file path relative to templates root.
 * e.g., "templates/system/coding-agent.prompt.md" -> "system/coding-agent"
 * e.g., "templates/tools/read.prompt.md" -> "tools/read"
 */
export function derivePromptName(filePath: string, templatesDir: string, extension: string): string {
	const rel = relative(templatesDir, filePath);
	// Remove the extension suffix
	if (rel.endsWith(extension)) {
		return rel.slice(0, -extension.length);
	}
	// Fallback: remove last extension
	const dot = rel.lastIndexOf(".");
	return dot > 0 ? rel.slice(0, dot) : rel;
}

/**
 * Parse a .prompt.md file from disk.
 */
export function parsePromptFile(filePath: string, templatesDir: string, extension: string): ParsedPrompt {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new PromptParseError(`Cannot read file: ${(err as Error).message}`, filePath);
	}

	return parsePromptContent(content, filePath, templatesDir, extension);
}

/**
 * Parse prompt content (frontmatter + body) from a string.
 */
export function parsePromptContent(
	content: string,
	filePath: string,
	templatesDir: string,
	extension: string,
): ParsedPrompt {
	const { yaml: yamlStr, body } = extractFrontmatter(content);

	let raw: RawFrontmatter = {};
	if (yamlStr) {
		try {
			const parsed = parseYaml(yamlStr);
			if (parsed && typeof parsed === "object") {
				raw = parsed as RawFrontmatter;
			}
		} catch (err) {
			throw new PromptParseError(`Invalid YAML frontmatter: ${(err as Error).message}`, filePath);
		}
	}

	// Derive name from frontmatter or file path
	const name = raw.name ?? derivePromptName(filePath, templatesDir, extension);

	// Validate variables
	const variables: VariableDefinition[] = [];
	if (Array.isArray(raw.variables)) {
		for (const rawVar of raw.variables) {
			if (rawVar && typeof rawVar === "object") {
				variables.push(validateVariable(rawVar, filePath));
			}
		}
	}

	// Validate includes
	if (raw.includes !== undefined && !Array.isArray(raw.includes)) {
		throw new PromptParseError("'includes' must be an array of strings", filePath);
	}

	const meta: PromptMeta = {
		name,
		description: raw.description ?? "",
		version: raw.version ?? 1,
		extends: raw.extends,
		includes: raw.includes,
		variables,
		category: deriveCategory(filePath, templatesDir),
		filePath,
	};

	return { meta, rawBody: body };
}
