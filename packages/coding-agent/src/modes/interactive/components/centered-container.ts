import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

export interface CenteredContainerOptions {
	/** Add vertical borders (│) on left and right edges of content. */
	verticalBorders?: boolean;
	/** Color function for vertical borders. */
	borderColor?: (text: string) => string;
}

/**
 * A wrapper component that constrains its child to a maximum width
 * and horizontally centers the output within the available width.
 *
 * Optionally adds vertical borders to create a box effect around the child.
 * When verticalBorders is enabled, the first and last lines (editor's horizontal
 * borders) get corner characters, and content lines get │ on both sides.
 *
 * ANSI-safe: prepended spaces are plain characters, so CURSOR_MARKER
 * position calculation (via visibleWidth) remains correct.
 */
export class CenteredContainer implements Component {
	private child: Component;
	private maxWidth: number;
	private verticalBorders: boolean;
	private borderColor: (text: string) => string;

	constructor(child: Component, maxWidth: number, options?: CenteredContainerOptions) {
		this.child = child;
		this.maxWidth = maxWidth;
		this.verticalBorders = options?.verticalBorders ?? false;
		this.borderColor = options?.borderColor ?? ((s) => s);
	}

	setMaxWidth(maxWidth: number): void {
		this.maxWidth = maxWidth;
	}

	setBorderColor(borderColor: (text: string) => string): void {
		this.borderColor = borderColor;
	}

	render(width: number): string[] {
		if (!this.verticalBorders) {
			return this.renderSimple(width);
		}
		return this.renderWithBorders(width);
	}

	private renderSimple(width: number): string[] {
		const contentWidth = Math.min(width, this.maxWidth);
		const lines = this.child.render(contentWidth);

		if (contentWidth >= width) {
			return lines;
		}

		const leftPad = " ".repeat(Math.floor((width - contentWidth) / 2));
		return lines.map((line) => leftPad + line);
	}

	private renderWithBorders(width: number): string[] {
		// Reserve 2 chars for │ on each side
		const contentWidth = Math.min(width - 2, Math.max(1, this.maxWidth - 2));
		const lines = this.child.render(contentWidth);

		if (lines.length === 0) return [];

		const totalWidth = contentWidth + 2;
		const leftPad = width > totalWidth ? " ".repeat(Math.floor((width - totalWidth) / 2)) : "";

		const vBorder = this.borderColor("┃");

		return lines.map((line, i) => {
			const lineVw = visibleWidth(line);
			const padRight = Math.max(0, contentWidth - lineVw);

			if (i === 0) {
				// Top line: editor draws ─── border, we wrap with heavy corners
				return leftPad + this.borderColor("┏") + line + " ".repeat(padRight) + this.borderColor("┓");
			}
			if (i === lines.length - 1) {
				// Bottom line: editor draws ─── border, we wrap with heavy corners
				return leftPad + this.borderColor("┗") + line + " ".repeat(padRight) + this.borderColor("┛");
			}

			// Content lines: add heavy vertical borders
			return leftPad + vBorder + line + " ".repeat(padRight) + vBorder;
		});
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
