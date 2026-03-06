/**
 * ProcessPanel — interactive TUI overlay for managing background processes.
 *
 * Implements the Focusable + Component interfaces from @mariozechner/pi-tui
 * so it can be shown via ctx.ui.custom().
 */

import { type Component, type Focusable, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { ExtensionContext } from "../../extensions/types.js";
import type { BackgroundProcessManager } from "./manager.js";

const LOG_LINES = 5;

// ── Public types ─────────────────────────────────────────────────────────────

export interface ProcessPanelResult {
	action: "stop" | "restart" | "kill" | "stopall" | "killall";
	name?: string;
}

// ── ProcessPanel ─────────────────────────────────────────────────────────────

type PanelDoneCallback = (result: ProcessPanelResult | null) => void;

export class ProcessPanel implements Component, Focusable {
	/** Set by TUI when focus changes. */
	focused = false;

	private selectedIndex = 0;
	private expandedIndex = -1; // -1 = none expanded
	private cachedLines?: string[];
	private cachedWidth?: number;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private manager: BackgroundProcessManager,
		private theme: Theme,
		private done: PanelDoneCallback,
	) {}

	// ── Component interface ────────────────────────────────────────────────

	handleInput(data: string): void {
		// escape / ctrl+c / shift+up → close (or collapse detail view if expanded)
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "shift+up")) {
			if (this.expandedIndex >= 0) {
				this.expandedIndex = -1;
				this.invalidate();
				return;
			}
			this.done(null);
			return;
		}

		const processes = this.manager.list();
		// +1 for the "Stop All" row at the bottom
		const totalItems = processes.length + 1;

		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.selectedIndex < totalItems - 1) {
				this.selectedIndex++;
				this.invalidate();
			}
			return;
		}

		// enter → toggle detail view, or activate "Stop All"
		if (matchesKey(data, "return")) {
			if (this.selectedIndex === processes.length) {
				// "Stop All" row selected
				this.done({ action: "stopall" });
				return;
			}
			// Toggle expanded detail for selected process
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? -1 : this.selectedIndex;
			this.invalidate();
			return;
		}

		// s/S → stop (SIGTERM)
		if (data === "s" || data === "S") {
			const p = processes[this.selectedIndex];
			if (p?.status === "running") {
				this.done({ action: "stop", name: p.name });
			}
			return;
		}

		// k/K → kill & remove from list
		if (data === "k" || data === "K") {
			const p = processes[this.selectedIndex];
			if (p) {
				this.done({ action: "kill", name: p.name });
			}
			return;
		}

		// r/R → restart
		if (data === "r" || data === "R") {
			const p = processes[this.selectedIndex];
			if (p) {
				this.done({ action: "restart", name: p.name });
			}
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const processes = this.manager.list();

		// Clamp selectedIndex in case processes have disappeared since last input
		const maxIndex = Math.max(0, processes.length);
		if (this.selectedIndex > maxIndex) {
			this.selectedIndex = maxIndex;
		}

		const lines: string[] = [];

		// ── Top border with title ──────────────────────────────────────────
		const title = " ⚙ Background Processes ";
		const titleStyled = th.fg("accent", th.bold(title));
		const titleVisWidth = visibleWidth(title);
		// width - 1 (left border char) - titleVisWidth
		const topRightPad = Math.max(0, width - 1 - titleVisWidth);
		lines.push(th.fg("border", "─") + titleStyled + th.fg("border", "─".repeat(topRightPad)));

		if (processes.length === 0) {
			lines.push(`  ${th.fg("dim", "No background processes running.")}`);
			lines.push("");
			lines.push(`  ${th.fg("dim", 'Use bg run "command" to start one.')}`);
		} else {
			// ── Summary line ───────────────────────────────────────────────
			const running = processes.filter((p) => p.status === "running").length;
			const crashed = processes.filter((p) => p.status === "crashed").length;
			let summary = `Running: ${running}`;
			if (crashed > 0) summary += `, ${th.fg("error", `Crashed: ${crashed}`)}`;
			lines.push(`  ${th.fg("dim", summary)}`);
			lines.push("");

			// ── Process list ───────────────────────────────────────────────
			for (let i = 0; i < processes.length; i++) {
				const p = processes[i]!;
				const isSel = i === this.selectedIndex;
				const isExpanded = i === this.expandedIndex;

				const statusIcon =
					p.status === "running"
						? th.fg("success", "▶")
						: p.status === "crashed"
							? th.fg("error", "✗")
							: th.fg("dim", "■");

				const pointer = isSel ? th.fg("accent", "❯") : " ";
				const nameStyled = isSel ? th.fg("accent", th.bold(p.name)) : th.bold(p.name);
				const statusStyled =
					p.status === "running"
						? th.fg("success", p.status)
						: p.status === "crashed"
							? th.fg("error", p.status)
							: th.fg("dim", p.status);
				const uptimeStyled = p.status === "running" ? th.fg("dim", p.uptime) : th.fg("dim", "--");
				const expandArrow = isExpanded ? th.fg("dim", " ▾") : th.fg("dim", " ▸");

				lines.push(`  ${pointer} ${statusIcon} ${nameStyled}    ${statusStyled}  ${uptimeStyled}${expandArrow}`);

				// ── Expanded detail view ───────────────────────────────────
				if (isExpanded) {
					lines.push(`      ${th.fg("dim", "Command:")} ${p.command}`);

					const pidStr = p.status === "running" ? String(p.pid) : th.fg("dim", "--");
					const taskStr = p.linkedTaskId !== undefined ? `  ${th.fg("dim", "Task:")} #${p.linkedTaskId}` : "";
					lines.push(`      ${th.fg("dim", "PID:")} ${pidStr}${taskStr}`);

					const logResult = this.manager.logs(p.name, LOG_LINES);
					if ("lines" in logResult && logResult.lines.length > 0) {
						lines.push(`      ${th.fg("dim", "──logs──")}`);
						for (const logLine of logResult.lines) {
							const trimmed = logLine.trimEnd();
							if (trimmed) {
								lines.push(`      ${th.fg("dim", trimmed)}`);
							}
						}
					} else {
						lines.push(`      ${th.fg("dim", "(no output)")}`);
					}
					lines.push("");
				}
			}

			// ── Stop All option ────────────────────────────────────────────
			lines.push("");
			const stopAllSel = this.selectedIndex === processes.length;
			const stopAllPointer = stopAllSel ? th.fg("error", "❯") : " ";
			const stopAllLabel = stopAllSel ? th.fg("error", th.bold("■ Stop All")) : th.fg("dim", "■ Stop All");
			lines.push(`  ${stopAllPointer} ${stopAllLabel}`);
		}

		// ── Footer / help bar ──────────────────────────────────────────────
		lines.push(th.fg("border", "─".repeat(Math.max(0, width))));
		const helpEntries: string[] = [
			`${th.fg("dim", "↑↓")} ${th.fg("muted", "navigate")}`,
			`${th.fg("dim", "↵")} ${th.fg("muted", "detail")}`,
			`${th.fg("dim", "s")} ${th.fg("muted", "stop")}`,
			`${th.fg("dim", "k")} ${th.fg("muted", "kill")}`,
			`${th.fg("dim", "r")} ${th.fg("muted", "restart")}`,
			`${th.fg("dim", "esc")} ${th.fg("muted", "close")}`,
		];
		lines.push(`  ${helpEntries.join("  ")}`);

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	// ── Auto-refresh ───────────────────────────────────────────────────────

	/**
	 * Start a 1-second refresh timer that invalidates cached render state
	 * and requests a re-render. Used to keep uptime counters up to date.
	 */
	startAutoRefresh(requestRender: () => void): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = setInterval(() => {
			this.invalidate();
			requestRender();
		}, 1000);
	}

	/** Stop the refresh timer. */
	stopAutoRefresh(): void {
		if (this.refreshTimer !== null) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** Release resources (stop timer). Called by the TUI after custom() resolves. */
	dispose(): void {
		this.stopAutoRefresh();
	}
}

// ── showProcessPanel ──────────────────────────────────────────────────────────

/**
 * Show the ProcessPanel overlay and execute the selected action.
 *
 * Returns the result (with action applied to the manager), or null if the
 * user dismissed the panel without selecting an action.
 */
export async function showProcessPanel(
	manager: BackgroundProcessManager,
	ctx: ExtensionContext,
): Promise<ProcessPanelResult | null> {
	const result = await ctx.ui.custom<ProcessPanelResult | null>((tui, theme, _keybindings, done) => {
		const panel = new ProcessPanel(manager, theme, done);
		panel.startAutoRefresh(() => tui.requestRender());
		return panel;
	});

	if (result) {
		switch (result.action) {
			case "stop":
				if (result.name) await manager.stop(result.name);
				break;
			case "kill":
				if (result.name) manager.remove(result.name);
				break;
			case "restart":
				if (result.name) await manager.restart(result.name);
				break;
			case "stopall":
				await manager.stopAll();
				break;
			case "killall":
				for (const proc of manager.list()) {
					manager.remove(proc.name);
				}
				break;
		}
	}

	return result;
}
