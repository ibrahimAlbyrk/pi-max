import { type Component, type Container, Spacer, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import { CenteredContainer } from "./components/centered-container.js";
import { getLogoHeight, SplashLogo } from "./components/splash-logo.js";
import { theme } from "./theme/theme.js";

/** Max width for the editor in splash mode */
const SPLASH_EDITOR_MAX_WIDTH = 72;

/** Animation frame timing in ms */
const FRAME_MS = 30;

/** Max dissolve level before a logo row is fully gone */
const MAX_DISSOLVE = 5;

/** Traveling light speed (columns per frame) */
const LIGHT_SPEED = 3;

/** Trail characters from head to tail */
const TRAIL_CHARS = ["█", "▓", "▒", "░"];

/**
 * Compute border overlay for the traveling light effect.
 * Two lights start at center of the border and travel outward (left and right).
 * Each light has a fading trail behind it.
 */
function computeBorderOverlay(waveDistance: number, contentWidth: number): Map<number, string> {
	const center = Math.floor(contentWidth / 2);
	const overlay = new Map<number, string>();

	const colors = [
		(s: string) => theme.bold(theme.fg("text", s)),
		(s: string) => theme.fg("text", s),
		(s: string) => theme.fg("muted", s),
		(s: string) => theme.fg("dim", s),
	];

	for (let t = 0; t < TRAIL_CHARS.length; t++) {
		const dist = waveDistance - t;
		if (dist < 0) continue;

		// Right-going light
		const rightPos = center + dist;
		if (rightPos >= 0 && rightPos < contentWidth) {
			overlay.set(rightPos, colors[t](TRAIL_CHARS[t]));
		}

		// Left-going light
		const leftPos = center - dist;
		if (leftPos >= 0 && leftPos < contentWidth && leftPos !== rightPos) {
			overlay.set(leftPos, colors[t](TRAIL_CHARS[t]));
		}
	}

	return overlay;
}

export interface SplashLayoutOptions {
	ui: TUI;
	/** Returns the current editor component (may change after extensions load) */
	getEditor: () => Component;
	editorContainer: Container;
	footerContainer: Container;
	headerContainer: Container;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	version: string;
	modelId: string;
	provider: string;
	thinkingLevel: string;
	hints: string;
	tip: string;
	cwd: string;
	gitBranch: string;
	borderColor: (text: string) => string;
	onTransitionComplete: () => void;
}

/**
 * A simple right-aligned text line component.
 */
class RightAlignedText implements Component {
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.text) return [];
		const vw = visibleWidth(this.text);
		const pad = Math.max(0, width - vw - 2);
		return [" ".repeat(pad) + this.text, ""];
	}
}

/**
 * Tip bar pinned to the bottom of the splash screen.
 * Renders as a centered line with decorative borders.
 *
 * Layout: ──── tip · <message> ────
 */
class TipBar implements Component {
	constructor(
		private tip: string,
		private maxContentWidth: number,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.tip) return [];
		const contentWidth = Math.min(width, this.maxContentWidth);
		const leftPad = Math.max(0, Math.floor((width - contentWidth) / 2));

		const label = "tip";
		const dot = "·";
		const tipText = this.tip;

		// Middle part: " tip · <message> "
		const middleLen = 1 + label.length + 1 + dot.length + 1 + visibleWidth(tipText) + 1;
		const remaining = Math.max(2, contentWidth - middleLen);
		const leftRuleLen = Math.max(1, Math.floor(remaining / 3));
		const rightRuleLen = remaining - leftRuleLen;

		const line =
			theme.fg("dim", "─".repeat(leftRuleLen)) +
			" " +
			theme.bold(theme.fg("muted", label)) +
			" " +
			theme.fg("dim", dot) +
			" " +
			theme.fg("muted", tipText) +
			" " +
			theme.fg("dim", "─".repeat(rightRuleLen));

		return [" ".repeat(leftPad) + line];
	}
}

/**
 * Displays cwd (left) and git branch (right) below the input bar, matching the editor's horizontal position.
 */
