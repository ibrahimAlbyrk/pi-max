import { type Component, type Container, Spacer, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import { CenteredContainer } from "./components/centered-container.js";
import { SplashLogo } from "./components/splash-logo.js";
import { theme } from "./theme/theme.js";

/** Max width for the editor in splash mode */
const SPLASH_EDITOR_MAX_WIDTH = 72;

/** Animation frame timing in ms */
const FRAME_MS = 50;

export interface SplashLayoutOptions {
	ui: TUI;
	editor: Component;
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
 * A component that vertically centers its main children, with optional bottom
 * children pinned to the bottom of the terminal.
 *
 * Centering is calculated against the FULL terminal height so the bottom
 * section does not shift the center. The bottom section overlaps the bottom
 * padding area. Only when the bottom section is taller than the available
 * padding does the center shift upward.
 *
 * Layout:
 *   [top padding]
 *   [main children — centered on full screen]
 *   [bottom padding — reduced by bottom section height]
 *   [bottom children — pinned to bottom]
 */
class VerticallyCenteredContainer implements Component {
	children: Component[] = [];
	bottomChildren: Component[] = [];
	/** Max lines to render from bottomChildren (0 = unlimited) */
	maxBottomLines = 0;

	constructor(private ui: TUI) {}

	addChild(component: Component): void {
		this.children.push(component);
	}

	addBottomChild(component: Component): void {
		this.bottomChildren.push(component);
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
		for (const child of this.bottomChildren) child.invalidate();
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

		const termHeight = this.ui.terminal.rows;
		const contentHeight = contentLines.length;

		// Center against full terminal height (ignoring bottom section)
		const topPad = Math.max(0, Math.floor((termHeight - contentHeight) / 2));
		// Bottom padding = remaining space minus bottom section
		const bottomPad = Math.max(0, termHeight - topPad - contentHeight - bottomLines.length);

		const result: string[] = [];
		for (let i = 0; i < topPad; i++) result.push("");
		result.push(...contentLines);
		for (let i = 0; i < bottomPad; i++) result.push("");
		result.push(...bottomLines);
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
	private editor: Component;

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

	constructor(options: SplashLayoutOptions) {
		this.ui = options.ui;
		this.editor = options.editor;
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
		this.logo.setTip(options.tip);

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

		// Bottom section (pinned to bottom): task widget + version
		this.splashContainer.addBottomChild(this.widgetContainerAbove);
		this.splashContainer.addBottomChild(new RightAlignedText(theme.fg("dim", `v${options.version}`)));
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
	 * Transition from splash to chat layout with animation.
	 */
	transitionToChat(): void {
		if (!this.active || this.animating) return;
		this.animating = true;

		let frame = 0;

		const nextFrame = () => {
			frame++;

			if (frame === 1) {
				// Frame 1: Dim the logo
				this.logo.setDimmed(true);
				this.ui.requestRender();
				this.animationTimer = setTimeout(nextFrame, FRAME_MS);
			} else if (frame === 2) {
				// Frame 2: Hide logo
				this.logo.setHidden(true);
				this.ui.requestRender();
				this.animationTimer = setTimeout(nextFrame, FRAME_MS);
			} else {
				// Frame 3: Switch to chat layout
				this.finishTransition();
			}
		};

		this.animationTimer = setTimeout(nextFrame, FRAME_MS);
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

		this.finishTransition();
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
		this.ui.setFocus(this.editor);

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
