/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AlternateScreenManager } from "./alternate-screen.js";
import { isKeyRelease, matchesKey } from "./keys.js";
import { LayoutEngine, type LayoutRegion } from "./layout.js";
import { ScrollController } from "./scroll-controller.js";
import { copyToClipboard, openUrl } from "./selection/clipboard.js";
import { PositionMapper } from "./selection/position-mapper.js";
import { SelectionManager } from "./selection/selection-manager.js";
import { applyLinkHoverHighlight, applySelectionHighlight } from "./selection/selection-renderer.js";
import type { Terminal } from "./terminal.js";
import {
	deleteAllKittyImages,
	deleteKittyImage,
	extractKittyImageId,
	getCapabilities,
	isImageLine,
	setCellDimensions,
} from "./terminal-image.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousWidth = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private inputBuffer = ""; // Buffer for parsing terminal responses
	private cellSizeQueryPending = false;
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private lastRenderTime = 0;
	/** If no render happened for this long, next render forces a full repaint (handles stale terminal after tab switch) */
	private static STALE_THRESHOLD_MS = 1000;

	// Region-based layout (alternate screen mode)
	private regions: LayoutRegion[] = [];
	private regionMode = false;
	private layoutEngine = new LayoutEngine();
	private alternateScreen: AlternateScreenManager | null = null;
	private scrollControllers = new Map<string, ScrollController>();
	private previousRegionViewport: string[] = [];

	// Mouse text selection
	private positionMapper = new PositionMapper();
	private selectionManager = new SelectionManager(this.positionMapper, () => this.requestRender());
	private lastDragRenderTime = 0;
	private static DRAG_RENDER_INTERVAL_MS = 33; // ~30fps during drag
	private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
	private autoScrollRegionId: string | null = null;
	private mouseDownPos: { row: number; col: number } | null = null;
	private hoveredLink: { row: number; startCol: number; endCol: number; url: string } | null = null;
	private lastHoverCheckTime = 0;
	private static HOVER_CHECK_INTERVAL_MS = 50; // 20fps hover detection

	// Overlay stack for modal components rendered on top of base content
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	// === Region-based layout API ===

	/**
	 * Add a layout region. Enables region mode (alternate screen + fixed layout).
	 * Regions are rendered top-to-bottom in the order they are added.
	 */
	addRegion(region: LayoutRegion): void {
		this.regions.push(region);
		this.regionMode = true;
		if (region.scrollable) {
			this.scrollControllers.set(region.id, new ScrollController());
		}
	}

	/** Remove a region by ID */
	removeRegion(id: string): void {
		this.regions = this.regions.filter((r) => r.id !== id);
		this.scrollControllers.delete(id);
		if (this.regions.length === 0) {
			this.regionMode = false;
		}
	}

	/** Get all defined regions */
	getRegions(): readonly LayoutRegion[] {
		return this.regions;
	}

	/** Get the scroll controller for a scrollable region */
	getScrollController(regionId: string): ScrollController | undefined {
		return this.scrollControllers.get(regionId);
	}

	/** Check if TUI is in region-based layout mode */
	isRegionMode(): boolean {
		return this.regionMode;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible overlay, if any */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		// Invalidate region components
		for (const region of this.regions) {
			for (const component of region.components) {
				component.invalidate?.();
			}
		}
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.cellSizeQueryPending = true;
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;

		// Exit alternate screen if in region mode
		if (this.alternateScreen?.isActive) {
			this.alternateScreen.exit();
			this.alternateScreen = null;
			this.terminal.showCursor();
			this.terminal.stop();
			return;
		}

		// Linear mode: move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		if (force) {
			if (this.regionMode) {
				this.previousRegionViewport = [];
				this.previousWidth = -1;
			} else {
				this.previousLines = [];
				this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
				this.cursorRow = 0;
				this.hardwareCursorRow = 0;
				this.maxLinesRendered = 0;
				this.previousViewportTop = 0;
			}
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	private handleInput(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// If we're waiting for cell size response, buffer input and parse
		if (this.cellSizeQueryPending) {
			this.inputBuffer += data;
			const filtered = this.parseCellSizeResponse();
			if (filtered.length === 0) return;
			data = filtered;
		}

		// Handle focus-in/focus-out events (from ?1004h focus reporting)
		// Focus-in: re-enable mouse reporting (may be lost after tab switch)
		// Focus-out: consumed silently (don't forward to editor)
		if (data === "\x1b[I") {
			// Re-enable SGR mouse reporting (terminal may have dropped it on tab switch)
			if (this.regionMode) {
				this.terminal.write("\x1b[?1003h\x1b[?1006h");
			}
			this.requestRender(true);
			return;
		}
		if (data === "\x1b[O") {
			// Focus-out — consume silently
			return;
		}

		// Handle mouse events in region mode (SGR format: \x1b[<button;col;rowM/m)
		if (this.regionMode && this.handleMouseEvent(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Clear text selection on any keystroke (Escape or typing clears selection)
		if (this.selectionManager.hasSelection()) {
			this.selectionManager.clear();
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	/**
	 * Handle SGR mouse events in region mode. Returns true if event was consumed.
	 * SGR format: \x1b[<button;col;rowM (press) / \x1b[<button;col;rowm (release)
	 *
	 * Button codes:
	 *   0 = left click, 1 = middle, 2 = right
	 *   32 = left drag (motion with left button held)
	 *   64 = scroll up, 65 = scroll down
	 *   M suffix = press/motion, m suffix = release
	 */
	private handleMouseEvent(data: string): boolean {
		const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
		if (!match) return false;

		const rawButton = parseInt(match[1], 10);
		// SGR coordinates are 1-indexed; convert to 0-indexed
		const col = parseInt(match[2], 10) - 1;
		const row = parseInt(match[3], 10) - 1;
		const isRelease = match[4] === "m";
		const screen = { row, col };

		// Strip modifier bits (Shift=bit2, Meta=bit3, Ctrl=bit4) to get base button
		const button = rawButton & ~(4 | 8 | 16);

		// Scroll wheel events: route to focused overlay or scrollable region
		if (button === 64 || button === 65) {
			// If an overlay is focused, forward scroll events to it
			const topOverlay = this.getTopmostVisibleOverlay();
			if (topOverlay?.component.handleInput) {
				topOverlay.component.handleInput(data);
				this.requestRender();
				return true;
			}

			// Scroll clears selection and hover
			if (this.selectionManager.hasSelection()) {
				this.selectionManager.clear();
			}
			this.hoveredLink = null;
			for (const region of this.regions) {
				if (region.scrollable) {
					const ctrl = this.scrollControllers.get(region.id);
					if (ctrl) {
						if (button === 64) {
							ctrl.scrollUp(0.5);
						} else {
							ctrl.scrollDown(0.5);
						}
						this.requestRender();
						break;
					}
				}
			}
			return true;
		}

		// Left button press
		if (button === 0 && !isRelease) {
			this.stopAutoScroll();
			this.mouseDownPos = { ...screen };
			const content = this.positionMapper.screenToContent(screen);
			this.autoScrollRegionId = content?.regionId ?? null;
			this.selectionManager.onMouseDown(screen);
			return true;
		}

		// Left button drag (button 32 = motion with left button held)
		if (button === 32) {
			this.handleDragAutoScroll(screen);
			// Rate-limit drag renders to ~30fps
			const now = Date.now();
			if (now - this.lastDragRenderTime < TUI.DRAG_RENDER_INTERVAL_MS) {
				// Still update selection state but skip render
				this.selectionManager.onMouseDrag(screen);
				return true;
			}
			this.lastDragRenderTime = now;
			this.selectionManager.onMouseDrag(screen);
			return true;
		}

		// Left button release
		if (button === 0 && isRelease) {
			this.stopAutoScroll();
			this.selectionManager.onMouseUp(screen);

			if (this.selectionManager.hasSelection()) {
				// Drag happened → copy selection to clipboard
				const text = this.selectionManager.getSelectedText();
				if (text) {
					copyToClipboard(text, (d) => this.terminal.write(d));
				}
			} else if (this.mouseDownPos && this.mouseDownPos.row === screen.row && this.mouseDownPos.col === screen.col) {
				// Click without drag → check for hyperlink
				const url = this.positionMapper.getUrlAtPosition(screen);
				if (url) {
					openUrl(url);
				}
			}

			this.mouseDownPos = null;
			return true;
		}

		// Mouse motion without button (button 35 = motion bit + no-button) → hover detection
		if (button === 35) {
			const now = Date.now();
			if (now - this.lastHoverCheckTime < TUI.HOVER_CHECK_INTERVAL_MS) return true;
			this.lastHoverCheckTime = now;

			const linkBounds = this.positionMapper.getLinkBoundsAtPosition(screen);
			const prevHover = this.hoveredLink;

			if (linkBounds) {
				const newHover = {
					row: screen.row,
					startCol: linkBounds.startCol,
					endCol: linkBounds.endCol,
					url: linkBounds.url,
				};
				// Only re-render if hover state changed
				if (
					!prevHover ||
					prevHover.row !== newHover.row ||
					prevHover.startCol !== newHover.startCol ||
					prevHover.url !== newHover.url
				) {
					this.hoveredLink = newHover;
					this.requestRender();
				}
			} else if (prevHover) {
				this.hoveredLink = null;
				this.requestRender();
			}
			return true;
		}

		// Consume all other mouse events (middle click, right click, etc.)
		return true;
	}

	/**
	 * Handle auto-scrolling when dragging past the edges of a scrollable region.
	 */
	private handleDragAutoScroll(screen: { row: number; col: number }): void {
		const dragRegion = this.selectionManager.dragging ? this.autoScrollRegionId : null;
		if (!dragRegion) {
			// Find the region the selection started in
			const sel = this.selectionManager.getSelection();
			if (!sel) return;
			this.autoScrollRegionId = sel.anchor.regionId;
		}

		const regionId = this.autoScrollRegionId;
		if (!regionId) return;

		const bounds = this.positionMapper.getRegionBounds(regionId);
		const scrollCtrl = this.scrollControllers.get(regionId);
		if (!bounds || !scrollCtrl) {
			this.stopAutoScroll();
			return;
		}

		const regionTop = bounds.startRow;
		const regionBottom = bounds.startRow + bounds.height - 1;

		if (screen.row < regionTop) {
			// Dragging above region — scroll up
			const distance = Math.min(regionTop - screen.row, 5);
			this.startAutoScroll(scrollCtrl, "up", distance);
		} else if (screen.row > regionBottom) {
			// Dragging below region — scroll down
			const distance = Math.min(screen.row - regionBottom, 5);
			this.startAutoScroll(scrollCtrl, "down", distance);
		} else {
			this.stopAutoScroll();
		}
	}

	private startAutoScroll(scrollCtrl: ScrollController, direction: "up" | "down", speed: number): void {
		this.stopAutoScroll();
		this.autoScrollTimer = setInterval(() => {
			if (direction === "up") {
				scrollCtrl.scrollUp(speed * 0.5);
			} else {
				scrollCtrl.scrollDown(speed * 0.5);
			}
			this.requestRender();
		}, 50);
	}

	private stopAutoScroll(): void {
		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = null;
		}
	}

	private parseCellSizeResponse(): string {
		// Response format: ESC [ 6 ; height ; width t
		// Match the response pattern
		const responsePattern = /\x1b\[6;(\d+);(\d+)t/;
		const match = this.inputBuffer.match(responsePattern);

		if (match) {
			const heightPx = parseInt(match[1], 10);
			const widthPx = parseInt(match[2], 10);

			if (heightPx > 0 && widthPx > 0) {
				setCellDimensions({ widthPx, heightPx });
				// Invalidate all components so images re-render with correct dimensions
				this.invalidate();
				this.requestRender();
			}

			// Remove the response from buffer
			this.inputBuffer = this.inputBuffer.replace(responsePattern, "");
			this.cellSizeQueryPending = false;
		}

		// Check if we have a partial cell size response starting (wait for more data)
		// Patterns that could be incomplete cell size response: \x1b, \x1b[, \x1b[6, \x1b[6;...(no t yet)
		const partialCellSizePattern = /\x1b(\[6?;?[\d;]*)?$/;
		if (partialCellSizePattern.test(this.inputBuffer)) {
			// Check if it's actually a complete different escape sequence (ends with a letter)
			// Cell size response ends with 't', Kitty keyboard ends with 'u', arrows end with A-D, etc.
			const lastChar = this.inputBuffer[this.inputBuffer.length - 1];
			if (!/[a-zA-Z~]/.test(lastChar)) {
				// Doesn't end with a terminator, might be incomplete - wait for more
				return "";
			}
		}

		// No cell size response found, return buffered data as user input
		const result = this.inputBuffer;
		this.inputBuffer = "";
		this.cellSizeQueryPending = false; // Give up waiting
		return result;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (in stack order, later = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		for (const entry of this.overlayStack) {
			// Skip invisible overlays (hidden or visible() returns false)
			if (!this.isOverlayVisible(entry)) continue;

			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Ensure result covers the terminal working area to keep overlay positioning stable across resizes.
		// maxLinesRendered can exceed current content length after a shrink; pad to keep viewportStart consistent.
		const workingHeight = Math.max(this.maxLinesRendered, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Track which lines were modified for final verification
		const modifiedLines = new Set<number>();

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					modifiedLines.add(idx);
				}
			}
		}

		// Final verification: ensure no composited line exceeds terminal width
		// This is a belt-and-suspenders safeguard - compositeLineAt should already
		// guarantee this, but we verify here to prevent crashes from any edge cases
		// Only check lines that were actually modified (optimization)
		for (const idx of modifiedLines) {
			const lineWidth = visibleWidth(result[idx]);
			if (lineWidth > termWidth) {
				result[idx] = sliceByColumn(result[idx], 0, termWidth, true);
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = line + reset;
			}
		}
		return lines;
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;

		// Dispatch to region-based renderer if regions are defined
		if (this.regionMode) {
			this.doRegionRender();
			return;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let viewportTop = Math.max(0, this.maxLinesRendered - height);
		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Width changed - need full re-render (line wrapping changes)
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

		// Helper to clear scrollback and viewport and render all new lines
		const isKitty = getCapabilities().images === "kitty";
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			// Delete Kitty graphics before clearing — \x1b[2J only clears text, not image overlays
			if (clear && isKitty) buffer += deleteAllKittyImages();
			if (clear) buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changed - full re-render (line wrapping changes)
		if (widthChanged) {
			logRedraw(`width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// Check if firstChanged is above what was previously visible
		// Use previousLines.length (not maxLinesRendered) to avoid false positives after content shrinks
		const previousContentViewportTop = Math.max(0, this.previousLines.length - height);
		if (firstChanged < previousContentViewportTop) {
			// First change is above previous viewport - need full re-render
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${previousContentViewportTop})`);
			fullRender(true);
			return;
		}

		// Kitty image cleanup: find dirty images and delete all their placements.
		const dirtyImageIdsLinear = new Set<number>();
		if (isKitty) {
			for (let i = firstChanged; i <= lastChanged; i++) {
				const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
				const newLine = i < newLines.length ? newLines[i] : "";
				if (oldLine !== newLine) {
					const oldId = extractKittyImageId(oldLine);
					const newId = extractKittyImageId(newLine);
					if (oldId !== undefined) dirtyImageIdsLinear.add(oldId);
					if (newId !== undefined) dirtyImageIdsLinear.add(newId);
				}
			}
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		for (const id of dirtyImageIdsLinear) {
			buffer += deleteKittyImage(id);
		}
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			const line = newLines[i];
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousWidth = width;
	}

	/**
	 * Region-based render: alternate screen + fixed layout regions.
	 * Builds a viewport of exactly termHeight lines, then diffs against previous.
	 */
	private doRegionRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Detect stale display: if no render happened for a while (e.g., tab switch
		// on terminals that don't send focus events), force a full repaint
		const now = Date.now();
		if (this.lastRenderTime > 0 && now - this.lastRenderTime > TUI.STALE_THRESHOLD_MS) {
			this.previousRegionViewport = [];
			this.previousWidth = -1;
			// Fix 1: proactively re-enable mouse reporting when display has been idle
			// (mouse reporting can be silently dropped by terminals during idle periods)
			this.terminal.write("\x1b[?1003h\x1b[?1006h");
		}
		this.lastRenderTime = now;

		// Enter alternate screen on first region render
		if (!this.alternateScreen) {
			this.alternateScreen = new AlternateScreenManager(this.terminal);
			this.alternateScreen.enter();
			this.alternateScreen.onResize(() => {
				this.requestRender(true);
			});
		}

		// Calculate layout
		const layouts = this.layoutEngine.calculate(this.regions, width, height);

		// Track per-region data for position mapper and selection
		const scrollOffsets = new Map<string, number>();
		const regionViewportLines = new Map<string, string[]>();
		const scrollIndicators = new Map<string, { top: boolean; bottom: boolean }>();

		// Build viewport (flat array of exactly `height` lines)
		const viewport: string[] = [];
		for (const layout of layouts) {
			let lines = layout.renderedLines;
			let hasTopIndicator = false;
			let hasBottomIndicator = false;

			// Apply scroll for scrollable regions
			const scrollCtrl = this.scrollControllers.get(layout.region.id);
			if (scrollCtrl && layout.region.scrollable) {
				lines = scrollCtrl.getVisibleSlice(lines, layout.height);
				scrollOffsets.set(layout.region.id, scrollCtrl.getScrollInfo().offset);

				// Add scroll indicators (consume 1 line each from viewport)
				const info = scrollCtrl.getScrollInfo();
				if (info.linesAbove > 0 || info.linesBelow > 0) {
					hasTopIndicator = info.linesAbove > 0;
					hasBottomIndicator = info.linesBelow > 0;
					const result: string[] = [];
					if (info.linesAbove > 0) {
						const indicator = `─── ↑ ${info.linesAbove} more `;
						const fill = Math.max(0, width - visibleWidth(indicator));
						result.push(indicator + "─".repeat(fill));
					}
					// Content lines (trim if indicators take space)
					const contentStart = info.linesAbove > 0 ? 1 : 0;
					const contentEnd = info.linesBelow > 0 ? lines.length - 1 : lines.length;
					for (let i = contentStart; i < contentEnd; i++) {
						result.push(lines[i]);
					}
					if (info.linesBelow > 0) {
						const indicator = `─── ↓ ${info.linesBelow} more `;
						const fill = Math.max(0, width - visibleWidth(indicator));
						result.push(indicator + "─".repeat(fill));
					}
					lines = result;
				}
			} else {
				// Non-scrollable: just take what fits
				lines = lines.slice(0, layout.height);
				scrollOffsets.set(layout.region.id, 0);
			}

			// Store viewport lines for this region (content lines without indicators)
			const contentLines: string[] = [];
			const startIdx = hasTopIndicator ? 1 : 0;
			const endIdx = hasBottomIndicator ? lines.length - 1 : lines.length;
			for (let i = startIdx; i < endIdx; i++) {
				contentLines.push(lines[i]);
			}
			regionViewportLines.set(layout.region.id, contentLines);
			scrollIndicators.set(layout.region.id, { top: hasTopIndicator, bottom: hasBottomIndicator });

			// Apply selection highlighting to content lines (not indicators)
			if (this.selectionManager.hasSelection()) {
				const regionId = layout.region.id;
				const scrollOffset = scrollOffsets.get(regionId) ?? 0;
				for (let i = 0; i < lines.length; i++) {
					// Skip indicator lines
					if (hasTopIndicator && i === 0) continue;
					if (hasBottomIndicator && i === lines.length - 1) continue;

					// Calculate viewport row (content index without indicator offset)
					const viewportRow = hasTopIndicator ? i - 1 : i;
					const sel = this.selectionManager.getSelectionForLine(regionId, viewportRow, scrollOffset);
					if (sel) {
						const lineWidth = visibleWidth(lines[i]);
						lines[i] = applySelectionHighlight(lines[i], sel.startCol, sel.endCol, lineWidth);
					}
				}
			}

			// Apply link hover highlighting
			if (this.hoveredLink) {
				const screenRowBase = layout.startRow;
				for (let i = 0; i < lines.length; i++) {
					const screenRow = screenRowBase + i;
					if (screenRow === this.hoveredLink.row) {
						const lineWidth = visibleWidth(lines[i]);
						lines[i] = applyLinkHoverHighlight(
							lines[i],
							this.hoveredLink.startCol,
							this.hoveredLink.endCol,
							lineWidth,
						);
						break;
					}
				}
			}

			// Add lines to viewport, padding to region height
			for (let i = 0; i < layout.height; i++) {
				viewport.push(i < lines.length ? lines[i] : "");
			}
		}

		// Update position mapper with current layout data
		this.positionMapper.setRegionLayouts(layouts, scrollOffsets, regionViewportLines, scrollIndicators);

		// Ensure viewport is exactly terminal height
		while (viewport.length < height) viewport.push("");
		if (viewport.length > height) viewport.length = height;

		// Composite overlays (reuses existing overlay system)
		let finalLines = viewport;
		if (this.overlayStack.length > 0) {
			// compositeOverlays expects maxLinesRendered for working height;
			// in region mode viewport is already the right size, so we temporarily
			// set maxLinesRendered to 0 so workingHeight = viewport.length = termHeight
			const savedMaxLines = this.maxLinesRendered;
			this.maxLinesRendered = 0;
			finalLines = this.compositeOverlays([...viewport], width, height);
			this.maxLinesRendered = savedMaxLines;
			// Ensure result is exactly termHeight
			if (finalLines.length > height) finalLines.length = height;
		}

		// Extract cursor position (scans all viewport lines)
		const cursorPos = this.extractCursorPosition(finalLines, height);

		// Apply line resets
		finalLines = this.applyLineResets(finalLines);

		// Determine if full repaint needed
		const force = this.previousRegionViewport.length === 0 || this.previousWidth !== width;

		// Kitty image cleanup: find "dirty" images (any tile changed position) and
		// delete ALL placements for those images before re-rendering.
		// Then force re-render ALL tiles of dirty images (not just changed ones),
		// because deleteKittyImage removes all placements including unchanged tiles.
		const isKittyRegion = getCapabilities().images === "kitty";
		const dirtyImageIds = new Set<number>();
		if (isKittyRegion && !force) {
			for (let i = 0; i < Math.max(finalLines.length, this.previousRegionViewport.length); i++) {
				const oldLine = i < this.previousRegionViewport.length ? this.previousRegionViewport[i] : "";
				const newLine = i < finalLines.length ? finalLines[i] : "";
				if (oldLine !== newLine) {
					const oldId = extractKittyImageId(oldLine);
					const newId = extractKittyImageId(newLine);
					if (oldId !== undefined) dirtyImageIds.add(oldId);
					if (newId !== undefined) dirtyImageIds.add(newId);
				}
			}
		}

		// Render using absolute ANSI cursor positioning
		let buffer = "\x1b[?2026h"; // Begin synchronized output

		// Delete all placements for dirty images (within sync output, so no flicker)
		for (const id of dirtyImageIds) {
			buffer += deleteKittyImage(id);
		}

		if (force) {
			// Full repaint — clear screen + reset attributes + re-enable mouse reporting
			// Mouse reporting can be lost after idle periods, subprocess noise, or terminal resets.
			// Re-enabling it here (Fix 4) ensures it is always active after any forced repaint.
			buffer += "\x1b[0m\x1b[2J\x1b[H\x1b[?1003h\x1b[?1006h";
			if (isKittyRegion) buffer += deleteAllKittyImages();
			for (let i = 0; i < finalLines.length; i++) {
				buffer += `\x1b[${i + 1};1H\x1b[2K${finalLines[i]}`;
			}
		} else {
			// Differential: repaint changed lines + force-render dirty image tiles
			for (let i = 0; i < finalLines.length; i++) {
				const oldLine = i < this.previousRegionViewport.length ? this.previousRegionViewport[i] : "";
				const newLine = finalLines[i];
				const lineId = extractKittyImageId(newLine);
				const isDirtyImage = lineId !== undefined && dirtyImageIds.has(lineId);

				if (newLine !== oldLine || isDirtyImage) {
					buffer += `\x1b[${i + 1};1H\x1b[2K${newLine}`;
				}
			}
		}

		buffer += "\x1b[?2026l"; // End synchronized output
		this.terminal.write(buffer);

		// Position hardware cursor for IME
		if (cursorPos) {
			this.terminal.write(`\x1b[${cursorPos.row + 1};${cursorPos.col + 1}H`);
			if (this.showHardwareCursor) {
				this.terminal.showCursor();
			} else {
				this.terminal.hideCursor();
			}
		} else {
			this.terminal.hideCursor();
		}

		this.previousRegionViewport = finalLines;
		this.previousWidth = width;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