class PathInfoText implements Component {
	constructor(
		private path: string,
		private gitBranch: string,
		private maxContentWidth: number,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.path) return [];
		const inset = 1;
		const contentWidth = Math.min(width, this.maxContentWidth) - inset * 2;
		const leftPad = Math.max(0, Math.floor((width - this.maxContentWidth) / 2)) + inset;

		const left = theme.fg("dim", this.path);
		const leftVw = visibleWidth(left);

		if (!this.gitBranch) {
			return [" ".repeat(leftPad) + left];
		}

		const branchLabel = `⎇ ${this.gitBranch}`;
		const right = theme.fg("dim", branchLabel);
		const rightVw = visibleWidth(right);
		const gap = Math.max(1, contentWidth - leftVw - rightVw);

		return [" ".repeat(leftPad) + left + " ".repeat(gap) + right];
	}
}

/**
 * A component that vertically centers its main children, with optional top
 * children pinned to the top and bottom children pinned to the bottom.
 *
 * Centering is calculated against the FULL terminal height so the top/bottom
 * sections do not shift the center. They overlap the padding areas.
 *
 * Layout:
 *   [top children — pinned to top]
 *   [top padding — reduced by top section height]
 *   [main children — centered on full screen]
 *   [bottom padding — reduced by bottom section height]
 *   [bottom children — pinned to bottom]
 */
class VerticallyCenteredContainer implements Component {
	children: Component[] = [];
	bottomChildren: Component[] = [];
	/** Overlay line rendered at absolute bottom — steals from the gap, never moves bottomChildren */
	footerLine: Component | undefined;
	/** Max lines to render from bottomChildren (0 = unlimited) */
	maxBottomLines = 0;

	constructor(private ui: TUI) {}

	addChild(component: Component): void {
		this.children.push(component);
	}

	addBottomChild(component: Component): void {
		this.bottomChildren.push(component);
	}

	setFooter(component: Component): void {
		this.footerLine = component;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
		for (const child of this.bottomChildren) child.invalidate();
		this.footerLine?.invalidate();
	}

	render(width: number): string[] {
		// Render main content
		const contentLines: string[] = [];
		for (const child of this.children) {
			contentLines.push(...child.render(width));
		}

		// Render bottom content (truncated if needed)
		let bottomLines: string[] = [];
		for (const child of this.bottomChildren) {
			bottomLines.push(...child.render(width));
		}
		if (this.maxBottomLines > 0 && bottomLines.length > this.maxBottomLines) {
			bottomLines = bottomLines.slice(0, this.maxBottomLines);
		}

		// Render footer overlay
		const footerLines = this.footerLine ? this.footerLine.render(width) : [];

		const termHeight = this.ui.terminal.rows;
		const contentHeight = contentLines.length;

		// Layout as if footer doesn't exist (bottom children position unchanged)
		const topPad = Math.max(0, Math.floor((termHeight - contentHeight) / 2));
		const bottomPad = Math.max(0, termHeight - topPad - contentHeight - bottomLines.length);

		// Build result without footer first
		const result: string[] = [];
		for (let i = 0; i < topPad; i++) result.push("");
		result.push(...contentLines);
		for (let i = 0; i < bottomPad; i++) result.push("");
		result.push(...bottomLines);

		// Overlay footer at absolute bottom by replacing the last empty line(s)
		if (footerLines.length > 0) {
			for (let fi = footerLines.length - 1; fi >= 0; fi--) {
				for (let ri = result.length - 1; ri >= 0; ri--) {
					if (result[ri] === "") {
						result[ri] = footerLines[fi];
						break;
					}
				}
			}
		}

		return result;
	}
}

/**
 * Manages the splash screen layout state.
 * Shows a centered logo + editor on startup, then transitions to the normal chat layout.
 */
export class SplashLayout {
	private ui: TUI;
	private logo: SplashLogo;
	private centeredEditor: CenteredContainer;
	private splashContainer: VerticallyCenteredContainer;
	private footerContainer: Container;
	private editorContainer: Container;
	private getEditor: () => Component;

