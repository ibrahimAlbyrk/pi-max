/**
 * Kanban Board — Full-screen interactive overlay
 *
 * Columns: TODO | IN PROGRESS | IN REVIEW | DONE | BLOCKED
 * Responsive layout based on terminal width.
 * Box-drawing frame, ANSI-safe padding, vertical scroll.
 *
 * Move/priority changes happen IN-PLACE without closing the overlay.
 * Only "detail" and "escape" close the overlay.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TaskStore, Task, TaskStatus, TaskPriority } from "../types.js";
import { STATUS_ICONS, PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";
import { formatElapsed, findTask as findTaskInStore, findGroup } from "../store.js";
import { PRIORITY_ORDER } from "./helpers.js";

// ─── Types ───────────────────────────────────────────────────────

/** Result emitted only when the overlay should CLOSE (detail or escape). */
export type KanbanResult =
	| { type: "detail"; taskId: number }
	| null;

interface KanbanColumn {
	status: TaskStatus;
	label: string;
	tasks: (Task & { depth: number })[];
}

/** Callback for in-place mutations (move/priority). Board stays open. */
export type KanbanMutateCallback = (
	action: { type: "move"; task: Task; oldStatus: TaskStatus; newStatus: TaskStatus }
	     | { type: "priority"; task: Task; oldPriority: TaskPriority; newPriority: TaskPriority },
) => void;

// ─── Column Definitions ──────────────────────────────────────────

const COLUMN_DEFS: { status: TaskStatus; label: string }[] = [
	{ status: "todo", label: "TODO" },
	{ status: "in_progress", label: "PROGRESS" },
	{ status: "in_review", label: "REVIEW" },
	{ status: "done", label: "DONE" },
	{ status: "blocked", label: "BLOCKED" },
];

const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "blocked"];

// ─── Component ───────────────────────────────────────────────────

