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
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TaskStore, Task } from "../types.js";
import { isGroupContainer } from "../store.js";
import { PRIORITY_COLORS, priorityLabel } from "../rendering/icons.js";
import { truncate, PRIORITY_ORDER } from "../ui/helpers.js";

// ── Agent color helper ──
const ANSI_RESET = "\x1b[0m";

function hexToAnsiFg(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

// ── Agent tag pulse/breathe animation config ──
const PULSE_CYCLE_MS = 2500;      // 2.5s full cycle
const PULSE_DIM = 0.35;           // dim to 65% brightness at lowest
const PULSE_BRIGHT = 0.5;         // brighten 50% towards white at peak

/** Parse hex color string "#RRGGBB" to RGB. */
function parseHexRgb(hex: string): RGB {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return { r: 180, g: 180, b: 180 };
	return { r, g, b };
}

/** Dim a color by scaling RGB values. factor 0–1 (0=black, 1=original). */
function dimColor(c: RGB, factor: number): RGB {
	return { r: c.r * factor, g: c.g * factor, b: c.b * factor };
}

/**
 * Apply soft pulse/breathe effect to the agent tag.
 * Uses a sine wave for smooth dim↔bright oscillation.
 * Creates a dramatic enough range to be clearly visible on dark terminals.
 */
function applyPulse(text: string, hexColor: string): string {
	const baseRgb = parseHexRgb(hexColor);
	const now = Date.now();
	const phase = (now % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
	const t = (Math.sin(phase * Math.PI * 2) + 1) / 2; // 0–1, smooth

	// Interpolate between dimmed color and brightened color
	const dimmed = dimColor(baseRgb, 1 - PULSE_DIM);     // 65% brightness
	const bright = lerpToWhite(baseRgb, PULSE_BRIGHT);    // 50% towards white
	const pulsedColor: RGB = {
		r: dimmed.r + t * (bright.r - dimmed.r),
		g: dimmed.g + t * (bright.g - dimmed.g),
		b: dimmed.b + t * (bright.b - dimmed.b),
	};
	return `${rgbToAnsi(pulsedColor)}${text}${RESET}`;
}

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

// ── Task animation config ──  
const TASK_SLIDE_FRAME_MS = 60; // Faster
const TASK_SLIDE_IN_FRAMES = 5; // 5 × 60ms = 300ms - much faster
const SLIDE_DISTANCE = 12; // characters - shorter distance

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
	const chars = Array.from(text);
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

/**
 * Render agent assignment tag for a task.
 * Returns colored " @AgentName" with pulse/breathe animation if color is available.
 */
function renderAgentTag(task: Task): string {
	if (!task.agentName) return "";
	if (!task.agentColor) return `  @${task.agentName}`;
	return `  ${applyPulse(`@${task.agentName}`, task.agentColor)}`;
}

interface TaskAnimationState {
	type: "slide-in";
	progress: number; // 0-1
	timer: ReturnType<typeof setInterval>;
}

class NextTasksComponent implements Component {
	private shineTimer: ReturnType<typeof setInterval> | null = null;
	private store: TaskStore;
	private collapsed: boolean;
	/** Override max visible tasks (0 = use default MAX_VISIBLE_TASKS) */
	maxVisibleOverride = 0;

	// Transition state (collapse/expand)
	private transitionTimer: ReturnType<typeof setInterval> | null = null;
	private transitionFrame = 0;
	private transitionDirection: "collapsing" | "expanding" | null = null;

	// Task-level animations (add only)
	private taskAnimationStates = new Map<number, TaskAnimationState>();
	private prevTaskIds = new Set<number>();

	constructor(
		private tui: TUI,
		private theme: Theme,
		store: TaskStore,
		collapsed: boolean,
	) {
		this.store = store;
		this.collapsed = collapsed;
		
		// Use global state to preserve task tracking across widget recreations
		this.prevTaskIds = lastKnownTaskIds.size > 0 ? lastKnownTaskIds : this.getCurrentTaskIds(store);
		this.updateAnimationState();
	}

	private getCurrentTaskIds(store: TaskStore): Set<number> {
		return new Set(
			store.tasks
				.filter((t) => !isGroupContainer(store, t.id))
				.map((t) => t.id)
		);
	}

	updateState(store: TaskStore, collapsed: boolean): void {
		const wasCollapsed = this.collapsed;
		const currentTaskIds = this.getCurrentTaskIds(store);

		// Detect only added tasks (removed tasks just disappear instantly)
		const addedTasks = Array.from(currentTaskIds).filter(id => !this.prevTaskIds.has(id));

		this.store = store;
		this.collapsed = collapsed;

		// Trigger transition animation ONLY on collapse state change
		if (wasCollapsed !== collapsed && this.store.tasks.length > 0) {
			this.startTransition(collapsed ? "collapsing" : "expanding");
		}
		
		// Trigger slide-in animation for new tasks only
		if (addedTasks.length > 0) {
			addedTasks.forEach(id => this.startTaskSlideIn(id));
		}

		this.prevTaskIds = currentTaskIds;
		lastKnownTaskIds = new Set(currentTaskIds); // Update global state
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

	private startTaskSlideIn(taskId: number): void {
		this.stopTaskAnimation(taskId);

		const animState: TaskAnimationState = {
			type: "slide-in",
			progress: 0,
			timer: setInterval(() => {
				animState.progress += 1 / TASK_SLIDE_IN_FRAMES;
				if (animState.progress >= 1) {
					animState.progress = 1;
					this.stopTaskAnimation(taskId);
				}
				this.tui.requestRender();
			}, TASK_SLIDE_FRAME_MS)
		};

		this.taskAnimationStates.set(taskId, animState);
	}

	private stopTaskAnimation(taskId: number): void {
		const animState = this.taskAnimationStates.get(taskId);
		if (animState) {
			clearInterval(animState.timer);
			this.taskAnimationStates.delete(taskId);
		}
	}

	private stopAllTaskAnimations(): void {
		for (const [taskId] of Array.from(this.taskAnimationStates)) {
			this.stopTaskAnimation(taskId);
		}
	}

	private renderTaskLineWithAnimation(baseContent: string, taskId: number): string {
		const animState = this.taskAnimationStates.get(taskId);
		if (!animState || animState.type !== "slide-in") return baseContent;

		const th = this.theme;
		
		// Slide from RIGHT to LEFT (sağdan sola gelir)
		const easeOut = 1 - Math.pow(1 - animState.progress, 3);
		
		// Start with spaces on the left, reduce as animation progresses
		const maxOffset = SLIDE_DISTANCE;
		const leftPadding = Math.round(maxOffset * (1 - easeOut));
		const spaces = " ".repeat(Math.max(0, leftPadding));
		
		// Apply opacity dimming during animation
		const dimmed = animState.progress < 0.7 
			? th.fg("dim", stripAnsi(baseContent))
			: baseContent;
		
		return spaces + dimmed;
	}





	private updateAnimationState(): void {
		const hasInProgress = this.store.tasks.some((t) => t.status === "in_progress");
		const hasAgentTag = this.store.tasks.some((t) => t.agentName && t.agentColor);
		if (hasInProgress || hasAgentTag) {
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
		this.stopAllTaskAnimations();
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
		const effectiveMaxTasks = this.maxVisibleOverride > 0 ? this.maxVisibleOverride : MAX_VISIBLE_TASKS;
		
		const totalAvailable = inProgress.length + todo.length + doneAll.length;
		let remaining = effectiveMaxTasks;

		const visibleInProgress = inProgress.slice(0, remaining);
		remaining -= visibleInProgress.length;

		const visibleTodo = todo.slice(0, remaining);
		remaining -= visibleTodo.length;

		const doneLimit = this.maxVisibleOverride > 0 ? remaining : Math.min(remaining, 2);
		const doneTasks = doneAll.slice(0, doneLimit);

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
		// Each entry is { content, agentTag } — agent tag is kept separate
		// so it survives the fade effect (applyFade strips ANSI from content).
		const taskLines: { content: string; agentTag: string }[] = [];

		for (let idx = 0; idx < visibleInProgress.length; idx++) {
			const t = visibleInProgress[idx];
			const icon = th.fg("accent", "▸");
			const id = th.fg("accent", `#${t.id}`);
			const pri = th.fg(PRIORITY_COLORS[t.priority] as any, `${priorityLabel(t.priority)}`);
			const titleText = truncate(t.title, 45);
			const baseAnsi = th.getFgAnsi("accent");
			const shineTitle = applyShine(titleText, baseAnsi, idx);

			const baseContent = `${icon} ${id} ${pri} ${shineTitle}`;
			const animatedContent = this.renderTaskLineWithAnimation(baseContent, t.id);
			if (animatedContent) taskLines.push({ content: animatedContent, agentTag: renderAgentTag(t) });
		}

		for (const t of visibleTodo) {
			const icon = th.fg("dim", "○");
			const id = th.fg("dim", `#${t.id}`);
			const pri = th.fg(PRIORITY_COLORS[t.priority] as any, `${priorityLabel(t.priority)}`);
			const title = th.fg("text", truncate(t.title, 45));

			const baseContent = `${icon} ${id} ${pri} ${title}`;
			const animatedContent = this.renderTaskLineWithAnimation(baseContent, t.id);
			if (animatedContent) taskLines.push({ content: animatedContent, agentTag: renderAgentTag(t) });
		}

		for (const t of doneTasks) {
			const icon = th.fg("success", "✓");
			const id = th.fg("dim", `#${t.id}`);
			const title = th.strikethrough(th.fg("dim", truncate(t.title, 45)));

			const baseContent = `${icon} ${id}   ${title}`;
			const animatedContent = this.renderTaskLineWithAnimation(baseContent, t.id);
			if (animatedContent) taskLines.push({ content: animatedContent, agentTag: renderAgentTag(t) });
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
				taskLines[0].content + taskLines[0].agentTag,
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

		// Apply subtle downward fade: last 3 lines get progressively dimmer
		// Agent tags are appended AFTER fade to preserve their color.
		const fadeCount = 3;
		const fadeStart = Math.max(0, linesToShow.length - fadeCount);
		for (let i = 0; i < linesToShow.length; i++) {
			const { content, agentTag } = linesToShow[i];
			const fadeIndex = i >= fadeStart ? i - fadeStart + 1 : 0;
			const fadedContent = fadeIndex > 0 ? applyFade(content, fadeIndex) : content;
			lines.push(th.fg("borderMuted", "  │ ") + fadedContent + agentTag);
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
let lastKnownTaskIds: Set<number> = new Set();

export function resetNextTasksWidget(): void {
	if (registeredComponent) {
		registeredComponent.dispose();
		registeredComponent = null;
	}
	lastKnownTaskIds.clear(); // Clear global state
}

/** Override max visible tasks for the widget (0 = use default). */
export function setTaskWidgetMaxVisible(max: number): void {
	pendingMaxVisibleOverride = max;
	if (registeredComponent) {
		registeredComponent.maxVisibleOverride = max;
	}
}

let pendingMaxVisibleOverride = 0;

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
			registeredComponent.maxVisibleOverride = pendingMaxVisibleOverride;
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
