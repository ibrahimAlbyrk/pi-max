export { askQuestionTool } from "./ask-question.js";
export { bashTool, createBashTool, } from "./bash.js";
export { bgToolDefinition, createBgTool, } from "./bg.js";
export { createEditTool, editTool, } from "./edit.js";
export { createReadTool, readTool, } from "./read.js";
export { createSearchTool, searchTool, } from "./search.js";
export { createTaskTool, taskToolDefinition, } from "./task.js";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine, truncateTail, } from "./truncate.js";
export { createWebfetchTool, webfetchTool, } from "./webfetch.js";
export { createWebsearchTool, websearchTool, } from "./websearch.js";
export { createWriteTool, writeTool, } from "./write.js";
import { bashTool, createBashTool } from "./bash.js";
import { createBgTool } from "./bg.js";
import { createEditTool, editTool } from "./edit.js";
import { createLspDefinitionTool } from "./lsp-definition.js";
import { createLspDiagnosticsTool } from "./lsp-diagnostics.js";
import { createLspReferencesTool } from "./lsp-references.js";
import { createReadTool, readTool } from "./read.js";
import { createSearchTool, searchTool } from "./search.js";
import { createTaskTool } from "./task.js";
import { createWebfetchTool } from "./webfetch.js";
import { createWebsearchTool } from "./websearch.js";
import { createWriteTool, writeTool } from "./write.js";
// Default tools for full access mode (using process.cwd())
export const codingTools = [readTool, bashTool, editTool, writeTool];
// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools = [readTool, searchTool];
/**
 * Single source of truth for all built-in tool factories.
 */
const _toolRegistry = {
    read: (cwd) => createReadTool(cwd),
    bash: (cwd) => createBashTool(cwd),
    edit: (cwd) => createEditTool(cwd),
    write: (cwd) => createWriteTool(cwd),
    search: (cwd) => createSearchTool(cwd),
    webfetch: (_cwd) => createWebfetchTool(),
    websearch: (_cwd) => createWebsearchTool(),
    bg: (cwd) => createBgTool(cwd),
    task: (cwd) => createTaskTool(cwd),
    lsp_diagnostics: (cwd) => createLspDiagnosticsTool(cwd),
    lsp_definition: (cwd) => createLspDefinitionTool(cwd),
    lsp_references: (cwd) => createLspReferencesTool(cwd),
};
export const toolRegistry = _toolRegistry;
// All available tools (using process.cwd()) — derived from toolRegistry
export const allTools = Object.fromEntries(Object.entries(_toolRegistry).map(([name, factory]) => [name, factory(process.cwd())]));
/**
 * Create tools by name for a specific working directory.
 */
export function createToolsByName(names, cwd) {
    return names
        .map((n) => _toolRegistry[n.trim()])
        .filter(Boolean)
        .map((factory) => factory(cwd));
}
/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd, options) {
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
export function createReadOnlyTools(cwd, options) {
    return [createReadTool(cwd, options?.read), createSearchTool(cwd)];
}
/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd, options) {
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
//# sourceMappingURL=index.js.map
