/**
 * Selection state machine for mouse-based text selection.
 *
 * Manages anchor/head positions, click detection (single/double/triple),
 * and provides normalized selection ranges for rendering.
 */

import { visibleWidth } from "../utils.js";
import {
	type ContentPosition,
	charIndexToVisualCol,
	type PositionMapper,
	type ScreenPosition,
	stripAnsi,
} from "./position-mapper.js";

/** Selection range for a single line (visible columns). */
export interface LineSelection {
	startCol: number;
	endCol: number;
}

/** Full selection range between two content positions. */
export interface SelectionRange {
	anchor: ContentPosition;
	head: ContentPosition;
}

/** Click type for multi-click detection. */
type ClickType = "single" | "double" | "triple";

const MULTI_CLICK_TIMEOUT_MS = 400;
const MULTI_CLICK_COL_TOLERANCE = 3;

// Word boundary detection
const WORD_CHARS = /[\p{L}\p{N}_]/u;

export class SelectionManager {
	private range: SelectionRange | null = null;
	private isDragging = false;
	private clickType: ClickType = "single";

	// Multi-click tracking
	private lastClickTime = 0;
	private lastClickPos: ScreenPosition | null = null;
	private clickCount = 0;

	// Drag region lock — selection stays within the region where click started
	private dragRegionId: string | null = null;

	constructor(
		private positionMapper: PositionMapper,
		private requestRender: () => void,
	) {}

	/** Handle mouse button press (left click). */
	onMouseDown(screen: ScreenPosition): void {
		const content = this.positionMapper.screenToContent(screen);
		if (!content) {
			this.clear();
			return;
		}

		// Detect multi-click
		const now = Date.now();
		const timeDelta = now - this.lastClickTime;
		const samePosition =
			this.lastClickPos !== null &&
			Math.abs(screen.col - this.lastClickPos.col) <= MULTI_CLICK_COL_TOLERANCE &&
			screen.row === this.lastClickPos.row;

		if (timeDelta < MULTI_CLICK_TIMEOUT_MS && samePosition) {
			this.clickCount = Math.min(this.clickCount + 1, 3);
		} else {
			this.clickCount = 1;
		}

		this.lastClickTime = now;
		this.lastClickPos = { ...screen };

		if (this.clickCount === 1) {
			this.clickType = "single";
			this.range = { anchor: content, head: content };
		} else if (this.clickCount === 2) {
			this.clickType = "double";
			this.selectWord(content);
		} else {
			this.clickType = "triple";
			this.selectLine(content);
		}

		this.isDragging = true;
		this.dragRegionId = content.regionId;
		this.requestRender();
	}

	/** Handle mouse drag (motion with left button held). */
	onMouseDrag(screen: ScreenPosition): void {
		if (!this.isDragging || !this.dragRegionId) return;

		// Clamp to drag region bounds
		const bounds = this.positionMapper.getRegionBounds(this.dragRegionId);
		if (!bounds) return;

		const clampedRow = Math.max(bounds.startRow, Math.min(screen.row, bounds.startRow + bounds.height - 1));
		const clampedScreen: ScreenPosition = { row: clampedRow, col: Math.max(0, screen.col) };

		const content = this.positionMapper.screenToContent(clampedScreen);
		if (!content || content.regionId !== this.dragRegionId) return;

		if (this.clickType === "single") {
			// Normal drag — update head
			if (this.range) {
				this.range.head = content;
			}
		} else if (this.clickType === "double") {
			// Word-select drag — extend to word boundaries
			this.extendWordSelection(content);
		} else if (this.clickType === "triple") {
			// Line-select drag — extend to full lines
			this.extendLineSelection(content);
		}

		this.requestRender();
	}

	/** Handle mouse button release. */
	onMouseUp(_screen: ScreenPosition): void {
		this.isDragging = false;
		// Selection persists after release — cleared by next click or Escape
	}

	/** Get the current selection range, or null if nothing selected. */
	getSelection(): SelectionRange | null {
		return this.range;
	}

	/** Check if there's an active selection (anchor !== head). */
	hasSelection(): boolean {
		if (!this.range) return false;
		const { anchor, head } = this.range;
		return (
			anchor.regionId !== head.regionId || anchor.lineIndex !== head.lineIndex || anchor.charIndex !== head.charIndex
		);
	}

