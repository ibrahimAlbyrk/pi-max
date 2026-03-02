import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getPromptsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // "user", "project", or "path"
	filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args FIRST (before wildcards)
	// This prevents wildcard replacement values containing $<digit> patterns from being re-substituted
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Replace ${@:start} or ${@:start:length} with sliced args (bash-style)
	// Process BEFORE simple $@ to avoid conflicts
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
		// Treat 0 as 1 (bash convention: args start at 1)
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	// Pre-compute all args joined (optimization)
	const allArgs = args.join(" ");

	// Replace $ARGUMENTS with all args joined (new syntax, aligns with Claude, Codex, OpenCode)
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// Replace $@ with all args joined (existing syntax)
	result = result.replace(/\$@/g, allArgs);

	return result;
}

function loadTemplateFromFile(
	filePath: string,
	source: string,
	sourceLabel: string,
	nameOverride?: string,
): PromptTemplate | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		const name = nameOverride ?? basename(filePath).replace(/\.md$/, "");

		// Get description from frontmatter or first non-empty line
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// Truncate if too long
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		// Append source to description
		description = description ? `${description} ${sourceLabel}` : sourceLabel;

		return {
			name,
			description,
			content: body,
			source,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * Scan a directory recursively for .md files and load them as prompt templates.
 * Subdirectory names become part of the template name using "/" as separator.
 * Example: prompts/git/commit.md → name: "git/commit"
 */
function loadTemplatesFromDir(dir: string, source: string, sourceLabel: string, prefix: string = ""): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// For symlinks, resolve actual type
			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
					isDirectory = stats.isDirectory();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const baseName = entry.name.replace(/\.md$/, "");
				const templateName = prefix ? `${prefix}/${baseName}` : undefined;
				const template = loadTemplateFromFile(fullPath, source, sourceLabel, templateName);
				if (template) {
					templates.push(template);
				}
			} else if (isDirectory) {
				// Recurse into subdirectory with updated prefix
				const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
				templates.push(...loadTemplatesFromDir(fullPath, source, sourceLabel, subPrefix));
			}
		}
	} catch {
		return templates;
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
	/** Explicit prompt template paths (files or directories) */
	promptPaths?: string[];
	/** Include default prompt directories. Default: true */
	includeDefaults?: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function buildPathSourceLabel(p: string): string {
	const base = basename(p).replace(/\.md$/, "") || "path";
	return `(path:${base})`;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): PromptTemplate[] {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();
	const promptPaths = options.promptPaths ?? [];
	const includeDefaults = options.includeDefaults ?? true;

	const templates: PromptTemplate[] = [];

	if (includeDefaults) {
		// 1. Load global templates from agentDir/prompts/
		// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
		const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
		templates.push(...loadTemplatesFromDir(globalPromptsDir, "user", "(user)"));

		// 2. Load project templates from cwd/{CONFIG_DIR_NAME}/prompts/
		const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
		templates.push(...loadTemplatesFromDir(projectPromptsDir, "project", "(project)"));
	}

	const userPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): { source: string; label: string } => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userPromptsDir)) {
				return { source: "user", label: "(user)" };
			}
			if (isUnderPath(resolvedPath, projectPromptsDir)) {
				return { source: "project", label: "(project)" };
			}
		}
		return { source: "path", label: buildPathSourceLabel(resolvedPath) };
	};

	/**
	 * Derive a nested template name from a file path relative to a known prompts root.
	 * e.g. /home/user/.pi/agent/prompts/git/commit.md → "git/commit"
	 * Returns undefined if the file is directly in a prompts root (no nesting).
	 */
	const deriveNestedName = (filePath: string): string | undefined => {
		const roots = [userPromptsDir, projectPromptsDir];
		for (const root of roots) {
			if (isUnderPath(filePath, root)) {
				const rel = filePath.slice(resolve(root).length + 1).replace(/\.md$/, "");
				// Only return if there's actual nesting (contains path separator)
				if (rel.includes(sep) || rel.includes("/")) {
					// Normalize to forward slashes
					return rel.split(sep).join("/");
				}
			}
		}
		return undefined;
	};

	// 3. Load explicit prompt paths
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const { source, label } = getSourceInfo(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, source, label));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const nestedName = deriveNestedName(resolvedPath);
				const template = loadTemplateFromFile(resolvedPath, source, label, nestedName);
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// Ignore read failures
		}
	}

	return templates;
}

/** Check whether a template body contains any argument placeholders */
const HAS_ARG_PLACEHOLDER = /\$(\d+|@|ARGUMENTS|\{@:[^}]+\})/;

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 *
 * If the template contains no argument placeholders ($1, $@, $ARGUMENTS, ${@:...})
 * and the user provided arguments, they are appended to the end of the content.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const rawName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	// Convert colon separator to slash for nested prompts (e.g., "git:commit" → "git/commit")
	const templateName = rawName.replace(/:/g, "/");

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const expanded = substituteArgs(template.content, args);

		// If the template has no placeholders but the user provided args, append them
		if (args.length > 0 && !HAS_ARG_PLACEHOLDER.test(template.content)) {
			return `${expanded}\n\n${args.join(" ")}`;
		}

		return expanded;
	}

	return text;
}
