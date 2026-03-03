/**
 * System prompt construction and project context loading
 */
import { type Skill } from "./skills.js";
/** Minimal tool info needed for system prompt generation */
export interface ToolInfo {
	name: string;
	description: string;
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
	contextFiles?: Array<{
		path: string;
		content: string;
	}>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}
/** Build the system prompt with tools, guidelines, and context */
export declare function buildSystemPrompt(options?: BuildSystemPromptOptions): string;
//# sourceMappingURL=system-prompt.d.ts.map
