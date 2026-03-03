/**
 * Scroll controller for managing viewport scrolling within a flex region.
 *
 * Manages scroll offset, auto-follow behavior, and provides visible slice
 * of content for rendering within a constrained viewport height.
 *
 * Auto-follow mode:
 * - Enabled by default: viewport follows new content (stays at bottom)
 * - Disabled when user scrolls up (manual browsing)
 * - Re-enabled when user scrolls back to bottom
 */

export interface ScrollInfo {
	/** Number of content lines above the visible viewport */
	linesAbove: number;
	/** Number of content lines below the visible viewport */
	linesBelow: number;
	/** Current scroll offset (first visible line index) */
	offset: number;
	/** Total content height in lines */
	contentHeight: number;
	/** Viewport height in lines */
	viewportHeight: number;
}

export class ScrollController {
	private offset = 0;
	private contentHeight = 0;
	private viewportHeight = 0;
	private _autoFollow = true;

	/** Whether auto-follow is currently active */
	get autoFollow(): boolean {
		return this._autoFollow;
	}

	/** Get current scroll info for indicators */
	getScrollInfo(): ScrollInfo {
		return {
			linesAbove: this.offset,
			linesBelow: Math.max(0, this.contentHeight - this.offset - this.viewportHeight),
			offset: this.offset,
			contentHeight: this.contentHeight,
			viewportHeight: this.viewportHeight,
		};
	}

	/**
	 * Get the visible slice of content lines for the current scroll position.
	 *
	 * @param allLines - All rendered content lines
	 * @param viewportHeight - Available viewport height in rows
	 * @returns Visible portion of lines, clipped to viewport height
	 */
	getVisibleSlice(allLines: string[], viewportHeight: number): string[] {
		this.contentHeight = allLines.length;
		this.viewportHeight = viewportHeight;

		// Auto-follow: scroll to show latest content
		if (this._autoFollow) {
			this.offset = Math.max(0, allLines.length - viewportHeight);
		}

		// Clamp offset to valid range
		this.clampOffset();

		return allLines.slice(this.offset, this.offset + viewportHeight);
	}

	/** Scroll up by N lines */
	scrollUp(lines = 1): void {
		if (this.offset <= 0) return;
		this.offset = Math.max(0, this.offset - lines);
		this._autoFollow = false;
	}

	/** Scroll down by N lines */
	scrollDown(lines = 1): void {
		const maxOffset = Math.max(0, this.contentHeight - this.viewportHeight);
		if (this.offset >= maxOffset) return;
		this.offset = Math.min(maxOffset, this.offset + lines);

		// Re-enable auto-follow when scrolled to bottom
		if (this.offset >= maxOffset) {
			this._autoFollow = true;
		}
	}

	/** Scroll up by one page (viewport height) */
	pageUp(): void {
		this.scrollUp(Math.max(1, this.viewportHeight - 1));
	}

	/** Scroll down by one page (viewport height) */
	pageDown(): void {
		this.scrollDown(Math.max(1, this.viewportHeight - 1));
	}

	/** Scroll to the very top */
	scrollToTop(): void {
		if (this.offset === 0) return;
		this.offset = 0;
		this._autoFollow = false;
	}

	/** Scroll to the very bottom and re-enable auto-follow */
	scrollToBottom(): void {
		this.offset = Math.max(0, this.contentHeight - this.viewportHeight);
		this._autoFollow = true;
	}

	/**
	 * Notify that content has changed (new lines added/removed).
	 * If auto-follow is active, offset is updated to track the bottom.
	 */
	onContentChanged(newContentHeight: number): void {
		this.contentHeight = newContentHeight;
		if (this._autoFollow) {
			this.offset = Math.max(0, newContentHeight - this.viewportHeight);
		}
		this.clampOffset();
	}

	/** Reset scroll state (e.g., on conversation clear) */
	reset(): void {
		this.offset = 0;
		this.contentHeight = 0;
		this.viewportHeight = 0;
		this._autoFollow = true;
	}

	/** Clamp offset to valid range */
	private clampOffset(): void {
		const maxOffset = Math.max(0, this.contentHeight - this.viewportHeight);
		this.offset = Math.max(0, Math.min(this.offset, maxOffset));
	}
}