	/** Whether a drag is currently in progress. */
	get dragging(): boolean {
		return this.isDragging;
	}

	/** Clear the current selection. */
	clear(): void {
		if (this.range) {
			this.range = null;
			this.requestRender();
		}
	}

	/**
	 * Get the selection range for a specific line, in visible columns.
	 * Returns null if the line is not part of the selection.
	 *
	 * @param regionId - Region to check
	 * @param viewportRow - Row index within the region's viewport (after scroll, before indicators)
	 */
	getSelectionForLine(regionId: string, viewportRow: number, scrollOffset: number): LineSelection | null {
		if (!this.range) return null;

		const { anchor, head } = this.range;
		if (anchor.regionId !== regionId || head.regionId !== regionId) return null;

		// Normalize to start/end
		const [start, end] = this.normalizeRange(anchor, head);
		const lineIndex = viewportRow + Math.floor(scrollOffset);

		if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) return null;

		const renderedLine = this.positionMapper.getRenderedLine(regionId, viewportRow);
		const lineWidth = visibleWidth(renderedLine);

		let startCol: number;
		let endCol: number;

		if (lineIndex === start.lineIndex && lineIndex === end.lineIndex) {
			// Selection starts and ends on this line
			startCol = charIndexToVisualCol(renderedLine, start.charIndex);
			endCol = charIndexToVisualCol(renderedLine, end.charIndex);
		} else if (lineIndex === start.lineIndex) {
			// Selection starts on this line, continues below
			startCol = charIndexToVisualCol(renderedLine, start.charIndex);
			endCol = lineWidth;
		} else if (lineIndex === end.lineIndex) {
			// Selection ends on this line, started above
			startCol = 0;
			endCol = charIndexToVisualCol(renderedLine, end.charIndex);
		} else {
			// Entire line is selected (between start and end lines)
			startCol = 0;
			endCol = lineWidth;
		}

		if (startCol === endCol) return null;

