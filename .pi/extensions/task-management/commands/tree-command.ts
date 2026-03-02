/**
 * /tree-tasks — Hierarchical tree view overlay
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskStore, Task } from "../types.js";
import { STATUS_ICONS, PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";

class TreeOverlay {
	private lines: { text: string; taskId: number; depth: number }[] = [];
	private selectedIndex: number = 0;
	private scrollOffset: number = 0;
	private theme: Theme;
	private done: (taskId: number | null) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(store: TaskStore, theme: Theme, done: (taskId: number | null) => void, initialSelectedId?: number) {
		this.theme = theme;
		this.done = done;
		this.buildTree(store);

		// Restore selection to previously viewed task
		if (initialSelectedId !== undefined) {
			const idx = this.lines.findIndex((l) => l.taskId === initialSelectedId);
			if (idx >= 0) {
				this.selectedIndex = idx;
				const maxVisible = 25;
				if (this.selectedIndex >= maxVisible) {
					this.scrollOffset = this.selectedIndex - Math.floor(maxVisible / 2);
				}
			}
		}
	}

	private buildTree(store: TaskStore): void {
		const roots = store.tasks.filter((t) => t.parentId === null);
		for (const root of roots) {
			this.addNode(store, root, "", true, 0);
		}
	}

	private addNode(store: TaskStore, task: Task, prefix: string, isLast: boolean, depth: number): void {
		const th = this.theme;
		const connector = depth === 0 ? "" : isLast ? "└── " : "├── ";
		const icon = STATUS_ICONS[task.status];
		const statusIcon = task.status === "done" ? th.fg("success", icon)
			: task.status === "blocked" ? th.fg("error", icon)
			: task.status === "in_progress" ? th.fg("accent", icon)
			: th.fg("dim", icon);

		const children = store.tasks.filter((t) => t.parentId === task.id);
		const isGroup = children.length > 0;
		const folder = isGroup ? "📁 " : "   ";
		const id = th.fg("accent", `#${task.id}`);
		const pri = th.fg(PRIORITY_COLORS[task.priority] as any, `[${priorityLabel(task.priority)}]`);
		const title = task.status === "done" ? th.fg("dim", task.title) : th.fg("text", task.title);

		// Group containers: show ⟳ prefix and (done/total) counter
		let status: string;
		if (isGroup) {
			const doneCount = children.filter((c) => c.status === "done").length;
			status = th.fg("muted", `⟳ ${task.status} (${doneCount}/${children.length})`);
		} else {
			status = th.fg("dim", task.status);
		}

		const line = `${prefix}${connector}${folder}${statusIcon} ${id} ${pri} ${title}  ${status}`;
		this.lines.push({ text: line, taskId: task.id, depth });

		const childPrefix = prefix + (depth === 0 ? "" : isLast ? "    " : "│   ");
		for (let i = 0; i < children.length; i++) {
			this.addNode(store, children[i], childPrefix === "" ? "   " : childPrefix, i === children.length - 1, depth + 1);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up") && this.selectedIndex > 0) {
			this.selectedIndex--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") && this.selectedIndex < this.lines.length - 1) {
			this.selectedIndex++;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.lines[this.selectedIndex]?.taskId ?? null);
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		const maxVisible = 25;

		out.push("");
		out.push(truncateToWidth(
			th.fg("borderMuted", "───") + th.fg("accent", " Task Tree ") + th.fg("borderMuted", "─".repeat(Math.max(0, width - 16))),
			width,
		));
		out.push("");

		if (this.lines.length === 0) {
			out.push(truncateToWidth(`  ${th.fg("dim", "No tasks")}`, width));
		} else {
			if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
			if (this.selectedIndex >= this.scrollOffset + maxVisible) this.scrollOffset = this.selectedIndex - maxVisible + 1;

			const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + maxVisible);
			for (let i = 0; i < visible.length; i++) {
				const gi = this.scrollOffset + i;
				const prefix = gi === this.selectedIndex ? th.fg("accent", "▸ ") : "  ";
				out.push(truncateToWidth(`${prefix}${visible[i].text}`, width));
			}
		}

		out.push("");
		out.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ Navigate  Enter: Detail  Esc: Close")}`, width));
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function registerTreeCommand(pi: any, getStore: () => TaskStore) {
	pi.registerCommand("tree-tasks", {
		description: "Show tasks in a hierarchical tree view",
		handler: async (_args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();
			if (store.tasks.length === 0) {
				ctx.ui.notify("No tasks", "info");
				return;
			}

			if (!ctx.hasUI) {
				const { renderTreeText } = await import("../hierarchy/tree-ops.js");
				ctx.ui.notify(renderTreeText(store).join("\n"), "info");
				return;
			}

			const { showTaskDetailOverlay } = await import("./task-detail-command.js");
			const { findTask } = await import("../store.js");

			let lastSelectedId: number | undefined;

			while (true) {
				const taskId = await ctx.ui.custom<number | null>(
					(_tui, theme, _kb, done) => new TreeOverlay(store, theme, (id) => done(id), lastSelectedId),
					{ overlay: true },
				);

				if (taskId === null) return;
				lastSelectedId = taskId;

				const task = findTask(store, taskId);
				if (!task) return;

				const dr = await showTaskDetailOverlay(task, store, ctx);
				if (dr === "close") return;
			}
		},
	});
}
