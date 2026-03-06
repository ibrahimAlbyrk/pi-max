/**
 * /task <id> — Task detail overlay with box-drawing frame
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.js";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../extensions/types.js";
import { PRIORITY_COLORS, STATUS_ICONS, statusLabel } from "../rendering/icons.js";
import { findGroup, findTask, formatElapsed } from "../store.js";
import type { Task, TaskStore } from "../types.js";
import { formatDate, formatTime, wordWrap } from "../ui/helpers.js";

// ─── Overlay Component ──────────────────────────────────────────

class TaskDetailOverlay {
	private task: Task;
	private store: TaskStore;
	private theme: Theme;
	private scrollOffset: number = 0;
	private onDone: (result: "back" | "close") => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(task: Task, store: TaskStore, theme: Theme, onDone: (result: "back" | "close") => void) {
		this.task = task;
		this.store = store;
		this.theme = theme;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onDone("close");
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.onDone("back");
			return;
		}

		// Mouse scroll: SGR format \x1b[<button;col;rowM
		const mouseMatch = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
		if (mouseMatch) {
			const button = parseInt(mouseMatch[1], 10) & ~(4 | 8 | 16);
			if (button === 64 && this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			} else if (button === 65) {
				this.scrollOffset++;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset++;
			this.invalidate();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const t = this.task;

		// Inner content width (inside the box frame)
		const innerWidth = width - 2; // │ left + │ right

		// Build all content lines first (without frame), then frame them
		const contentLines: string[] = [];
		const icon = STATUS_ICONS[t.status];

		// ── Status & Priority ──
		contentLines.push(this.padInner("", innerWidth)); // blank line after border
		const statusColor: Parameters<Theme["fg"]>[0] =
			t.status === "done"
				? "success"
				: t.status === "blocked"
					? "error"
					: t.status === "in_progress"
						? "accent"
						: "dim";
		contentLines.push(
			this.padInner(
				`  ${th.fg("muted", "Status:")}   ${th.fg(statusColor, `${icon} ${statusLabel(t.status)}`)}` +
					`     ${th.fg("muted", "Priority:")} ${th.fg(PRIORITY_COLORS[t.priority] as Parameters<Theme["fg"]>[0], t.priority)}`,
				innerWidth,
			),
		);

		// ── Assignee & Created ──
		contentLines.push(
			this.padInner(
				`  ${th.fg("muted", "Assignee:")} ${th.fg("text", t.assignee ?? "unassigned")}` +
					`     ${th.fg("muted", "Created:")}  ${th.fg("dim", formatDate(t.createdAt))}`,
				innerWidth,
			),
		);

		// ── Tags ──
		if (t.tags.length > 0) {
			contentLines.push(
				this.padInner(`  ${th.fg("muted", "Tags:")}     ${th.fg("accent", t.tags.join(", "))}`, innerWidth),
			);
		}

		// ── Time ──
		if (t.startedAt) {
			let timeLine = `  ${th.fg("muted", "Started:")}  ${th.fg("dim", formatDate(t.startedAt))}`;
			if (t.status === "in_progress") {
				const elapsed = Date.now() - new Date(t.startedAt).getTime();
				timeLine += `  ${th.fg("accent", `Elapsed: ${formatElapsed(elapsed)}`)}`;
			}
			contentLines.push(this.padInner(timeLine, innerWidth));
		}
		if (t.completedAt) {
			contentLines.push(
				this.padInner(
					`  ${th.fg("muted", "Completed:")} ${th.fg("success", formatDate(t.completedAt))}`,
					innerWidth,
				),
			);
		}
		if (t.estimatedMinutes !== null || t.actualMinutes !== null) {
			let line = "  ";
			if (t.estimatedMinutes !== null)
				line += `${th.fg("muted", "Est:")} ${th.fg("dim", `${t.estimatedMinutes}m`)}  `;
			if (t.actualMinutes !== null) line += `${th.fg("muted", "Actual:")} ${th.fg("dim", `${t.actualMinutes}m`)}`;
			contentLines.push(this.padInner(line, innerWidth));
		}

		// ── Group ──
		if (t.groupId !== null) {
			const group = findGroup(this.store, t.groupId);
			contentLines.push(
				this.padInner(
					`  ${th.fg("muted", "Group:")}    ${th.fg("accent", `G${t.groupId}`)} ${th.fg("dim", group?.name ?? "unknown")}`,
					innerWidth,
				),
			);
		}

		// ── Dependencies ──
		if (t.dependsOn.length > 0) {
			contentLines.push(
				this.padInner(
					`  ${th.fg("muted", "Depends:")}  ${t.dependsOn.map((d) => th.fg("accent", `#${d}`)).join(", ")}`,
					innerWidth,
				),
			);
		}

		// ── Description ──
		if (t.description) {
			contentLines.push(this.padInner("", innerWidth));
			contentLines.push(this.sectionSep(innerWidth, th));
			contentLines.push(this.padInner(`  ${th.fg("muted", "Description:")}`, innerWidth));
			const maxLineWidth = innerWidth - 4;
			const descLines = t.description.split("\n");
			for (const dl of descLines) {
				const wrapped = wordWrap(dl, maxLineWidth > 20 ? maxLineWidth : 20);
				for (const wl of wrapped) {
					contentLines.push(this.padInner(`  ${th.fg("text", wl)}`, innerWidth));
				}
			}
		}

		// ── Notes ──
		if (t.notes.length > 0) {
			contentLines.push(this.padInner("", innerWidth));
			contentLines.push(this.sectionSep(innerWidth, th));
			contentLines.push(this.padInner(`  ${th.fg("muted", `Notes (${t.notes.length}):`)}`, innerWidth));
			for (const note of t.notes) {
				const time = formatTime(note.timestamp);
				const prefixText = `    ${th.fg("dim", `[${note.author} ${time}]`)} `;
				const noteMaxWidth = innerWidth - 30;
				const wrapped = wordWrap(note.text, noteMaxWidth > 20 ? noteMaxWidth : 20);
				contentLines.push(this.padInner(`${prefixText}${th.fg("text", wrapped[0] ?? "")}`, innerWidth));
				for (let i = 1; i < wrapped.length; i++) {
					contentLines.push(this.padInner(`      ${th.fg("text", wrapped[i])}`, innerWidth));
				}
			}
		}

		// ── Build framed output ──
		const allLines: string[] = [];

		// Top border with #id + title embedded
		const topLabel = ` ${icon} ${th.fg("accent", th.bold(`#${t.id}`))} ${th.fg("text", truncateToWidth(t.title, Math.max(10, innerWidth - 10)))} `;
		const topLabelWidth = visibleWidth(topLabel);
		const topRightDash = Math.max(0, innerWidth - 1 - topLabelWidth);
		const topBorder = th.fg("borderMuted", "┌─") + topLabel + th.fg("borderMuted", `${"─".repeat(topRightDash)}┐`);
		allLines.push(truncateToWidth(topBorder, width));

		// Content lines with left/right borders
		for (const cl of contentLines) {
			allLines.push(truncateToWidth(th.fg("borderMuted", "│") + cl + th.fg("borderMuted", "│"), width));
		}

		// Footer separator
		allLines.push(truncateToWidth(th.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`), width));

		// Footer shortcuts
		const shortcuts = [
			{ key: "↑↓", desc: "scroll" },
			{ key: "⌫", desc: "back" },
			{ key: "esc", desc: "close" },
		];
		const shortcutParts = shortcuts.map((s) => th.fg("muted", s.key) + th.fg("dim", `:${s.desc}`));
		const shortcutLine = shortcutParts.join(th.fg("borderMuted", "  "));
		const footerContent = ` ${truncateToWidth(shortcutLine, innerWidth - 2)} `;
		const footerPadded = this.padInner(footerContent, innerWidth);
		allLines.push(truncateToWidth(th.fg("borderMuted", "│") + footerPadded + th.fg("borderMuted", "│"), width));

		// Bottom border
		allLines.push(truncateToWidth(th.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`), width));

		// Apply scroll — keep frame top/bottom visible
		const frameTop = 1; // top border
		const frameBottom = 3; // separator + footer + bottom border
		const maxContentVisible = 25;
		const totalContent = contentLines.length;

		// Clamp scroll
		const maxScroll = Math.max(0, totalContent - maxContentVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const visibleContentStart = this.scrollOffset;
		const visibleContentEnd = Math.min(totalContent, visibleContentStart + maxContentVisible);

		// Assemble: top border + visible content + footer
		const result: string[] = [];
		result.push(allLines[0]); // top border

		// Scroll indicator at top if scrolled
		if (this.scrollOffset > 0) {
			const scrollUpMsg = th.fg("dim", `  ↑ ${this.scrollOffset} more above`);
			result.push(
				truncateToWidth(
					th.fg("borderMuted", "│") + this.padInner(scrollUpMsg, innerWidth) + th.fg("borderMuted", "│"),
					width,
				),
			);
		}

		// Visible content (offset by 1 for top border in allLines)
		for (let i = visibleContentStart; i < visibleContentEnd; i++) {
			result.push(allLines[i + frameTop]); // +1 skips top border
		}

		// Scroll indicator at bottom if more content
		const remaining = totalContent - visibleContentEnd;
		if (remaining > 0) {
			const scrollDownMsg = th.fg("dim", `  ↓ ${remaining} more below`);
			result.push(
				truncateToWidth(
					th.fg("borderMuted", "│") + this.padInner(scrollDownMsg, innerWidth) + th.fg("borderMuted", "│"),
					width,
				),
			);
		}

		// Footer (last frameBottom lines of allLines)
		for (let i = allLines.length - frameBottom; i < allLines.length; i++) {
			result.push(allLines[i]);
		}

		this.cachedWidth = width;
		this.cachedLines = result;
		return result;
	}

	/**
	 * Pad/truncate content to exactly innerWidth visible characters.
	 */
	private padInner(text: string, innerWidth: number): string {
		const visible = visibleWidth(text);
		if (visible > innerWidth) {
			return truncateToWidth(text, innerWidth);
		}
		return text + " ".repeat(innerWidth - visible);
	}

	/**
	 * Thin section separator inside the box.
	 */
	private sectionSep(innerWidth: number, th: Theme): string {
		return th.fg("borderMuted", "─".repeat(innerWidth));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Overlay (exported for use by board-command / tasks-command) ──

export async function showTaskDetailOverlay(
	task: Task,
	store: TaskStore,
	ctx: ExtensionCommandContext,
): Promise<"back" | "close"> {
	return (
		(await ctx.ui.custom<"back" | "close">(
			(_tui, theme, _kb, done) => {
				return new TaskDetailOverlay(task, store, theme, (result) => done(result));
			},
			{ overlay: true },
		)) ?? "close"
	);
}

// ─── Command Registration ────────────────────────────────────────

export function registerTaskDetailCommand(pi: ExtensionAPI, getStore: () => TaskStore): void {
	pi.registerCommand("task", {
		description: "View task details: /task <id>",
		handler: async (args, ctx) => {
			const idStr = args?.trim();
			if (!idStr) {
				ctx.ui.notify("Usage: /task <id>", "error");
				return;
			}

			const id = parseInt(idStr.replace("#", ""), 10);
			if (Number.isNaN(id)) {
				ctx.ui.notify(`Invalid task ID: ${idStr}`, "error");
				return;
			}

			const store = getStore();
			const task = findTask(store, id);
			if (!task) {
				ctx.ui.notify(`Task #${id} not found`, "error");
				return;
			}

			if (!ctx.hasUI) {
				// Non-interactive fallback
				const lines: string[] = [
					`#${task.id} — ${task.title}`,
					`Status: ${task.status} | Priority: ${task.priority}`,
					...(task.description ? [`Description: ${task.description}`] : []),
					...(task.tags.length > 0 ? [`Tags: ${task.tags.join(", ")}`] : []),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await showTaskDetailOverlay(task, store, ctx);
		},
	});
}