export class KanbanBoard {
	private columns: KanbanColumn[];
	private store: TaskStore;
	private activeCol: number = 0;
	private activeRow: number = 0;
	private scrollOffset: number = 0;
	private showDone: boolean = true;
	private theme: Theme;
	private tui: { requestRender: () => void };
	private done: (result: KanbanResult) => void;
	private onMutate: KanbanMutateCallback;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: { requestRender: () => void },
		store: TaskStore,
		theme: Theme,
		done: (result: KanbanResult) => void,
		onMutate: KanbanMutateCallback,
		focusTaskId?: number,
	) {
		this.tui = tui;
		this.store = store;
		this.theme = theme;
		this.done = done;
		this.onMutate = onMutate;
		this.columns = this.buildColumns(store);

		if (focusTaskId != null) {
			this.focusOnTask(focusTaskId);
		} else {
			for (let i = 0; i < this.columns.length; i++) {
				if (this.columns[i].tasks.length > 0) {
					this.activeCol = i;
					break;
				}
			}
		}
	}

	private focusOnTask(taskId: number): void {
		for (let c = 0; c < this.columns.length; c++) {
			const row = this.columns[c].tasks.findIndex((t) => t.id === taskId);
			if (row >= 0) {
				this.activeCol = c;
				this.activeRow = row;
				return;
			}
		}
		for (let i = 0; i < this.columns.length; i++) {
			if (this.columns[i].tasks.length > 0) {
				this.activeCol = i;
				this.activeRow = 0;
				return;
			}
		}
	}

	// ─── Data ────────────────────────────────────────────────────

	private buildColumns(store: TaskStore): KanbanColumn[] {
		// Include all tasks, arranged hierarchically
		const allTasks = this.organizeTasksHierarchically(store);
		return COLUMN_DEFS.map((def) => ({
			...def,
			tasks: allTasks
				.filter((t) => {
					if (t.status === "deferred") return def.status === "todo";
					return t.status === def.status;
				})
				.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)),
		}));
	}

	/**
	 * Organize tasks as a flat list with depth=0 (no hierarchy, groups are separate).
	 */
	private organizeTasksHierarchically(store: TaskStore): (Task & { depth: number })[] {
		return store.tasks
			.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2))
			.map((t) => ({ ...t, depth: 0 }));
	}

	/** Rebuild columns from current store state, then focus on a task. */
	private rebuildAndFocus(taskId: number): void {
		this.columns = this.buildColumns(this.store);
		this.focusOnTask(taskId);
		this.invalidate();
	}

	private getVisibleColumns(width: number): KanbanColumn[] {
		let cols = this.showDone ? this.columns : this.columns.filter((c) => c.status !== "done");
		if (width < 60) {
			cols = cols.filter((c) => c.status === "todo" || c.status === "in_progress");
		} else if (width < 80) {
			cols = cols.filter((c) => c.status !== "done" && c.status !== "blocked");
		} else if (width < 120) {
			cols = cols.filter((c) => c.status !== "blocked");
		}
		return cols;
	}

	private getSelectedTask(): (Task & { depth: number }) | null {
		const cols = this.getVisibleColumns(this.cachedWidth ?? 120);
		const col = cols[this.activeCol];
		if (!col || col.tasks.length === 0) return null;
		return col.tasks[this.activeRow] ?? null;
	}

	// ─── Input ───────────────────────────────────────────────────

	handleInput(data: string): void {
		const cols = this.getVisibleColumns(this.cachedWidth ?? 120);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}

		// Mouse scroll: SGR format \x1b[<button;col;rowM
		const mouseMatch = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
		if (mouseMatch) {
			const button = parseInt(mouseMatch[1], 10) & ~(4 | 8 | 16);
			if (button === 64) {
				if (this.activeRow > 0) {
					this.activeRow--;
					if (this.activeRow < this.scrollOffset) {
						this.scrollOffset = this.activeRow;
					}
					this.invalidate();
				}
			} else if (button === 65) {
				const col = cols[this.activeCol];
				if (col && this.activeRow < col.tasks.length - 1) {
					this.activeRow++;
					this.invalidate();
				}
			}
			return;
		}

		// ── Shift+Left/Right = MOVE task to adjacent column ──
		if (matchesKey(data, "shift+left")) {
			this.moveSelectedTask("left", cols);
			return;
		}
		if (matchesKey(data, "shift+right")) {
			this.moveSelectedTask("right", cols);
			return;
		}

		// ── Shift+Up/Down = change priority ──
		if (matchesKey(data, "shift+up")) {
			this.changePriority("up");
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.changePriority("down");
			return;
		}

		// ── Navigation ──
		if (matchesKey(data, "left")) {
			if (this.activeCol > 0) {
				this.activeCol--;
				this.activeRow = Math.min(this.activeRow, Math.max(0, cols[this.activeCol].tasks.length - 1));
				this.scrollOffset = 0;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.activeCol < cols.length - 1) {
				this.activeCol++;
				this.activeRow = Math.min(this.activeRow, Math.max(0, cols[this.activeCol].tasks.length - 1));
				this.scrollOffset = 0;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.activeRow > 0) {
				this.activeRow--;
				if (this.activeRow < this.scrollOffset) {
					this.scrollOffset = this.activeRow;
				}
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			const col = cols[this.activeCol];
			if (col && this.activeRow < col.tasks.length - 1) {
				this.activeRow++;
				this.invalidate();
			}
			return;
		}

		// ── Enter = open detail (closes overlay) ──
		if (matchesKey(data, "return")) {
			const task = this.getSelectedTask();
			if (task) this.done({ type: "detail", taskId: task.id });
			return;
		}

		// ── p = cycle priority (in-place, no flicker) ──
		if (data === "p" || data === "P") {
			this.cyclePriority();
			return;
		}

		// ── Tab = toggle done column ──
		if (matchesKey(data, "tab")) {
			this.showDone = !this.showDone;
			const visCols = this.getVisibleColumns(this.cachedWidth ?? 120);
			if (this.activeCol >= visCols.length) {
				this.activeCol = visCols.length - 1;
			}
			this.activeRow = Math.min(
				this.activeRow,
				Math.max(0, (visCols[this.activeCol]?.tasks.length ?? 1) - 1),
			);
			this.scrollOffset = 0;
			this.invalidate();
			return;
		}
	}

	/**
	 * Move selected task one column left or right — mutates store in-place.
	 */
	private moveSelectedTask(direction: "left" | "right", cols: KanbanColumn[]): void {
		const task = this.getSelectedTask();
		if (!task) return;

		const currentCol = cols[this.activeCol];
		if (!currentCol) return;

		const currentIdx = STATUS_ORDER.indexOf(currentCol.status);
		if (currentIdx < 0) return;

		const targetIdx = direction === "left" ? currentIdx - 1 : currentIdx + 1;
		if (targetIdx < 0 || targetIdx >= STATUS_ORDER.length) return;

		const oldStatus = task.status;
		const newStatus = STATUS_ORDER[targetIdx];

		// Find and mutate the actual task in the store (not the one with depth property)
		const storeTask = this.store.tasks.find(t => t.id === task.id);
		if (!storeTask) return;
		
		storeTask.status = newStatus;

		// Auto-timestamps
		if (newStatus === "in_progress" && !storeTask.startedAt) {
			storeTask.startedAt = new Date().toISOString();
			this.store.activeTaskId = storeTask.id;
		}
		if (newStatus === "done") {
			storeTask.completedAt = new Date().toISOString();
			if (storeTask.startedAt) {
				storeTask.actualMinutes = Math.round(
					(Date.now() - new Date(storeTask.startedAt).getTime()) / 60000,
				);
			}
			if (this.store.activeTaskId === storeTask.id) {
				this.store.activeTaskId = null;
			}
		}

		// Notify for persistence (does NOT close the overlay)
		this.onMutate({ type: "move", task: storeTask, oldStatus, newStatus });

		// Rebuild columns and re-focus the moved task
		this.rebuildAndFocus(task.id);
	}

	/**
	 * Cycle priority of selected task — mutates store in-place.
	 */
	private cyclePriority(): void {
		const task = this.getSelectedTask();
		if (!task) return;

		const priorities: TaskPriority[] = ["critical", "high", "medium", "low"];
		const idx = priorities.indexOf(task.priority);
		const oldPriority = task.priority;
		const newPriority = priorities[(idx + 1) % priorities.length];

		// Find and mutate the actual task in the store
		const storeTask = this.store.tasks.find(t => t.id === task.id);
		if (!storeTask) return;
		
		storeTask.priority = newPriority;

		this.onMutate({ type: "priority", task: storeTask, oldPriority, newPriority });

		// Rebuild (priority sort may change row order) and re-focus
		this.rebuildAndFocus(task.id);
	}

	/**
	 * Raise or lower priority of selected task.
	 * "up" = higher priority (toward critical), "down" = lower (toward low).
	 */
	private changePriority(direction: "up" | "down"): void {
		const task = this.getSelectedTask();
		if (!task) return;

		// Ordered high→low: critical, high, medium, low
		const priorities: TaskPriority[] = ["critical", "high", "medium", "low"];
		const idx = priorities.indexOf(task.priority);

		let targetIdx: number;
		if (direction === "up") {
			targetIdx = idx - 1;
			if (targetIdx < 0) return; // Already critical
		} else {
			targetIdx = idx + 1;
			if (targetIdx >= priorities.length) return; // Already low
		}

		const oldPriority = task.priority;
		const newPriority = priorities[targetIdx];
		
		// Find and mutate the actual task in the store
		const storeTask = this.store.tasks.find(t => t.id === task.id);
		if (!storeTask) return;
		
		storeTask.priority = newPriority;

		this.onMutate({ type: "priority", task: storeTask, oldPriority, newPriority });
		this.rebuildAndFocus(task.id);
	}

	// ─── Rendering ───────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];
		const cols = this.getVisibleColumns(width);
		const colCount = cols.length;

		if (colCount === 0) {
			lines.push(truncateToWidth(th.fg("dim", "  No columns to display."), width));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const innerWidth = width - 2;
		const separators = colCount - 1;
		const colWidth = Math.max(12, Math.floor((innerWidth - separators) / colCount));
		const boardWidth = colWidth * colCount + separators + 2;

		// ── Top border ──
		const topBorder = "┌" + this.buildHorizontalBorder(colCount, colWidth, "┬") + "┐";
		lines.push(truncateToWidth(th.fg("borderMuted", topBorder), width));

		// ── Title row ──
		const titleInner = boardWidth - 2;
		const boardTitle = th.fg("accent", th.bold("📋 Task Board"));
		const totalDone = this.columns.find((c) => c.status === "done")?.tasks.length ?? 0;
		const totalAll = this.columns.reduce((s, c) => s + c.tasks.length, 0);
		const inProgress = this.columns.find((c) => c.status === "in_progress")?.tasks.length ?? 0;
		const blocked = this.columns.find((c) => c.status === "blocked")?.tasks.length ?? 0;

		let summaryParts = th.fg("success", `✓${totalDone}`) + th.fg("dim", "/") + th.fg("text", `${totalAll}`);
		if (inProgress > 0) summaryParts += "  " + th.fg("accent", `●${inProgress}`);
		if (blocked > 0) summaryParts += "  " + th.fg("error", `⊘${blocked}`);

		const titleContent = ` ${boardTitle}  ${summaryParts} `;
		const titlePadded = this.padToWidth(titleContent, titleInner);
		lines.push(truncateToWidth(
			th.fg("borderMuted", "│") + titlePadded + th.fg("borderMuted", "│"),
			width,
		));

		// ── Header separator ──
		const headerSep = "├" + this.buildHorizontalBorder(colCount, colWidth, "┬") + "┤";
		lines.push(truncateToWidth(th.fg("borderMuted", headerSep), width));

		// ── Column headers ──
		let headerLine = th.fg("borderMuted", "│");
		for (let c = 0; c < cols.length; c++) {
			const col = cols[c];
			const isActive = c === this.activeCol;
			const label = `${col.label} (${col.tasks.length})`;
			const padded = this.padCenter(label, colWidth);
			headerLine += isActive
				? th.fg("accent", th.bold(padded))
				: th.fg("muted", padded);
			if (c < cols.length - 1) {
				headerLine += th.fg("borderMuted", "│");
			}
		}
		headerLine += th.fg("borderMuted", "│");
		lines.push(truncateToWidth(headerLine, width));

		// ── Column header bottom ──
		const colHeaderBorder = "├" + this.buildHorizontalBorder(colCount, colWidth, "┼") + "┤";
		lines.push(truncateToWidth(th.fg("borderMuted", colHeaderBorder), width));

		// ── Task rows ──
		const maxRows = Math.max(...cols.map((c) => c.tasks.length), 0);

		// Dynamic maxVisibleRows based on terminal height so footer always stays on screen.
		// Chrome lines: top border(1) + title(1) + headerSep(1) + headers(1) + headerBottom(1)
		//             + bottomBorder(1) + footer(1) + closeBorder(1) + scrollInfo(1) = 9
		const terminalHeight = process.stdout.rows || 24;
		const chromeLines = 9;
		// Each card row = 3 lines + 1 separator = 4 lines (last row has no separator, but budget for it)
		const maxVisibleRows = Math.max(1, Math.floor((terminalHeight - chromeLines) / 4));

		if (this.activeRow >= this.scrollOffset + maxVisibleRows) {
			this.scrollOffset = this.activeRow - maxVisibleRows + 1;
		}
		if (this.activeRow < this.scrollOffset) {
			this.scrollOffset = this.activeRow;
		}
		const visibleStart = this.scrollOffset;
		const visibleEnd = Math.min(maxRows, visibleStart + maxVisibleRows);

		if (maxRows === 0) {
			const emptyMsg = th.fg("dim", "No tasks yet");
			const emptyInner = this.padCenter(emptyMsg, titleInner);
			lines.push(truncateToWidth(
				th.fg("borderMuted", "│") + emptyInner + th.fg("borderMuted", "│"),
				width,
			));
		}

		for (let row = visibleStart; row < visibleEnd; row++) {
			let line1 = th.fg("borderMuted", "│");
			let line2 = th.fg("borderMuted", "│");
			let line3 = th.fg("borderMuted", "│");

			for (let c = 0; c < cols.length; c++) {
				const col = cols[c];
				const task = col.tasks[row];
				const isSelected = c === this.activeCol && row === this.activeRow;

				if (task) {
					const card = this.renderCard(task, colWidth, isSelected);
					line1 += card.l1;
					line2 += card.l2;
					line3 += card.l3;
				} else {
					const empty = " ".repeat(colWidth);
					line1 += empty;
					line2 += empty;
					line3 += empty;
				}

				if (c < cols.length - 1) {
					line1 += th.fg("borderMuted", "│");
					line2 += th.fg("borderMuted", "│");
					line3 += th.fg("borderMuted", "│");
				}
			}

			line1 += th.fg("borderMuted", "│");
			line2 += th.fg("borderMuted", "│");
			line3 += th.fg("borderMuted", "│");

			lines.push(truncateToWidth(line1, width));
			lines.push(truncateToWidth(line2, width));
			lines.push(truncateToWidth(line3, width));

			if (row < visibleEnd - 1) {
				let sepLine = th.fg("borderMuted", "│");
				for (let c = 0; c < cols.length; c++) {
					sepLine += th.fg("borderMuted", "·".repeat(colWidth));
					if (c < cols.length - 1) {
						sepLine += th.fg("borderMuted", "·");
					}
				}
				sepLine += th.fg("borderMuted", "│");
				lines.push(truncateToWidth(sepLine, width));
			}
		}

		if (maxRows > maxVisibleRows) {
			const scrollInfo = ` ↑${visibleStart} ↓${Math.max(0, maxRows - visibleEnd)} of ${maxRows} `;
			const scrollLine = th.fg("borderMuted", "│")
				+ this.padCenter(th.fg("dim", scrollInfo), titleInner)
				+ th.fg("borderMuted", "│");
			lines.push(truncateToWidth(scrollLine, width));
		}

		// ── Bottom border ──
		const bottomBorder = "├" + this.buildHorizontalBorder(colCount, colWidth, "┴") + "┤";
		lines.push(truncateToWidth(th.fg("borderMuted", bottomBorder), width));

		// ── Footer ──
		const shortcuts = [
			{ key: "←→", desc: "navigate" },
			{ key: "↑↓", desc: "select" },
			{ key: "⇧←→", desc: "move" },
			{ key: "⇧↑↓", desc: "priority" },
			{ key: "↵", desc: "detail" },
			{ key: "⇥", desc: "done" },
			{ key: "esc", desc: "close" },
		];
		const shortcutParts = shortcuts.map((s) =>
			th.fg("muted", s.key) + th.fg("dim", `:${s.desc}`),
		);
		const shortcutLine = shortcutParts.join(th.fg("borderMuted", "  "));
		const footerContent = " " + truncateToWidth(shortcutLine, titleInner - 2) + " ";
		const footerPadded = this.padToWidth(footerContent, titleInner);
		lines.push(truncateToWidth(
			th.fg("borderMuted", "│") + footerPadded + th.fg("borderMuted", "│"),
			width,
		));

		const closeBorder = "└" + "─".repeat(titleInner) + "┘";
		lines.push(truncateToWidth(th.fg("borderMuted", closeBorder), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	// ─── Card Rendering ──────────────────────────────────────────

	private renderCard(
		task: Task & { depth: number },
		colWidth: number,
		isSelected: boolean,
	): { l1: string; l2: string; l3: string } {
		const th = this.theme;
		
		// Calculate indentation based on depth (2 spaces per level)
		const indent = "  ".repeat(task.depth);
		const indentWidth = task.depth * 2;
		const contentWidth = colWidth - 1 - indentWidth;

		const prefix = isSelected ? th.fg("accent", "▸") : " ";
		const icon = STATUS_ICONS[task.status];
		const coloredIcon =
			task.status === "done" ? th.fg("success", icon)
			: task.status === "blocked" ? th.fg("error", icon)
			: task.status === "in_progress" ? th.fg("accent", icon)
			: task.status === "in_review" ? th.fg("warning", icon)
			: th.fg("dim", icon);

		const id = th.fg("accent", `#${task.id}`);
		const pri = th.fg(PRIORITY_COLORS[task.priority] as any, `[${priorityLabel(task.priority)}]`);
		const l1Raw = `${coloredIcon} ${id} ${pri}`;
		const l1 = prefix + indent + this.padToWidth(truncateToWidth(l1Raw, contentWidth), contentWidth);

		const titleTruncated = truncateToWidth(task.title, contentWidth);
		const titleColored = isSelected ? th.fg("accent", titleTruncated)
			: task.status === "done" ? th.fg("dim", titleTruncated)
			: th.fg("text", titleTruncated);
		const l2 = " " + indent + this.padToWidth(titleColored, contentWidth);

		let contextText = "";
		if (task.status === "in_progress" && task.startedAt) {
			contextText = `⏱ ${formatElapsed(Date.now() - new Date(task.startedAt).getTime())}`;
		} else if (task.status === "blocked" && task.dependsOn.length > 0) {
			const blockerId = task.dependsOn[0];
			const blocker = findTaskInStore(this.store, blockerId);
			contextText = blocker
				? `⊘ #${blockerId} ${truncateToWidth(blocker.title, Math.max(4, contentWidth - 8), "…")}`
				: `⊘ blocked by #${blockerId}`;
		} else if (task.status === "done" && task.actualMinutes != null && task.actualMinutes > 0) {
			contextText = `✓ ${formatElapsed(task.actualMinutes * 60000)}`;
		} else if (task.tags.length > 0) {
			contextText = task.tags.map((t) => `#${t}`).join(" ");
		} else if (task.assignee) {
			contextText = `@${task.assignee}`;
		}

		// Prepend group label if task belongs to a group
		if (task.groupId !== null) {
			const group = findGroup(this.store, task.groupId);
			if (group) {
				const groupLabel = `G${group.id}`;
				contextText = contextText ? `${groupLabel} · ${contextText}` : groupLabel;
			}
		}

		const l3 = " " + indent + this.padToWidth(th.fg("dim", truncateToWidth(contextText, contentWidth)), contentWidth);

		return { l1, l2, l3 };
	}

	// ─── Layout Helpers ──────────────────────────────────────────

	private buildHorizontalBorder(colCount: number, colWidth: number, junction: string): string {
		const segments: string[] = [];
		for (let i = 0; i < colCount; i++) {
			segments.push("─".repeat(colWidth));
		}
		return segments.join(junction);
	}

	private padToWidth(text: string, width: number): string {
		const visible = visibleWidth(text);
		if (visible > width) return truncateToWidth(text, width);
		return text + " ".repeat(width - visible);
	}

	private padCenter(text: string, width: number): string {
		const visible = visibleWidth(text);
		if (visible >= width) return truncateToWidth(text, width, "…");
		const left = Math.floor((width - visible) / 2);
		const right = width - visible - left;
		return " ".repeat(left) + text + " ".repeat(right);
	}

	// ─── Cache ───────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}
}
