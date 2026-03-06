/**
 * Status & Priority icons and color mappings
 */

import type { TaskPriority, TaskStatus } from "../types.js";

export const STATUS_ICONS: Record<TaskStatus, string> = {
	todo: "○",
	in_progress: "●",
	in_review: "◉",
	blocked: "⊘",
	deferred: "◌",
	done: "✓",
};

// Theme color keys used with theme.fg()
export const PRIORITY_COLORS: Record<TaskPriority, string> = {
	critical: "error",
	high: "warning",
	medium: "accent",
	low: "dim",
};

export function priorityLabel(p: TaskPriority): string {
	return p[0].toUpperCase();
}

export function statusLabel(s: TaskStatus): string {
	return s.replace(/_/g, " ");
}
