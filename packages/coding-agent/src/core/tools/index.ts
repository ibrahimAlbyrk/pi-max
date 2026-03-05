export { askQuestionTool } from "./ask-question.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	createSearchTool,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
	searchTool,
} from "./search.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWebfetchTool,
	type WebfetchToolDetails,
	type WebfetchToolInput,
	webfetchTool,
} from "./webfetch.js";
export {
	createWebsearchTool,
	type WebsearchToolDetails,
	type WebsearchToolInput,
	websearchTool,
} from "./websearch.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createSearchTool, searchTool } from "./search.js";
import { createWebfetchTool } from "./webfetch.js";
import { createWebsearchTool } from "./websearch.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

/**
 * Single source of truth for all built-in tool factories.
 * Maps tool name → factory function that creates a tool instance for a given cwd.
 *
 * When adding a new built-in tool, add it here — allTools, ToolName, and
 * createToolsByName() all derive from this registry automatically.
 */
const _toolRegistry = {
	read: (cwd: string) => createReadTool(cwd),
	bash: (cwd: string) => createBashTool(cwd),
	edit: (cwd: string) => createEditTool(cwd),
	write: (cwd: string) => createWriteTool(cwd),
	search: (cwd: string) => createSearchTool(cwd),
	webfetch: (_cwd: string) => createWebfetchTool(),
	websearch: (_cwd: string) => createWebsearchTool(),
};

export type ToolName = keyof typeof _toolRegistry;

export const toolRegistry: Record<ToolName, (cwd: string) => Tool> = _toolRegistry;

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [readTool, searchTool];

// All available tools (using process.cwd()) — derived from toolRegistry
export const allTools = Object.fromEntries(
	Object.entries(toolRegistry).map(([name, factory]) => [name, factory(process.cwd())]),
) as Record<ToolName, Tool>;

/**
 * Create tools by name for a specific working directory.
 * Used by subagent runtimes to create tool instances from YAML/parameter tool lists.
 * Unknown tool names are silently skipped.
 */
export function createToolsByName(names: string[], cwd: string): Tool[] {
	return names
		.map((n) => toolRegistry[n.trim() as ToolName])
		.filter(Boolean)
		.map((factory) => factory(cwd));
}

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createSearchTool(cwd)];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		search: createSearchTool(cwd),
		webfetch: createWebfetchTool(),
		websearch: createWebsearchTool(),
	};
}
