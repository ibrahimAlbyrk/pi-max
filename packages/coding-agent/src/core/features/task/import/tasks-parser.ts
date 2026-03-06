/**
 * Tasks Format Parser — Parse our own full export format
 *
 * Parses headings like:
 *   ## #5 Initialize repo [medium] — done ✓
 *   ### #10 Setup GitHub Actions [low] — todo
 *
 * And metadata lines like:
 *   - **Depends on:** #5, #6
 *   - **Tags:** `backend`, `auth`
 *   - **Assignee:** agent
 *   - **Estimated:** 1h 30m
 *
 * Migrated from .pi/extensions/task-management/import/tasks-parser.ts
 */

import type { TaskPriority, TaskStatus } from "../types.js";
import type { ParsedTask } from "./parser.js";

// Status aliases from export format
const STATUS_MAP: Record<string, TaskStatus> = {
	done: "done",
	"done ✓": "done",
	todo: "todo",
	"in progress": "in_progress",
	in_progress: "in_progress",
	blocked: "blocked",
	"in review": "in_review",
	in_review: "in_review",
	deferred: "deferred",
};

export function parseTasksFormat(content: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	let current: ParsedTask | null = null;
	const levelParent: Map<number, string> = new Map();
	let inNotes = false;

	for (const line of content.split("\n")) {
		// Task heading: ## #5 Initialize repo [medium] — done ✓
		const headingMatch = line.match(/^(#{2,6})\s+#\d+\s+(.+?)\s+\[(critical|high|medium|low)\]\s+—\s+(.+)/);
		if (headingMatch) {
			// Save previous task
			if (current) tasks.push(current);

			const level = headingMatch[1].length;
			const title = headingMatch[2].trim();
			const priority = headingMatch[3] as TaskPriority;
			const statusRaw = headingMatch[4]
				.trim()
				.toLowerCase()
				.replace(/\s*[✓⏳○⊘◉◌]\s*$/, "")
				.trim();
			const status = STATUS_MAP[statusRaw] ?? "todo";

			current = { title, status, priority };
			inNotes = false;

			// Parent resolution by heading nesting
			if (level > 2) {
				const parentTitle = levelParent.get(level - 1);
				if (parentTitle) current.parentTitle = parentTitle;
			}
			levelParent.set(level, title);

			continue;
		}

		if (!current) continue;

		// Depends on:
		const depMatch = line.match(/^\s*-\s+\*\*Depends on:\*\*\s+(.+)/);
		if (depMatch) {
			const titles = depMatch[1].split(",").map((s: string) => s.trim().replace(/^#\d+\s*/, ""));
			current.dependsOnTitles = titles.filter((t: string) => t.length > 0);
			continue;
		}

		// Tags:
		const tagMatch = line.match(/^\s*-\s+\*\*Tags:\*\*\s+(.+)/);
		if (tagMatch) {
			current.tags = tagMatch[1]
				.split(",")
				.map((t: string) => t.trim().replace(/^`|`$/g, ""))
				.filter((t: string) => t.length > 0);
			continue;
		}

		// Assignee:
		const assigneeMatch = line.match(/^\s*-\s+\*\*Assignee:\*\*\s+(user|agent)/);
		if (assigneeMatch) {
			current.assignee = assigneeMatch[1] as "user" | "agent";
			continue;
		}

		// Estimated:
		const estimateMatch = line.match(/^\s*-\s+\*\*Estimated:\*\*\s+(.+)/);
		if (estimateMatch) {
			current.estimatedMinutes = parseDuration(estimateMatch[1]);
			continue;
		}

		// Notes section header
		if (/^\*\*Notes:\*\*\s*$/.test(line)) {
			inNotes = true;
			continue;
		}

		if (inNotes) {
			const noteMatch = line.match(/^\s*-\s+\[(\w+)\s+[\d:]+\]\s+(.+)/);
			if (noteMatch) {
				if (current.notes === undefined) current.notes = [];
				current.notes.push(noteMatch[2].trim());
				continue;
			}
			// End of notes if not indented or bullet
			if (!line.startsWith("  ") && !line.startsWith("-")) {
				inNotes = false;
			}
		}

		// Description: non-metadata, non-heading content lines
		if (
			!line.startsWith("-") &&
			!line.startsWith("#") &&
			!line.startsWith(">") &&
			!line.startsWith("---") &&
			line.trim().length > 0
		) {
			if (current.description === undefined) {
				current.description = line.trim();
			} else {
				current.description = `${current.description}\n${line.trim()}`;
			}
		}
	}

	if (current) tasks.push(current);

	return tasks;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Parse duration strings like "1h 30m", "45m", "2h" into total minutes */
function parseDuration(text: string): number | undefined {
	let total = 0;
	const hours = text.match(/(\d+)\s*h/);
	const minutes = text.match(/(\d+)\s*m/);
	if (hours) total += parseInt(hours[1], 10) * 60;
	if (minutes) total += parseInt(minutes[1], 10);
	return total > 0 ? total : undefined;
}
