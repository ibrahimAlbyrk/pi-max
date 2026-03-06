/**
 * /tasks — Interactive task list overlay with box-drawing frame
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TaskStore, Task, TaskGroup, TaskStatus, TaskPriority } from "../types.js";
import { STATUS_ICONS, PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";
import { findTask, findGroup, formatElapsed, getGroupTasks } from "../store.js";
import { showTaskDetailOverlay } from "./task-detail-command.js";
import { PRIORITY_ORDER } from "../ui/helpers.js";

// ─── Overlay Component ──────────────────────────────────────────

type ListEntry =
	| { type: "task"; task: Task; depth: number }
	| { type: "group-header"; group: TaskGroup; doneCount: number; totalCount: number };

class TaskListOverlay {
	private entries: ListEntry[];
	private selectedIndex: number = 0;
	private scrollOffset: number = 0;
	private theme: Theme;
	private onClose: (selectedId: number | null) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], store: TaskStore, theme: Theme, onClose: (selectedId: number | null) => void, initialSelectedId?: number) {
		this.entries = this.buildList(tasks, store);
		this.theme = theme;
		this.onClose = onClose;

		if (initialSelectedId !== undefined) {
			const idx = this.entries.findIndex((e) => e.type === "task" && e.task.id === initialSelectedId);
			if (idx >= 0) {
				this.selectedIndex = idx;
				const maxVisible = 20;
				if (this.selectedIndex >= maxVisible) {
					this.scrollOffset = this.selectedIndex - Math.floor(maxVisible / 2);
				}
			}
		}
	}

	private sortByStatusAndPriority(tasks: Task[]): Task[] {
		const statusOrder: Record<TaskStatus, number> = {
			in_progress: 0, todo: 1, in_review: 2, blocked: 3, deferred: 4, done: 5,
		};
		return [...tasks].sort((a, b) => {
			const sa = statusOrder[a.status] ?? 5;
			const sb = statusOrder[b.status] ?? 5;
			if (sa !== sb) return sa - sb;
			const pa = PRIORITY_ORDER[a.priority] ?? 2;
			const pb = PRIORITY_ORDER[b.priority] ?? 2;
			if (pa !== pb) return pa - pb;
			return a.id - b.id;
		});
	}

	private buildList(tasks: Task[], store: TaskStore): ListEntry[] {
		const result: ListEntry[] = [];

		// Group tasks by groupId
		const grouped = new Map<number | null, Task[]>();
		for (const t of tasks) {
			const key = t.groupId;
			const list = grouped.get(key) || [];
			list.push(t);
			grouped.set(key, list);
		}

		// Show grouped tasks with headers
		const groupIds = Array.from(grouped.keys()).filter((k) => k !== null) as number[];
		for (const gid of groupIds) {
			const group = findGroup(store, gid);
			const groupTasks = grouped.get(gid) || [];
			const sortedTasks = this.sortByStatusAndPriority(groupTasks);
			const doneCount = groupTasks.filter((t) => t.status === "done").length;

			if (group) {
				result.push({
					type: "group-header",
					group,
					doneCount,
					totalCount: groupTasks.length,
				});
			}

			for (const task of sortedTasks) {
				result.push({ type: "task", task, depth: group ? 1 : 0 });
			}
		}

		// Show ungrouped tasks
		const ungrouped = this.sortByStatusAndPriority(grouped.get(null) || []);
		for (const task of ungrouped) {
			result.push({ type: "task", task, depth: 0 });
		}

		return result;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose(null);
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.selectedIndex < this.entries.length - 1) {
				this.selectedIndex++;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, "return")) {
			const entry = this.entries[this.selectedIndex];
			// Only open detail for tasks, not group headers
			if (entry && entry.type === "task") {
				this.onClose(entry.task.id);
			}
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const innerWidth = width - 2; // │ left + │ right
		const maxVisible = 20;

		// ── Build content lines ──
		const contentLines: string[] = [];

		// Status summary — count only tasks, not headers
		const counts: Record<string, number> = {};
		for (const e of this.entries) {
			if (e.type === "task") {
				counts[e.task.status] = (counts[e.task.status] || 0) + 1;
			}
		}
		const countParts = Object.entries(counts).map(([s, c]) =>
			`${c} ${s.replace(/_/g, " ")}`,
		);
		contentLines.push(this.padInner(` ${th.fg("dim", countParts.join(" · "))}`, innerWidth));
		contentLines.push(this.padInner("", innerWidth));

		if (this.entries.length === 0) {
			contentLines.push(this.padInner(` ${th.fg("dim", "No tasks yet. Ask the agent to create some!")}`, innerWidth));
		} else {
			// Adjust scroll
			if (this.selectedIndex < this.scrollOffset) {
				this.scrollOffset = this.selectedIndex;
			}
			if (this.selectedIndex >= this.scrollOffset + maxVisible) {
				this.scrollOffset = this.selectedIndex - maxVisible + 1;
			}

			const visible = this.entries.slice(this.scrollOffset, this.scrollOffset + maxVisible);

			for (let i = 0; i < visible.length; i++) {
				const entry = visible[i];
				const globalIndex = this.scrollOffset + i;
				const isSelected = globalIndex === this.selectedIndex;

				if (entry.type === "group-header") {
					contentLines.push(this.renderGroupHeader(entry, isSelected, innerWidth));
				} else {
					contentLines.push(this.renderTaskLine(entry.task, isSelected, innerWidth, entry.depth));
				}
			}

			if (this.entries.length > maxVisible) {
				const rangeText = `${this.scrollOffset + 1}–${Math.min(this.scrollOffset + maxVisible, this.entries.length)} of ${this.entries.length}`;
				contentLines.push(this.padInner(` ${th.fg("dim", rangeText)}`, innerWidth));
			}
		}

		// ── Assemble framed output ──
		const lines: string[] = [];

		// Top border with title
		const titleLabel = th.fg("accent", th.bold(" Tasks "));
		const titleLabelWidth = visibleWidth(" Tasks ");
		const topRightDash = Math.max(0, innerWidth - 2 - titleLabelWidth);
		lines.push(truncateToWidth(
			th.fg("borderMuted", "┌──") + titleLabel + th.fg("borderMuted", "─".repeat(topRightDash) + "┐"),
			width,
		));

		// Content with borders
		for (const cl of contentLines) {
			lines.push(truncateToWidth(
				th.fg("borderMuted", "│") + cl + th.fg("borderMuted", "│"),
				width,
			));
		}

		// Footer separator
		lines.push(truncateToWidth(
			th.fg("borderMuted", "├" + "─".repeat(innerWidth) + "┤"),
			width,
		));

		// Footer shortcuts
		const shortcuts = [
			{ key: "↑↓", desc: "navigate" },
			{ key: "↵", desc: "detail" },
			{ key: "esc", desc: "close" },
		];
		const shortcutParts = shortcuts.map((s) =>
			th.fg("muted", s.key) + th.fg("dim", `:${s.desc}`),
		);
		const shortcutLine = shortcutParts.join(th.fg("borderMuted", "  "));
		const footerContent = " " + truncateToWidth(shortcutLine, innerWidth - 2) + " ";
		lines.push(truncateToWidth(
			th.fg("borderMuted", "│") + this.padInner(footerContent, innerWidth) + th.fg("borderMuted", "│"),
			width,
		));

		// Bottom border
		lines.push(truncateToWidth(
			th.fg("borderMuted", "└" + "─".repeat(innerWidth) + "┘"),
			width,
		));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderGroupHeader(entry: Extract<ListEntry, { type: "group-header" }>, isSelected: boolean, innerWidth: number): string {
		const th = this.theme;
		const selectionIndicator = isSelected ? th.fg("accent", "▸ ") : "  ";
		const icon = th.fg("accent", "◆");
		const label = th.fg("accent", `G${entry.group.id}`);
		const name = th.fg("text", th.bold(entry.group.name));
		const progress = th.fg("dim", `(${entry.doneCount}/${entry.totalCount} done)`);
		const raw = `${selectionIndicator}${icon} ${label} ${name} ${progress}`;
		return this.padInner(truncateToWidth(raw, innerWidth), innerWidth);
	}

	private renderTaskLine(task: Task, isSelected: boolean, innerWidth: number, depth: number = 0): string {
		const th = this.theme;

		const icon = STATUS_ICONS[task.status];
		const statusIcon = task.status === "done" ? th.fg("success", icon)
			: task.status === "blocked" ? th.fg("error", icon)
			: task.status === "in_progress" ? th.fg("accent", icon)
			: th.fg("dim", icon);

		const id = th.fg("accent", `#${task.id}`);
		const pri = th.fg(PRIORITY_COLORS[task.priority] as any, `[${priorityLabel(task.priority)}]`);
		const title = task.status === "done" ? th.fg("dim", task.title) : th.fg("text", task.title);

		let extra = "";
		if (task.status === "in_progress" && task.startedAt) {
			const elapsed = Date.now() - new Date(task.startedAt).getTime();
			extra = th.fg("dim", ` (${formatElapsed(elapsed)})`);
		} else if (task.status === "done" && task.actualMinutes !== null) {
			extra = th.fg("dim", ` (${task.actualMinutes}m)`);
		}

		const baseIndent = "  ".repeat(depth);
		const selectionIndicator = isSelected ? th.fg("accent", "▸ ") : "  ";
		const raw = `${baseIndent}${selectionIndicator}${statusIcon} ${id} ${pri} ${title}${extra}`;
		return this.padInner(truncateToWidth(raw, innerWidth), innerWidth);
	}

	private padInner(text: string, innerWidth: number): string {
		const visible = visibleWidth(text);
		if (visible > innerWidth) return truncateToWidth(text, innerWidth);
		return text + " ".repeat(innerWidth - visible);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Overlay (exported for shortcut use) ─────────────────────────

export async function showTaskListOverlay(tasks: Task[], ctx: ExtensionContext, store?: TaskStore): Promise<void> {
	let lastSelectedId: number | undefined;

	while (true) {
		const selectedId = await ctx.ui.custom<number | null>(
			(_tui, theme, _kb, done) => {
				return new TaskListOverlay(tasks, store ?? { tasks, groups: [], sprints: [], nextTaskId: 1, nextGroupId: 1, nextSprintId: 1, activeTaskId: null, activeSprintId: null }, theme, (id) => done(id), lastSelectedId);
			},
			{ overlay: true },
		);

		if (selectedId === null || !store) return;

		lastSelectedId = selectedId;

		const task = findTask(store, selectedId);
		if (!task) return;

		const detailResult = await showTaskDetailOverlay(task, store, ctx);
		if (detailResult === "close") return;
	}
}

// ─── Command Registration ────────────────────────────────────────

export function registerTasksCommand(
	pi: any,
	getStore: () => TaskStore,
) {
	pi.registerCommand("tasks", {
		description: "Show all tasks: /tasks [--status X] [--priority Y] [--tag Z]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();

			let tasks = store.tasks;
			if (args?.trim()) {
				const statusMatch = args.match(/--status\s+(\S+)/);
				const priorityMatch = args.match(/--priority\s+(\S+)/);
				const tagMatch = args.match(/--tag\s+(\S+)/);

				if (statusMatch) tasks = tasks.filter((t) => t.status === statusMatch[1]);
				if (priorityMatch) tasks = tasks.filter((t) => t.priority === priorityMatch[1]);
				if (tagMatch) {
					const tag = tagMatch[1].toLowerCase();
					tasks = tasks.filter((t) => t.tags.some((tt) => tt.toLowerCase() === tag));
				}
			}

			if (!ctx.hasUI) {
				if (tasks.length === 0) {
					ctx.ui.notify("No tasks", "info");
					return;
				}
				const lines = tasks.map((t) => `${STATUS_ICONS[t.status]} #${t.id} [${t.priority}] ${t.title} (${t.status})`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await showTaskListOverlay(tasks, ctx, store);
		},
	});
}
