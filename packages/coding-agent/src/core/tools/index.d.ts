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
export { createWebfetchTool, type WebfetchToolDetails, type WebfetchToolInput, webfetchTool } from "./webfetch.js";
export { createWebsearchTool, type WebsearchToolDetails, type WebsearchToolInput, websearchTool } from "./websearch.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type BashToolOptions } from "./bash.js";
import { type ReadToolOptions } from "./read.js";
/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "search"
	| "webfetch"
	| "websearch"
	| "bg"
	| "task"
	| "lsp_diagnostics"
	| "lsp_definition"
	| "lsp_references";
export declare const toolRegistry: Record<ToolName, (cwd: string) => Tool>;
export declare const codingTools: Tool[];
export declare const readOnlyTools: Tool[];
export declare const allTools: Record<ToolName, Tool>;
export declare function createToolsByName(names: string[], cwd: string): Tool[];
export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
}
/**
 * Create coding tools configured for a specific working directory.
 */
export declare function createCodingTools(cwd: string, options?: ToolsOptions): Tool[];
/**
 * Create read-only tools configured for a specific working directory.
 */
export declare function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[];
/**
 * Create all tools configured for a specific working directory.
 */
export declare function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool>;
//# sourceMappingURL=index.d.ts.map
