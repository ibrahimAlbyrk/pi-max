/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { getPromptRegistry } from "./prompt-registry.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/** Minimal tool info needed for system prompt generation */
export interface ToolInfo {
	name: string;
	description: string;
}

/**
 * Get the short description for a tool.
 * Falls back to first sentence of tool's own description if no prompt template exists.
 */
function getToolShortDescription(tool: ToolInfo): string {
	const registry = getPromptRegistry();
	try {
		return registry.render(`tools/${tool.name}-short`);
	} catch {
		// No prompt template for this tool — use tool's own description (first line)
		const firstLine = tool.description.split("\n")[0].trim();
		return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
	}
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Active tools to list in the prompt. Each must have name and description. */
	activeTools?: ToolInfo[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		activeTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !activeTools || activeTools.some((t) => t.name === "read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list from active tools
	const tools = activeTools ?? [];
	const toolsList =
		tools.length > 0 ? tools.map((t) => `- ${t.name}: ${getToolShortDescription(t)}`).join("\n") : "(none)";

	// Build context sections
	let contextFilesSection = "";
	if (contextFiles.length > 0) {
		contextFilesSection = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			contextFilesSection += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	let skillsSection = "";
	if (tools.some((t) => t.name === "read") && skills.length > 0) {
		skillsSection = formatSkillsForPrompt(skills);
	}

	const registry = getPromptRegistry();
	return registry.render("system/coding-agent", {
		TOOLS_LIST: toolsList,
		README_PATH: readmePath,
		DOCS_PATH: docsPath,
		EXAMPLES_PATH: examplesPath,
		APPEND_SECTION: appendSection,
		CONTEXT_FILES_SECTION: contextFilesSection,
		SKILLS_SECTION: skillsSection,
		DATE_TIME: dateTime,
		WORKING_DIR: resolvedCwd,
	});
}