	// References for chat layout restoration
	private headerContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private widgetContainerAbove: Container;
	private widgetContainerBelow: Container;

	private onTransitionComplete: () => void;
	private active = false;
	private animating = false;
	private animationTimer: ReturnType<typeof setTimeout> | undefined;
	private animationResolve: (() => void) | undefined;

	constructor(options: SplashLayoutOptions) {
		this.ui = options.ui;
		this.getEditor = options.getEditor;
		this.editorContainer = options.editorContainer;
		this.footerContainer = options.footerContainer;
		this.headerContainer = options.headerContainer;
		this.chatContainer = options.chatContainer;
		this.pendingMessagesContainer = options.pendingMessagesContainer;
		this.statusContainer = options.statusContainer;
		this.widgetContainerAbove = options.widgetContainerAbove;
		this.widgetContainerBelow = options.widgetContainerBelow;
		this.onTransitionComplete = options.onTransitionComplete;

		// Create splash components
		this.logo = new SplashLogo();
		this.logo.setModelInfo(options.modelId, options.provider, options.thinkingLevel);
		this.logo.setHints(options.hints);

		// Wrap editor in centering container with box borders
		this.centeredEditor = new CenteredContainer(this.editorContainer, SPLASH_EDITOR_MAX_WIDTH, {
			verticalBorders: true,
			borderColor: options.borderColor,
		});

		// Build splash container
		this.splashContainer = new VerticallyCenteredContainer(this.ui);
		this.splashContainer.maxBottomLines = 16; // cap: ~10 tasks + header/footer borders + version

		// Main content (centered against full screen)
		this.splashContainer.addChild(this.logo);
		this.splashContainer.addChild(new Spacer(1));
		this.splashContainer.addChild(this.centeredEditor);
		this.splashContainer.addChild(new PathInfoText(options.cwd, options.gitBranch, SPLASH_EDITOR_MAX_WIDTH));

		// Bottom section (pinned to bottom): task widget + version + spacer
		this.splashContainer.addBottomChild(this.widgetContainerAbove);
		this.splashContainer.addBottomChild(new RightAlignedText(theme.fg("dim", `v${options.version}`)));
		this.splashContainer.addBottomChild(new Spacer(0));

		// Footer overlay (absolute bottom, does not displace bottom children)
		if (options.tip) {
			this.splashContainer.setFooter(new TipBar(options.tip, SPLASH_EDITOR_MAX_WIDTH));
		}
	}

	/**
	 * Update the model info displayed on the splash logo.
	 */
	updateModelInfo(modelId: string, provider: string, thinkingLevel: string): void {
		this.logo.setModelInfo(modelId, provider, thinkingLevel);
	}

	/**
	 * Show the splash screen by registering the splash region.
	 */
	show(): void {
		this.active = true;

		this.ui.addRegion({
			id: "splash",
			components: [this.splashContainer],
			sizing: "flex",
			scrollable: false,
			minHeight: 3,
		});
	}

	/**
	 * Whether the splash screen is currently active.
	 */
	isActive(): boolean {
		return this.active;
	}

	/**
	 * Update the border color of the centered editor container.
	 * Used to sync vertical borders with thinking level changes.
	 */
	setBorderColor(borderColor: (text: string) => string): void {
		this.centeredEditor.setBorderColor(borderColor);
	}

	/**
	 * Whether an animation is in progress.
	 */
	isAnimating(): boolean {
		return this.animating;
	}