		return { startCol, endCol };
	}

	/**
	 * Extract the selected plain text for clipboard.
	 */
	getSelectedText(): string {
		if (!this.range) return "";

		const { anchor, head } = this.range;
		if (anchor.regionId !== head.regionId) return "";

		const [start, end] = this.normalizeRange(anchor, head);
		const regionId = start.regionId;
		const bounds = this.positionMapper.getRegionBounds(regionId);
		if (!bounds) return "";

		const lines: string[] = [];
		const scrollOffset = Math.floor(bounds.scrollOffset);

		for (let lineIdx = start.lineIndex; lineIdx <= end.lineIndex; lineIdx++) {
			const viewportRow = lineIdx - scrollOffset;
			if (viewportRow < 0 || viewportRow >= bounds.viewportLines.length) continue;

			const plainText = stripAnsi(bounds.viewportLines[viewportRow]);

			if (lineIdx === start.lineIndex && lineIdx === end.lineIndex) {
				// Single line — extract character range
				lines.push(extractCharRange(plainText, start.charIndex, end.charIndex));
			} else if (lineIdx === start.lineIndex) {
				lines.push(extractCharRange(plainText, start.charIndex, Infinity));
			} else if (lineIdx === end.lineIndex) {
				lines.push(extractCharRange(plainText, 0, end.charIndex));
			} else {
				lines.push(plainText);
			}
		}

		return lines.join("\n");
	}

	/** Normalize anchor/head to start (earlier) / end (later). */
	private normalizeRange(a: ContentPosition, b: ContentPosition): [ContentPosition, ContentPosition] {
		if (a.lineIndex < b.lineIndex) return [a, b];
		if (a.lineIndex > b.lineIndex) return [b, a];
		// Same line
		if (a.charIndex <= b.charIndex) return [a, b];
		return [b, a];
	}

	/** Select the word at the given content position. */
	private selectWord(pos: ContentPosition): void {
		const bounds = this.positionMapper.getRegionBounds(pos.regionId);
		if (!bounds) return;

		const viewportRow = pos.lineIndex - Math.floor(bounds.scrollOffset);
		const plainText = this.positionMapper.getLineText(pos.regionId, viewportRow);
		if (!plainText) {
			this.range = { anchor: pos, head: pos };
			return;
		}

		// Find word boundaries using grapheme segmentation
		const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plainText)].map(
			(s) => s.segment,
		);
		let wordStart = pos.charIndex;
		let wordEnd = pos.charIndex;

		if (pos.charIndex < chars.length) {
			const isWordChar = WORD_CHARS.test(chars[pos.charIndex]);

			if (isWordChar) {
				// Expand to word boundaries
				while (wordStart > 0 && WORD_CHARS.test(chars[wordStart - 1])) wordStart--;
				while (wordEnd < chars.length && WORD_CHARS.test(chars[wordEnd])) wordEnd++;
			} else {
				// Non-word char: select just this char
				wordEnd = pos.charIndex + 1;
			}
		}

		this.range = {
			anchor: { regionId: pos.regionId, lineIndex: pos.lineIndex, charIndex: wordStart },
			head: { regionId: pos.regionId, lineIndex: pos.lineIndex, charIndex: wordEnd },
		};
	}

	/** Select the entire line at the given content position. */
	private selectLine(pos: ContentPosition): void {
		const bounds = this.positionMapper.getRegionBounds(pos.regionId);
		if (!bounds) return;

		const viewportRow = pos.lineIndex - Math.floor(bounds.scrollOffset);
		const plainText = this.positionMapper.getLineText(pos.regionId, viewportRow);
		const lineLength = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plainText)].length;

		this.range = {
			anchor: { regionId: pos.regionId, lineIndex: pos.lineIndex, charIndex: 0 },
			head: { regionId: pos.regionId, lineIndex: pos.lineIndex, charIndex: lineLength },
		};
	}

	/** Extend word selection during drag. */
	private extendWordSelection(content: ContentPosition): void {
		if (!this.range) return;

		const bounds = this.positionMapper.getRegionBounds(content.regionId);
		if (!bounds) return;

		const viewportRow = content.lineIndex - Math.floor(bounds.scrollOffset);
		const plainText = this.positionMapper.getLineText(content.regionId, viewportRow);
		const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plainText)].map(
			(s) => s.segment,
		);

		// Find word boundary at drag position
		let boundary = content.charIndex;
		if (boundary < chars.length && WORD_CHARS.test(chars[boundary])) {
			// Determine direction from anchor
			const anchorCenter =
				(this.range.anchor.charIndex +
					(this.range.anchor === this.range.head ? this.range.anchor.charIndex + 1 : this.range.head.charIndex)) /
				2;
			if (
				content.lineIndex > this.range.anchor.lineIndex ||
				(content.lineIndex === this.range.anchor.lineIndex && content.charIndex >= anchorCenter)
			) {
				// Extending forward — find end of word
				while (boundary < chars.length && WORD_CHARS.test(chars[boundary])) boundary++;
			} else {
				// Extending backward — find start of word
				while (boundary > 0 && WORD_CHARS.test(chars[boundary - 1])) boundary--;
			}
		}

		this.range.head = { regionId: content.regionId, lineIndex: content.lineIndex, charIndex: boundary };
	}

	/** Extend line selection during drag. */
	private extendLineSelection(content: ContentPosition): void {
		if (!this.range) return;

		const bounds = this.positionMapper.getRegionBounds(content.regionId);
		if (!bounds) return;

		const viewportRow = content.lineIndex - Math.floor(bounds.scrollOffset);
		const plainText = this.positionMapper.getLineText(content.regionId, viewportRow);
		const lineLength = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plainText)].length;

		if (content.lineIndex >= this.range.anchor.lineIndex) {
			// Extending down — head goes to end of drag line
			this.range.head = { regionId: content.regionId, lineIndex: content.lineIndex, charIndex: lineLength };
		} else {
			// Extending up — head goes to start of drag line
			this.range.head = { regionId: content.regionId, lineIndex: content.lineIndex, charIndex: 0 };
		}
	}
}

/**
 * Extract a range of grapheme characters from a string.
 */
function extractCharRange(text: string, startChar: number, endChar: number): string {
	const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
	const end = Math.min(endChar, segments.length);
	let result = "";
	for (let i = startChar; i < end; i++) {
		result += segments[i].segment;
	}
	return result;
}
