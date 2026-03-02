/**
 * Compact Task Parser — Indented text format for fast bulk creation.
 *
 * ~5x fewer tokens than JSON array. Hierarchy via indentation.
 *
 * Format:
 *   Title [priority] #tag1 #tag2 @assignee ~30m
 *     > Optional description line
 *     Subtask title [priority]
 *       Sub-subtask title
 *
 * Rules:
 *   - Each non-empty line = one task
 *   - 2-space indent increments = parent-child depth
 *   - [critical|high|medium|low] = priority (default: medium)
 *   - #word = tag (multiple allowed)
 *   - @agent | @user = assignee
 *   - ~30m | ~2h = estimated time (m=minutes, h=hours)
 *   - Lines starting with > = description for previous task
 *   - Empty lines are skipped
 *
 * Example:
 *   Auth System [high] #backend
 *     > Handles all authentication flows
 *     Login API [high] @agent ~30m
 *     Register API [high] @agent ~45m
 *     JWT Middleware #security
 *   Database [high]
 *     Connection Pool
 *     Migrations [medium] ~20m
 *
 * Output: Array of task descriptors with parentId using negative batch refs
 * (same format as bulk_create tasks array).
 */

import type { TaskPriority } from "../types.js";

export interface CompactTask {
	title: string;
	description?: string;
	priority?: TaskPriority;
	tags?: string[];
	assignee?: "user" | "agent";
	estimatedMinutes?: number;
	parentId?: number; // Negative batch-internal ref (-1 = first task, -2 = second, etc.)
}

const PRIORITY_RE = /\[(critical|high|medium|low)\]/i;
const TAG_RE = /#(\S+)/g;
const ASSIGNEE_RE = /@(agent|user)\b/i;
const TIME_RE = /~(\d+)(m|h)\b/i;
const DESC_RE = /^\s*>\s?(.*)$/;

/**
 * Parse compact indented text into task descriptors ready for bulk_create.
 */
export function parseCompactTasks(text: string): CompactTask[] {
	const lines = text.split("\n");
	const tasks: CompactTask[] = [];

	// Stack tracks (taskIndex, depth) for hierarchy resolution
	const depthStack: { index: number; depth: number }[] = [];

	for (const rawLine of lines) {
		// Skip empty lines
		if (!rawLine.trim()) continue;

		// Check for description line (> ...)
		if (DESC_RE.test(rawLine) && tasks.length > 0) {
			const match = rawLine.match(DESC_RE);
			if (match) {
				const lastTask = tasks[tasks.length - 1];
				const descLine = match[1].trim();
				lastTask.description = lastTask.description
					? lastTask.description + "\n" + descLine
					: descLine;
			}
			continue;
		}

		// Calculate depth from leading spaces (2 spaces = 1 level)
		const leadingSpaces = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
		const depth = Math.floor(leadingSpaces / 2);

		let content = rawLine.trim();
		if (!content) continue;

		// Extract metadata from the line
		const task: CompactTask = { title: "" };

		// Priority: [high]
		const priMatch = content.match(PRIORITY_RE);
		if (priMatch) {
			task.priority = priMatch[1].toLowerCase() as TaskPriority;
			content = content.replace(PRIORITY_RE, "").trim();
		}

		// Tags: #backend #security
		const tagMatches = [...content.matchAll(TAG_RE)];
		if (tagMatches.length > 0) {
			task.tags = tagMatches.map((m) => m[1]);
			content = content.replace(TAG_RE, "").trim();
		}

		// Assignee: @agent
		const assigneeMatch = content.match(ASSIGNEE_RE);
		if (assigneeMatch) {
			task.assignee = assigneeMatch[1].toLowerCase() as "user" | "agent";
			content = content.replace(ASSIGNEE_RE, "").trim();
		}

		// Time: ~30m or ~2h
		const timeMatch = content.match(TIME_RE);
		if (timeMatch) {
			const value = parseInt(timeMatch[1], 10);
			const unit = timeMatch[2].toLowerCase();
			task.estimatedMinutes = unit === "h" ? value * 60 : value;
			content = content.replace(TIME_RE, "").trim();
		}

		// Remaining content = title (clean up extra spaces)
		task.title = content.replace(/\s+/g, " ").trim();

		if (!task.title) continue;

		// Resolve parent from depth stack
		// Pop stack entries that are at same or deeper level
		while (depthStack.length > 0 && depthStack[depthStack.length - 1].depth >= depth) {
			depthStack.pop();
		}

		if (depthStack.length > 0) {
			// Parent is the top of stack — use negative batch ref (1-indexed)
			const parentIndex = depthStack[depthStack.length - 1].index;
			task.parentId = -(parentIndex + 1); // 0-based → 1-based negative
		}

		const currentIndex = tasks.length;
		tasks.push(task);
		depthStack.push({ index: currentIndex, depth });
	}

	return tasks;
}
