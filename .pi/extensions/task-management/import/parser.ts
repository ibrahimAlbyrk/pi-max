/**
 * Import Parser — Format detection and dispatch
 *
 * Detects whether a Markdown file is:
 *   - "tasks"     — our own full export format
 *   - "checklist" — generic Markdown checklist (- [ ] items)
 *
 * Then dispatches to the appropriate parser.
 */

import type { TaskStatus, TaskPriority } from "../types.js";
import { parseChecklist } from "./checklist-parser.js";
import { parseTasksFormat } from "./tasks-parser.js";

export type ImportFormat = "auto" | "tasks" | "checklist";

export interface ParsedTask {
	title: string;
	description?: string;
	status: TaskStatus;
	priority?: TaskPriority;
	tags?: string[];
	parentTitle?: string;
	dependsOnTitles?: string[];
	assignee?: "user" | "agent";
	estimatedMinutes?: number;
	notes?: string[];
}

/**
 * Auto-detect the format of a Markdown file based on content patterns.
 */
export function detectFormat(content: string): Exclude<ImportFormat, "auto"> {
	// Our own format: has "## #<id>" task headings with [priority] — status
	if (/^#{2,4}\s+#\d+\s+.+\[(?:critical|high|medium|low)\]\s+—\s+/m.test(content)) {
		return "tasks";
	}

	// Default: treat as checklist
	return "checklist";
}

/**
 * Parse a Markdown file into task objects.
 * If format is "auto", detect the format first.
 */
export function parseMarkdownTasks(content: string, format: ImportFormat = "auto"): ParsedTask[] {
	const resolvedFormat = format === "auto" ? detectFormat(content) : format;

	switch (resolvedFormat) {
		case "tasks":
			return parseTasksFormat(content);
		case "checklist":
			return parseChecklist(content);
		default:
			return parseChecklist(content);
	}
}
