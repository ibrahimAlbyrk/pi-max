/**
 * Next Tasks Widget — Collapsible widget with fade-out effect
 *
 * Features:
 *  - Collapsed: single line showing active/next task
 *  - Expanded: all tasks with downward fade-out effect (progressive dimming)
 *  - Shine animation on in_progress task titles
 *  - Smooth collapse/expand transition animation
 *  - Persistent component: registered once via setWidget, updated via invalidate+requestRender
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TaskStore } from "../types.js";
import { isGroupContainer } from "../store.js";
import { PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";
import { truncate, PRIORITY_ORDER } from "../ui/helpers.js";

// ── Shine animation config (matches subagent-system agent-panel) ──
const SHINE_CYCLE_MS = 2000;
const SHINE_WIDTH = 8;
const SHINE_INTENSITY = 0.55;
const SHINE_ANIM_INTERVAL_MS = 80; // ~12fps — same as agent panel
const RESET = "\x1b[0m";

// ── Fade-out levels (progressive dimming for expanded mode) ──
// Each level applies increasing transparency simulation via ANSI 256 grays
const FADE_LEVELS = [
	"",                       // row 0: full color (no override)
	"\x1b[38;5;250m",        // row 1: slightly dimmed
	"\x1b[38;5;245m",        // row 2: dimmer
	"\x1b[38;5;241m",        // row 3: quite dim
	"\x1b[38;5;237m",        // row 4: very dim
	"\x1b[38;5;235m",        // row 5: almost invisible
];

// ── Task display limit ──
const MAX_VISIBLE_TASKS = 5;

// ── Transition animation config ──
const TRANSITION_FRAME_MS = 35;
const TRANSITION_FRAMES = 6;

// ── Slide-in animation config ──
const SLIDE_FRAME_MS = 30;
const SLIDE_TOTAL_FRAMES = 8; // 8 frames × 30ms = 240ms total

// ── Color math helpers (same as subagent-system/tui/agent-panel.ts) ──

interface RGB { r: number; g: number; b: number }

/** Parse RGB from ANSI "\x1b[38;2;R;G;Bm" string */
function parseAnsiRgb(ansi: string): RGB {
	const m = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
	if (m) return { r: +m[1], g: +m[2], b: +m[3] };
	return { r: 180, g: 180, b: 180 }; // fallback gray
}

function rgbToAnsi(c: RGB): string {
	return `\x1b[38;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`;
}

/** Lerp a color towards white by factor t (0 = original, 1 = white) */
function lerpToWhite(c: RGB, t: number): RGB {
	return {
		r: c.r + (255 - c.r) * t,
		g: c.g + (255 - c.g) * t,
		b: c.b + (255 - c.b) * t,
	};
}

/** Gaussian bell curve centered at `center` with width `sigma`. Returns 0–1. */
function bell(x: number, center: number, sigma: number): number {
	const d = (x - center) / sigma;
	return Math.exp(-0.5 * d * d);
}

