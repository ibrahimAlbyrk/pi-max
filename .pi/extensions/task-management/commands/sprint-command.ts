/**
 * /sprint — Sprint dashboard and management
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TaskStore, Sprint } from "../types.js";
import { formatElapsed } from "../store.js";

class SprintDashboard {
	private sprint: Sprint;
	private store: TaskStore;
	private theme: Theme;
	private done: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(sprint: Sprint, store: TaskStore, theme: Theme, done: () => void) {
		this.sprint = sprint;
		this.store = store;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace")) {
			this.done();
		}
	}

	private padInner(text: string, innerWidth: number): string {
		const visible = visibleWidth(text);
		if (visible > innerWidth) return truncateToWidth(text, innerWidth);
		return text + " ".repeat(innerWidth - visible);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const s = this.sprint;
		const innerWidth = width - 2; // │ left + │ right
		const tasks = this.store.tasks.filter((t) => t.sprintId === s.id);
		const done = tasks.filter((t) => t.status === "done").length;
		const inProgress = tasks.filter((t) => t.status === "in_progress").length;
		const todo = tasks.filter((t) => t.status === "todo").length;
		const blocked = tasks.filter((t) => t.status === "blocked").length;
		const total = tasks.length;
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;

		const barLen = 30;
		const filled = Math.round((done / Math.max(total, 1)) * barLen);
		const bar = th.fg("success", "█".repeat(filled)) + th.fg("dim", "░".repeat(barLen - filled));

		const lines: string[] = [];
		const contentLines: string[] = [];

		// ── Top border with title ──
		const titleLabel = th.fg("accent", th.bold(` 🏃 Sprint #S${s.id}: ${s.name} `));
		const titleLabelWidth = visibleWidth(` 🏃 Sprint #S${s.id}: ${s.name} `);
		const topRightDash = Math.max(0, innerWidth - 2 - titleLabelWidth);
		lines.push(truncateToWidth(
			th.fg("borderMuted", "┌──") + titleLabel + th.fg("borderMuted", "─".repeat(topRightDash) + "┐"),
			width,
		));

		// ── Content ──
		contentLines.push(this.padInner("", innerWidth));
		contentLines.push(this.padInner(` ${th.fg("muted", "Status:")}  ${th.fg("accent", s.status)}  ${th.fg("muted", "|  Started:")}  ${th.fg("dim", s.startDate ? fmtDate(s.startDate) : "—")}`, innerWidth));
		contentLines.push(this.padInner(` ${th.fg("muted", "Progress:")} ${bar} ${th.fg("text", `${done}/${total}`)} ${th.fg("dim", `(${pct}%)`)}`, innerWidth));
		contentLines.push(this.padInner("", innerWidth));
		contentLines.push(this.padInner(
			` ${th.fg("success", `✓ Done: ${done}`)}  ${th.fg("accent", `● Progress: ${inProgress}`)}  ${th.fg("dim", `○ Todo: ${todo}`)}  ${th.fg("error", `⊘ Blocked: ${blocked}`)}`,
			innerWidth,
		));

		// Velocity
		const doneTasks = tasks.filter((t) => t.status === "done" && t.actualMinutes !== null);
		if (doneTasks.length > 0) {
			const totalMin = doneTasks.reduce((acc, t) => acc + (t.actualMinutes ?? 0), 0);
			const avgMin = Math.round(totalMin / doneTasks.length);
			contentLines.push(this.padInner("", innerWidth));
			contentLines.push(this.padInner(` ${th.fg("muted", "Avg time/task:")} ${th.fg("text", formatElapsed(avgMin * 60000))}`, innerWidth));
			if (total - done > 0) {
				const etaMin = (total - done) * avgMin;
				contentLines.push(this.padInner(` ${th.fg("muted", "ETA remaining:")} ${th.fg("accent", `~${formatElapsed(etaMin * 60000)}`)}`, innerWidth));
			}
		}

		// Task list
		if (tasks.length > 0) {
			contentLines.push(this.padInner("", innerWidth));
			contentLines.push(this.padInner(` ${th.fg("muted", "Tasks:")}`, innerWidth));
			for (const t of tasks) {
				const icon = t.status === "done" ? th.fg("success", "✓") : t.status === "in_progress" ? th.fg("accent", "●") : t.status === "blocked" ? th.fg("error", "⊘") : th.fg("dim", "○");
				contentLines.push(this.padInner(`   ${icon} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", t.title)}  ${th.fg("dim", t.status)}`, innerWidth));
			}
		}

		contentLines.push(this.padInner("", innerWidth));

		// ── Content lines with side borders ──
		for (const cl of contentLines) {
			lines.push(truncateToWidth(
				th.fg("borderMuted", "│") + cl + th.fg("borderMuted", "│"),
				width,
			));
		}

		// ── Footer separator ──
		lines.push(truncateToWidth(
			th.fg("borderMuted", "├" + "─".repeat(innerWidth) + "┤"),
			width,
		));

		// ── Footer shortcuts ──
		const shortcutLine = th.fg("muted", "esc") + th.fg("dim", "/") + th.fg("muted", "backspace") + th.fg("dim", ":close");
		const footerContent = " " + truncateToWidth(shortcutLine, innerWidth - 2) + " ";
		lines.push(truncateToWidth(
			th.fg("borderMuted", "│") + this.padInner(footerContent, innerWidth) + th.fg("borderMuted", "│"),
			width,
		));

		// ── Bottom border ──
		lines.push(truncateToWidth(
			th.fg("borderMuted", "└" + "─".repeat(innerWidth) + "┘"),
			width,
		));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function fmtDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
	} catch { return iso; }
}

export function registerSprintCommand(pi: any, getStore: () => TaskStore) {
	pi.registerCommand("sprint", {
		description: "Sprint dashboard: /sprint [new <name> | start <id> | complete <id>]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();

			// No args → show active sprint dashboard
			if (!args?.trim()) {
				const active = store.sprints.find((s) => s.status === "active");
				if (!active) {
					ctx.ui.notify("No active sprint. Use /sprint new <name> to create one.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`Sprint #S${active.id}: ${active.name} (${active.status})`, "info");
					return;
				}
				await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
					new SprintDashboard(active, store, theme, () => done()),
					{ overlay: true },
				);
				return;
			}

			ctx.ui.notify("Use the task tool for sprint management: create_sprint, start_sprint, complete_sprint, assign_sprint, sprint_status, list_sprints", "info");
		},
	});

	pi.registerCommand("backlog", {
		description: "Show tasks not assigned to any sprint",
		handler: async (_args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();
			const backlog = store.tasks.filter((t) => t.sprintId === null && t.status !== "done");

			if (backlog.length === 0) {
				ctx.ui.notify("No tasks in backlog", "info");
				return;
			}

			if (!ctx.hasUI) {
				const lines = backlog.map((t) => `○ #${t.id} [${t.priority}] ${t.title} (${t.status})`);
				ctx.ui.notify(`Backlog (${backlog.length}):\n${lines.join("\n")}`, "info");
				return;
			}

			const { showTaskListOverlay } = await import("./tasks-command.js");
			await showTaskListOverlay(backlog, ctx, store);
		},
	});
}
