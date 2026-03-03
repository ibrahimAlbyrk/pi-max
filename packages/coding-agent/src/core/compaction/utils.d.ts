/**
 * Shared utilities for compaction and branch summarization.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}
export declare function createFileOps(): FileOperations;
/**
 * Extract file operations from tool calls in an assistant message.
 */
export declare function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void;
/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export declare function computeFileLists(fileOps: FileOperations): {
	readFiles: string[];
	modifiedFiles: string[];
};
/**
 * Format file operations as XML tags for summary.
 */
export declare function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 */
export declare function serializeConversation(messages: Message[]): string;
export declare function getSummarizationSystemPrompt(): string;
//# sourceMappingURL=utils.d.ts.map