/** Smooth ease-in-out for shine sweep position */
function easeInOutCubic(t: number): number {
	return t < 0.5
		? 4 * t * t * t
		: 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Apply shine sweep to text — identical algorithm to agent-panel's renderWithShine.
 * Smooth Gaussian bell curve sweeping left→right with ease-in-out timing.
 */
function applyShine(text: string, baseAnsi: string, taskOffset: number = 0): string {
	const chars = [...text];
	const baseRgb = parseAnsiRgb(baseAnsi);
	const totalWidth = chars.length + SHINE_WIDTH * 2;

	// Time-based phase with per-task offset so multiple in_progress tasks don't shine in sync
	const now = Date.now();
	const phase = ((now + taskOffset * 400) % SHINE_CYCLE_MS) / SHINE_CYCLE_MS;
	const easedPhase = easeInOutCubic(phase);
	const shineCenter = -SHINE_WIDTH + easedPhase * totalWidth;

	let result = "";
	for (let i = 0; i < chars.length; i++) {
		const shineFactor = bell(i, shineCenter, SHINE_WIDTH / 2.5) * SHINE_INTENSITY;
		const charColor = lerpToWhite(baseRgb, shineFactor);
		result += rgbToAnsi(charColor) + chars[i];
	}
	result += RESET;
	return result;
}

/** Apply fade to an already-colored line. Wraps entire line in dim color. */
function applyFade(line: string, fadeIndex: number): string {
	if (fadeIndex <= 0) return line;
	const level = Math.min(fadeIndex, FADE_LEVELS.length - 1);
	return `${FADE_LEVELS[level]}${stripAnsi(line)}${RESET}`;
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

class NextTasksComponent implements Component {
	private shineTimer: ReturnType<typeof setInterval> | null = null;
	private store: TaskStore;
	private collapsed: boolean;

	// Transition state
	private transitionTimer: ReturnType<typeof setInterval> | null = null;
	private transitionFrame = 0;
	private transitionDirection: "collapsing" | "expanding" | null = null;

	// Slide-in state
	private slideTimer: ReturnType<typeof setInterval> | null = null;
	private slideFrame = 0;
	private isSliding = false;
	private prevTaskIds: string = "";

	constructor(
		private tui: TUI,
		private theme: Theme,
		store: TaskStore,
		collapsed: boolean,
	) {
		this.store = store;
		this.collapsed = collapsed;
		this.prevTaskIds = this.getTaskFingerprint(store);
		this.updateAnimationState();
	}

	private getTaskFingerprint(store: TaskStore): string {
		return store.tasks
			.filter((t) => !isGroupContainer(store, t.id))
			.map((t) => `${t.id}:${t.status}`)
			.join(",");
	}

	updateState(store: TaskStore, collapsed: boolean): void {
		const wasCollapsed = this.collapsed;
		const newFingerprint = this.getTaskFingerprint(store);
		const contentChanged = newFingerprint !== this.prevTaskIds;
		this.prevTaskIds = newFingerprint;

		this.store = store;
		this.collapsed = collapsed;

		// Trigger transition animation on collapse state change
		if (wasCollapsed !== collapsed && this.store.tasks.length > 0) {
			this.startTransition(collapsed ? "collapsing" : "expanding");
		}
		// Trigger slide-in when task content changes (not during collapse/expand)
		else if (contentChanged && !this.collapsed && this.store.tasks.length > 0) {
			this.startSlideIn();
		}

		this.updateAnimationState();
		this.tui.requestRender();
	}

	private startTransition(direction: "collapsing" | "expanding"): void {
		this.stopTransition();
		this.transitionDirection = direction;
		this.transitionFrame = 0;

		this.transitionTimer = setInterval(() => {
			this.transitionFrame++;
			if (this.transitionFrame >= TRANSITION_FRAMES) {
				this.stopTransition();
			}
			this.tui.requestRender();
		}, TRANSITION_FRAME_MS);
	}

	private stopTransition(): void {
		if (this.transitionTimer) {
			clearInterval(this.transitionTimer);
			this.transitionTimer = null;
		}
		this.transitionDirection = null;
		this.transitionFrame = 0;
	}

	private startSlideIn(): void {
		this.stopSlideIn();
		this.isSliding = true;
		this.slideFrame = 0;

		this.slideTimer = setInterval(() => {
			this.slideFrame++;
			if (this.slideFrame >= SLIDE_TOTAL_FRAMES) {
				this.stopSlideIn();
			}
			this.tui.requestRender();
		}, SLIDE_FRAME_MS);
	}

	private stopSlideIn(): void {
		if (this.slideTimer) {
			clearInterval(this.slideTimer);
			this.slideTimer = null;
		}
		this.isSliding = false;
		this.slideFrame = 0;
	}

	private updateAnimationState(): void {
		const hasInProgress = this.store.tasks.some((t) => t.status === "in_progress");
		if (hasInProgress) {
			this.startShine();
		} else {
			this.stopShine();
		}
	}

	private startShine(): void {
		if (this.shineTimer) return;
		this.shineTimer = setInterval(() => {
			this.tui.requestRender();
		}, SHINE_ANIM_INTERVAL_MS);
	}

	private stopShine(): void {
		if (this.shineTimer) {
			clearInterval(this.shineTimer);
			this.shineTimer = null;
		}
	}

	dispose(): void {
		this.stopShine();
		this.stopTransition();
		this.stopSlideIn();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const store = this.store;

		// ── Collect leaf tasks ──
		const leafTasks = store.tasks.filter((t) => !isGroupContainer(store, t.id));

		const inProgress = leafTasks
			.filter((t) => t.status === "in_progress")
			.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

		const todo = leafTasks
			.filter((t) => t.status === "todo")
			.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

		const doneAll = leafTasks
			.filter((t) => t.status === "done")
			.sort((a, b) => {
				const aTime = a.completedAt || a.createdAt;
				const bTime = b.completedAt || b.createdAt;
				return bTime.localeCompare(aTime);
			});

		// ── Distribute MAX_VISIBLE_TASKS slots: in_progress → todo → done ──
		const totalAvailable = inProgress.length + todo.length + doneAll.length;
		let remaining = MAX_VISIBLE_TASKS;

		const visibleInProgress = inProgress.slice(0, remaining);
		remaining -= visibleInProgress.length;

		const visibleTodo = todo.slice(0, remaining);
		remaining -= visibleTodo.length;

		const doneTasks = doneAll.slice(0, Math.min(remaining, 2)); // done still max 2 within budget

		const overflowCount = totalAvailable - (visibleInProgress.length + visibleTodo.length + doneTasks.length);

		const hasContent = visibleInProgress.length > 0 || visibleTodo.length > 0 || doneTasks.length > 0;
		if (!hasContent) return [];

		// ── Active Sprint header ──
		const sprintLines: string[] = [];
		const activeSprint = store.activeSprintId !== null
			? store.sprints.find((s) => s.id === store.activeSprintId)
			: null;

		if (activeSprint && !this.collapsed) {
			const sprintTasks = store.tasks.filter((t) => t.sprintId === activeSprint.id && !isGroupContainer(store, t.id));
			const done = sprintTasks.filter((t) => t.status === "done").length;
			const total = sprintTasks.length;
			const pct = total > 0 ? Math.round((done / total) * 100) : 0;

			const barLen = 20;
			const filled = Math.round((done / Math.max(total, 1)) * barLen);
			const bar =
				th.fg("success", "━".repeat(filled)) +
				th.fg("borderMuted", "━".repeat(barLen - filled));

			const startedStr = activeSprint.startDate ? fmtDate(activeSprint.startDate) : "—";

			sprintLines.push(
				th.fg("borderMuted", "  ┌─") +
				th.fg("muted", " ") +
				th.bold(th.fg("accent", `⚡ ${activeSprint.name}`)) +
				th.fg("muted", " ") +
				th.fg("borderMuted", "─"),
			);
			sprintLines.push(
				th.fg("borderMuted", "  │ ") +
				th.fg("dim", "progress ") +
				bar +
				th.fg("text", ` ${done}`) +
				th.fg("dim", `/${total}`) +
				th.fg("muted", ` · ${pct}%`) +
				th.fg("dim", `  started ${startedStr}`),
			);
			sprintLines.push(th.fg("borderMuted", "  └─"));
		}

		// ── Build task lines ──
		const taskLines: string[] = [];

		for (let idx = 0; idx < visibleInProgress.length; idx++) {
			const t = visibleInProgress[idx];
			const icon = th.fg("accent", "▸");
			const id = th.fg("accent", `#${t.id}`);
			const pri = th.fg(PRIORITY_COLORS[t.priority] as any, `${priorityLabel(t.priority)}`);
			const titleText = truncate(t.title, 45);
			const baseAnsi = th.getFgAnsi("accent");
			const shineTitle = applyShine(titleText, baseAnsi, idx);

			taskLines.push(`${icon} ${id} ${pri} ${shineTitle}`);
		}

		for (const t of visibleTodo) {
			const icon = th.fg("dim", "○");
			const id = th.fg("dim", `#${t.id}`);
			const pri = th.fg(PRIORITY_COLORS[t.priority] as any, `${priorityLabel(t.priority)}`);
			const title = th.fg("text", truncate(t.title, 45));

			taskLines.push(`${icon} ${id} ${pri} ${title}`);
		}

		for (const t of doneTasks) {
			const icon = th.fg("success", "✓");
			const id = th.fg("dim", `#${t.id}`);
			const title = th.strikethrough(th.fg("dim", truncate(t.title, 45)));

			taskLines.push(`${icon} ${id}   ${title}`);
		}

		if (taskLines.length === 0) return [];

		// ── Overflow indicator ──
		const overflowLine = overflowCount > 0
			? th.fg("dim", `… +${overflowCount} more`)
			: null;

		// ── Determine how many lines to show based on mode + transition ──
		const isTransitioning = this.transitionDirection !== null;

		if (this.collapsed && !isTransitioning) {
			// Collapsed: single line — first task only (active or next)
			const collapseIndicator = th.fg("dim", `[${leafTasks.length} tasks] `);
			const lines: string[] = [];
			lines.push(
				th.fg("borderMuted", "  ── ") +
				collapseIndicator +
				taskLines[0],
			);
			return lines;
		}

		// ── Expanded or transitioning: build full output with fade ──
		const lines: string[] = [...sprintLines];
		if (sprintLines.length > 0) lines.push("");

		const totalTasks = leafTasks.length;
		const doneCount = doneTasks.length;
		const headerInfo = th.fg("dim", `${totalTasks} tasks`) +
			(doneCount > 0 ? th.fg("success", ` · ${doneCount} done`) : "");

		lines.push(
			th.fg("borderMuted", "  ┌─") +
			th.fg("muted", " Tasks ") +
			th.fg("borderMuted", "─ ") +
			headerInfo,
		);

		// During transition, calculate visible lines
		let visibleCount = taskLines.length;
		if (isTransitioning) {
			const progress = this.transitionFrame / TRANSITION_FRAMES;
			if (this.transitionDirection === "collapsing") {
				visibleCount = Math.max(1, Math.round(taskLines.length * (1 - progress)));
			} else {
				visibleCount = Math.max(1, Math.round(taskLines.length * progress));
			}
		}

		const linesToShow = taskLines.slice(0, visibleCount);

		// Apply fade effect: first 2 lines full color, then progressive fade
		const FADE_START = 2; // lines before fade begins
		for (let i = 0; i < linesToShow.length; i++) {
			const fadeIndex = Math.max(0, i - FADE_START);

			// During collapsing transition, increase fade intensity
			let effectiveFade = fadeIndex;
			if (this.transitionDirection === "collapsing") {
				const extraFade = Math.round((this.transitionFrame / TRANSITION_FRAMES) * 3);
				effectiveFade = fadeIndex + extraFade;
			}

			// Slide-in: staggered reveal per line (top → bottom)
			if (this.isSliding) {
				const staggerDelay = i * 1.5; // each line delayed by 1.5 frames
				const lineProgress = Math.max(0, Math.min(1, (this.slideFrame - staggerDelay) / (SLIDE_TOTAL_FRAMES * 0.5)));
				if (lineProgress <= 0) continue; // not yet visible
				// Map progress to extra fade (fully dim → no fade)
				const slideFade = Math.round((1 - lineProgress) * (FADE_LEVELS.length - 1));
				effectiveFade = Math.max(effectiveFade, slideFade);
			}

			const line = effectiveFade > 0 ? applyFade(linesToShow[i], effectiveFade) : linesToShow[i];
			lines.push(th.fg("borderMuted", "  │ ") + line);
		}

		if (overflowLine && !isTransitioning) {
			lines.push(th.fg("borderMuted", "  │ ") + overflowLine);
		}

		lines.push(th.fg("borderMuted", "  └─"));

		return lines;
	}
}

// ─── Persistent widget state ─────────────────────────────────────────

let registeredComponent: NextTasksComponent | null = null;

export function resetNextTasksWidget(): void {
	if (registeredComponent) {
		registeredComponent.dispose();
		registeredComponent = null;
	}
}

export function updateNextTasksWidget(store: TaskStore, ctx: ExtensionContext, collapsed: boolean): void {
	if (registeredComponent) {
		registeredComponent.updateState(store, collapsed);
		return;
	}

	// Always register the widget eagerly to secure Map insertion order.
	// The render() method returns [] when there are no relevant tasks,
	// so an empty widget is invisible. This guarantees task widget is
	// always positioned ABOVE the subagent widget in the TUI regardless
	// of which extension triggers first.
	ctx.ui.setWidget(
		"task-next",
		(tui: TUI, theme: Theme) => {
			registeredComponent = new NextTasksComponent(tui, theme, store, collapsed);
			return registeredComponent;
		},
	);
}

function fmtDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
	} catch {
		return iso;
	}
}
