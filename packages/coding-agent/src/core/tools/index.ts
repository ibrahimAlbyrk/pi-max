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
	type BgToolDetails,
	type BgToolInput,
	bgToolDefinition,
	createBgTool,
} from "./bg.js";
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
	createTaskTool,
	type TaskToolInput,
	taskToolDefinition,
} from "./task.js";
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
import type { ToolDefinition } from "../extensions/types.js";
import { askQuestionTool } from "./ask-question.js";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { bgToolDefinition, createBgTool } from "./bg.js";
import { createEditTool, editTool } from "./edit.js";
import { createLspDefinitionTool, lspDefinitionDefinition } from "./lsp-definition.js";
import { createLspDiagnosticsTool, lspDiagnosticsDefinition } from "./lsp-diagnostics.js";
import { createLspReferencesTool, lspReferencesDefinition } from "./lsp-references.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createSearchTool, searchTool } from "./search.js";
import { createTaskTool, taskToolDefinition } from "./task.js";
import { createWebfetchTool } from "./webfetch.js";
import { createWebsearchTool } from "./websearch.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

/** Tool factory with optional ToolDefinition for UI rendering. */
type ToolFactory = ((cwd: string) => Tool) & { definition?: ToolDefinition };

/** Attach a ToolDefinition to a factory so getToolDefinitions() can collect it. */
function withDefinition(factory: (cwd: string) => Tool, definition: ToolDefinition): ToolFactory {
	const f = factory as ToolFactory;
	f.definition = definition;
	return f;
}

/**
 * Single source of truth for all built-in tool factories.
 * Maps tool name → factory function that creates a tool instance for a given cwd.
 *
 * Tools with UI rendering (renderCall/renderResult) attach their ToolDefinition
 * via withDefinition(). getToolDefinitions() collects these automatically —
 * no hardcoded lists elsewhere.
 *
 * When adding a new built-in tool, add it here — allTools, ToolName,
 * createToolsByName(), and getToolDefinitions() all derive from this registry.
 */
const _toolRegistry = {
	read: (cwd: string) => createReadTool(cwd),
	bash: (cwd: string) => createBashTool(cwd),
	edit: (cwd: string) => createEditTool(cwd),
	write: (cwd: string) => createWriteTool(cwd),
	search: (cwd: string) => createSearchTool(cwd),
	webfetch: (_cwd: string) => createWebfetchTool(),
	websearch: (_cwd: string) => createWebsearchTool(),
	bg: withDefinition((cwd: string) => createBgTool(cwd), bgToolDefinition as unknown as ToolDefinition),
	task: withDefinition((cwd: string) => createTaskTool(cwd), taskToolDefinition as unknown as ToolDefinition),
	lsp_diagnostics: withDefinition(
		(cwd: string) => createLspDiagnosticsTool(cwd),
		lspDiagnosticsDefinition as unknown as ToolDefinition,
	),
	lsp_definition: withDefinition(
		(cwd: string) => createLspDefinitionTool(cwd),
		lspDefinitionDefinition as unknown as ToolDefinition,
	),
	lsp_references: withDefinition(
		(cwd: string) => createLspReferencesTool(cwd),
		lspReferencesDefinition as unknown as ToolDefinition,
	),
};

export type ToolName = keyof typeof _toolRegistry;

export const toolRegistry: Record<ToolName, (cwd: string) => Tool> = _toolRegistry;

/**
 * Collect all ToolDefinitions from the registry (tools with UI rendering).
 * Used by createAgentSession() as the default customTools for the main agent's
 * interactive TUI. Includes standalone definitions (e.g. ask_user_question)
 * that have no factory in the registry.
 *
 * This is the single source of truth — no hardcoded lists elsewhere.
 */
export function getToolDefinitions(): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	for (const factory of Object.values(_toolRegistry) as ToolFactory[]) {
		if (factory.definition) defs.push(factory.definition);
	}
	// ask_user_question has no factory (needs ExtensionContext for UI),
	// but its ToolDefinition must be available to the main agent.
	defs.push(askQuestionTool as unknown as ToolDefinition);
	return defs;
}

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
		createSearchTool(cwd),
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
		bg: createBgTool(cwd),
		task: createTaskTool(cwd),
		lsp_diagnostics: createLspDiagnosticsTool(cwd),
		lsp_definition: createLspDefinitionTool(cwd),
		lsp_references: createLspReferencesTool(cwd),
	};
}
