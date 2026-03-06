import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { BackgroundProcessManager } from "./manager.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SHINE_INTERVAL = 120; // ms per frame
const SHINE_PAUSE_FRAMES = 12; // pause frames between sweeps
const BADGE_KEY = "bg-count";

// ── BgBadge ───────────────────────────────────────────────────────────────────

/**
 * Animated editor badge that displays the number of running background processes.
 *
 * When processes are active, a "⚙ bg N" badge animates on the editor border
 * with a character-by-character shine sweep. Each frame highlights one
 * character in accent/bold; the rest render in muted. After a full sweep,
 * the animation pauses for SHINE_PAUSE_FRAMES frames before repeating.
 *
 * When the running count drops to 0, the animation stops and the badge clears.
 */
export class BgBadge {
	private timer: ReturnType<typeof setInterval> | null = null;
	private frame: number = 0;
	private lastCount: number = 0;

	constructor(
		private manager: BackgroundProcessManager,
		private setEditorBadge: (key: string, content: string | undefined) => void,
		private theme: Theme,
	) {}

	/**
	 * Subscribe to manager change notifications and render the initial badge state.
	 * Must be called once after construction.
	 */
	start(): void {
		this.manager.onChange(() => this.update());
		this.update();
	}

	private update(): void {
		const count = this.manager.runningCount;

		if (count === 0) {
			this.stopAnimation();
			this.setEditorBadge(BADGE_KEY, undefined);
			return;
		}

		if (count !== this.lastCount) {
			this.lastCount = count;
			this.startAnimation();
		}
	}

	private startAnimation(): void {
		// Guard: don't reset if a timer is already running — the next
		// renderFrame() tick will pick up the updated lastCount automatically.
		if (this.timer) return;
		this.frame = 0;
		this.timer = setInterval(() => this.renderFrame(), SHINE_INTERVAL);
	}

	private stopAnimation(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private renderFrame(): void {
		const text = `⚙ bg ${this.lastCount}`;

		// Sweep index cycles through text.length + SHINE_PAUSE_FRAMES positions.
		// When shinePos >= text.length, no character is highlighted (pause phase).
		const totalFrames = text.length + SHINE_PAUSE_FRAMES;
		const shinePos = this.frame % totalFrames;

		let rendered = "";
		for (let i = 0; i < text.length; i++) {
			if (i === shinePos) {
				// Shine peak — bold accent
				rendered += this.theme.bold(this.theme.fg("accent", text[i]));
			} else {
				// Normal — muted
				rendered += this.theme.fg("muted", text[i]);
			}
		}

		this.setEditorBadge(BADGE_KEY, rendered);
		this.frame++;
	}

	/** Stop animation and clear the badge. */
	dispose(): void {
		this.stopAnimation();
		this.setEditorBadge(BADGE_KEY, undefined);
	}
}
