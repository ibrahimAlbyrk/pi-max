/**
 * Checklist Parser — Parse standard Markdown checklists
 *
 * Handles:
 *   - [ ] Unchecked item        → todo
 *   - [x] Checked item          → done
 *   - [X] Checked item          → done
 *   * [ ] Asterisk variant      → todo
 *
 * Groups items under heading sections as tags.
 * Supports nested lists as parent-child relationships.
 */

import type { ParsedTask } from "./parser.js";

export function parseChecklist(content: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	let currentGroup: string | null = null;
	let lastTopLevelTitle: string | null = null;

	for (const line of content.split("\n")) {
		// Detect headings → use as tags
		const headingMatch = line.match(/^#{1,3}\s+(.+)/);
		if (headingMatch) {
			currentGroup = headingMatch[1].trim();
			continue;
		}

		// Detect checklist items: - [ ] or * [ ] or - [x]
		const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)/);
		if (taskMatch) {
			const indent = taskMatch[1].length;
			const checked = taskMatch[2] !== " ";
			const rawTitle = taskMatch[3].trim();

			// Extract optional priority hint: [high], [critical] etc.
			const priorityMatch = rawTitle.match(/\[(critical|high|medium|low)\]/i);
			const priority = priorityMatch
				? (priorityMatch[1].toLowerCase() as ParsedTask["priority"])
				: undefined;
			const title = rawTitle
				.replace(/\[(critical|high|medium|low)\]/i, "")
				.trim();

			const tags: string[] = [];
			if (currentGroup) tags.push(currentGroup.toLowerCase());

			const parsed: ParsedTask = {
				title,
				status: checked ? "done" : "todo",
				priority,
				tags: tags.length > 0 ? tags : undefined,
			};

			// Nested items (indented) → child of last top-level item
			if (indent >= 2 && lastTopLevelTitle) {
				parsed.parentTitle = lastTopLevelTitle;
			} else {
				lastTopLevelTitle = title;
			}

			tasks.push(parsed);
			continue;
		}

		// Also accept plain list items without checkboxes as todo
		const plainMatch = line.match(/^(\s*)[-*]\s+(?!\[)(.+)/);
		if (plainMatch && plainMatch[2].trim().length > 3) {
			const indent = plainMatch[1].length;
			const title = plainMatch[2].trim();

			// Skip lines that look like metadata (starts with **)
			if (title.startsWith("**")) continue;

			const tags: string[] = [];
			if (currentGroup) tags.push(currentGroup.toLowerCase());

			const parsed: ParsedTask = {
				title,
				status: "todo",
				tags: tags.length > 0 ? tags : undefined,
			};

			if (indent >= 2 && lastTopLevelTitle) {
				parsed.parentTitle = lastTopLevelTitle;
			} else {
				lastTopLevelTitle = title;
			}

			tasks.push(parsed);
		}
	}

	return tasks;
}
