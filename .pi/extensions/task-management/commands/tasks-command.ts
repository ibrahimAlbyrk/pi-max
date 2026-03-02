/**
 * /tasks — Interactive task list overlay with box-drawing frame
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TaskStore, Task, TaskStatus, TaskPriority } from "../types.js";
import { STATUS_ICONS, PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";
import { findTask, formatElapsed, isGroupContainer } from "../store.js";
import { showTaskDetailOverlay } from "./task-detail-command.js";
import { PRIORITY_ORDER } from "../ui/helpers.js";

// ─── Overlay Component ──────────────────────────────────────────

interface TaskEntry {
	task: Task;
	depth: number;
}

class TaskListOverlay {
	private entries: TaskEntry[];
	private selectedIndex: number = 0;
	private scrollOffset: number = 0;
	private theme: Theme;
	private onClose: (selectedId: number | null) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], theme: Theme, onClose: (selectedId: number | null) => void, initialSelectedId?: number) {
		this.entries = this.buildHierarchicalList(tasks);
		this.theme = theme;
		this.onClose = onClose;

		if (initialSelectedId !== undefined) {
			const idx = this.entries.findIndex((e) => e.task.id === initialSelectedId);
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

	private buildHierarchicalList(tasks: Task[]): TaskEntry[] {
		const taskSet = new Set(tasks.map((t) => t.id));
		const childrenMap = new Map<number | null, Task[]>();

		for (const t of tasks) {
			// If parent is in the list, group under it; otherwise treat as root
			const parentKey = t.parentId !== null && taskSet.has(t.parentId) ? t.parentId : null;
			const siblings = childrenMap.get(parentKey) || [];
			siblings.push(t);
			childrenMap.set(parentKey, siblings);
		}

		const roots = this.sortByStatusAndPriority(childrenMap.get(null) || []);
		const result: TaskEntry[] = [];

		const addWithChildren = (task: Task, depth: number) => {
			result.push({ task, depth });
			const children = childrenMap.get(task.id);
			if (children) {
				const sorted = this.sortByStatusAndPriority(children);
				for (const child of sorted) {
					addWithChildren(child, depth + 1);
				}
			}
		};

		for (const root of roots) {
			addWithChildren(root, 0);
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
			if (entry) this.onClose(entry.task.id);
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

		// Status summary — count only leaf tasks (exclude group containers)
		const counts: Record<string, number> = {};
		for (const e of this.entries) {
			if (!this.isGroupTask(e.task)) {
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
				const line = this.renderTaskLine(entry.task, isSelected, innerWidth, entry.depth);
				contentLines.push(line);
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

	private renderTaskLine(task: Task, isSelected: boolean, innerWidth: number, depth: number = 0): string {
		const th = this.theme;
		const isGroup = this.isGroupTask(task);

		const icon = STATUS_ICONS[task.status];
		const statusIcon = task.status === "done" ? th.fg("success", icon)
			: task.status === "blocked" ? th.fg("error", icon)
			: task.status === "in_progress" ? th.fg("accent", icon)
			: th.fg("dim", icon);

		const id = th.fg("accent", `#${task.id}`);
		const pri = th.fg(PRIORITY_COLORS[task.priority] as any, `[${priorityLabel(task.priority)}]`);
		const title = task.status === "done" ? th.fg("dim", task.title) : th.fg("text", task.title);

		let extra = "";
		if (isGroup) {
			// Show (done/total) counter for group containers
			const children = this.getChildren(task.id);
			const doneCount = children.filter((c) => c.status === "done").length;
			extra = th.fg("muted", ` ⟳ (${doneCount}/${children.length})`);
		} else if (task.status === "in_progress" && task.startedAt) {
			const elapsed = Date.now() - new Date(task.startedAt).getTime();
			extra = th.fg("dim", ` (${formatElapsed(elapsed)})`);
		} else if (task.status === "done" && task.actualMinutes !== null) {
			extra = th.fg("dim", ` (${task.actualMinutes}m)`);
		}

		const baseIndent = "    ".repeat(depth);
		const selectionIndicator = isSelected ? th.fg("accent", "▸ ") : "  ";
		const connector = depth > 0 ? th.fg("borderMuted", "└ ") : "";
		const raw = `${baseIndent}${selectionIndicator}${connector}${statusIcon} ${id} ${pri} ${title}${extra}`;
		return this.padInner(truncateToWidth(raw, innerWidth), innerWidth);
	}

	/** Check if task is a group container (has children in entries) */
	private isGroupTask(task: Task): boolean {
		return this.entries.some((e) => e.task.parentId === task.id);
	}

	/** Get children of a task from entries */
	private getChildren(taskId: number): Task[] {
		return this.entries.filter((e) => e.task.parentId === taskId).map((e) => e.task);
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
				return new TaskListOverlay(tasks, theme, (id) => done(id), lastSelectedId);
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