	/**
	 * Transition from splash to chat layout with traveling light + shockwave animation.
	 * Returns a promise that resolves when the animation completes and the chat layout is ready.
	 *
	 * Sequence:
	 *   Phase 1: Two lights emerge from center of input bar borders, travel to edges
	 *   Phase 2: Logo dissolves bottom-to-top with character density fade
	 */
	transitionToChat(): Promise<void> {
		if (!this.active || this.animating) return Promise.resolve();

		return new Promise<void>((resolve) => {
			this.animationResolve = resolve;
			this.animating = true;

			const termWidth = this.ui.terminal.columns;
			const contentWidth = Math.min(termWidth - 2, Math.max(1, SPLASH_EDITOR_MAX_WIDTH - 2));
			const center = Math.floor(contentWidth / 2);
			const maxDistance = center + TRAIL_CHARS.length;
			const logoRows = getLogoHeight();

			let phase: "light" | "dissolve" = "light";
			let waveDistance = 0;
			let dissolveFrame = 0;

			const nextFrame = () => {
				if (phase === "light") {
					waveDistance += LIGHT_SPEED;

					const overlay = computeBorderOverlay(waveDistance, contentWidth);
					this.centeredEditor.setBorderOverlay(overlay.size > 0 ? overlay : undefined);
					this.ui.requestRender();

					if (waveDistance >= maxDistance) {
						// Light phase complete
						phase = "dissolve";
						this.centeredEditor.setBorderOverlay(undefined);
					}

					this.animationTimer = setTimeout(nextFrame, FRAME_MS);
				} else {
					dissolveFrame++;

					if (dissolveFrame === 1) {
						// Info text dims
						this.logo.setInfoDissolve(1);
					} else if (dissolveFrame === 2) {
						// Info hidden, start logo wave
						this.logo.setInfoDissolve(2);
						this.logo.setRowDissolve(logoRows - 1, 1);
					} else {
						// Shockwave propagates upward
						const wf = dissolveFrame - 2;
						let allDone = true;

						for (let row = logoRows - 1; row >= 0; row--) {
							const rowAge = wf - (logoRows - 1 - row);
							if (rowAge > 0) {
								const level = Math.min(rowAge, MAX_DISSOLVE);
								this.logo.setRowDissolve(row, level);
								if (level < MAX_DISSOLVE) allDone = false;
							} else {
								allDone = false;
							}
						}

						if (allDone) {
							this.logo.setHidden(true);
							this.finishTransition();
							this.animationResolve = undefined;
							resolve();
							return;
						}
					}

					this.ui.requestRender();
					this.animationTimer = setTimeout(nextFrame, FRAME_MS);
				}
			};

			this.animationTimer = setTimeout(nextFrame, FRAME_MS);
		});
	}

	/**
	 * Instantly transition to chat layout (skip animation).
	 * Used when animation needs to be cancelled (e.g., user types during animation).
	 */
	instantTransition(): void {
		if (!this.active) return;

		if (this.animationTimer) {
			clearTimeout(this.animationTimer);
			this.animationTimer = undefined;
		}

		this.logo.setHidden(true);
		this.finishTransition();

		if (this.animationResolve) {
			this.animationResolve();
			this.animationResolve = undefined;
		}
	}

	/**
	 * Complete the transition: remove splash region, add chat + input regions.
	 */
	private finishTransition(): void {
		this.animating = false;
		this.animationTimer = undefined;
		this.active = false;

		// Remove splash region
		this.ui.removeRegion("splash");

		// Add chat region (flex, scrollable)
		this.ui.addRegion({
			id: "chat",
			components: [this.headerContainer, this.chatContainer, this.pendingMessagesContainer, this.statusContainer],
			sizing: "flex",
			scrollable: true,
			minHeight: 3,
		});

		// Add input region (fixed bottom)
		this.ui.addRegion({
			id: "input",
			components: [this.widgetContainerAbove, this.editorContainer, this.widgetContainerBelow, this.footerContainer],
			sizing: "fixed",
		});

		// Force full redraw
		this.ui.requestRender(true);

		// Restore focus to editor
		this.ui.setFocus(this.getEditor());

		this.onTransitionComplete();
	}

	/**
	 * Clean up resources.
	 */
	dispose(): void {
		if (this.animationTimer) {
			clearTimeout(this.animationTimer);
			this.animationTimer = undefined;
		}
	}
}
