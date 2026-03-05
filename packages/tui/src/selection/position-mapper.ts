/**
 * Maps screen coordinates (row, col) to content positions (regionId, lineIndex, charIndex).
 *
 * This is the critical bridge between mouse events (which provide terminal coordinates)
 * and the content model (which uses region-relative line indices and character offsets).
 */

import type { RegionLayout } from "../layout.js";
import { extractAnsiCode, visibleWidth } from "../utils.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A position within rendered content.
 */
export interface ContentPosition {
	/** Region this position belongs to */
	regionId: string;
	/** Line index within the region's full content (accounting for scroll offset) */
	lineIndex: number;
	/** Visible character index (0-indexed, ANSI codes excluded) */
	charIndex: number;
}

/**
 * Screen coordinate (terminal-relative).
 */
export interface ScreenPosition {
	/** 0-indexed row from top of terminal */
	row: number;
	/** 0-indexed column from left of terminal */
	col: number;
}

/**
 * Region bounds on screen, used for hit testing.
 */
interface RegionBounds {
	regionId: string;
	startRow: number;
	height: number;
	scrollOffset: number;
	/** The lines currently visible in viewport (after scroll slicing) */
	viewportLines: string[];
	/** Whether this region has a scroll indicator at top */
	hasTopIndicator: boolean;
	/** Whether this region has a scroll indicator at bottom */
	hasBottomIndicator: boolean;
}

export class PositionMapper {
	private regionBounds: RegionBounds[] = [];

	/**
	 * Update region layout data. Call after layout calculation and scroll slicing.
	 */
	setRegionLayouts(
		layouts: RegionLayout[],
		scrollOffsets: Map<string, number>,
		viewportLines: Map<string, string[]>,
		scrollIndicators: Map<string, { top: boolean; bottom: boolean }>,
	): void {
		this.regionBounds = layouts.map((layout) => ({
			regionId: layout.region.id,
			startRow: layout.startRow,
			height: layout.height,
			scrollOffset: scrollOffsets.get(layout.region.id) ?? 0,
			viewportLines: viewportLines.get(layout.region.id) ?? layout.renderedLines,
			hasTopIndicator: scrollIndicators.get(layout.region.id)?.top ?? false,
			hasBottomIndicator: scrollIndicators.get(layout.region.id)?.bottom ?? false,
		}));
	}

	/**
	 * Map a screen position to a content position.
	 * Returns null if the position is outside any region or on a scroll indicator.
	 */
	screenToContent(screen: ScreenPosition): ContentPosition | null {
		const bounds = this.findRegion(screen.row);
		if (!bounds) return null;

		const rowInRegion = screen.row - bounds.startRow;

		// Skip scroll indicators
		if (bounds.hasTopIndicator && rowInRegion === 0) return null;
		if (bounds.hasBottomIndicator && rowInRegion === bounds.height - 1) return null;

		// Adjust for top indicator offset
		const contentRowInViewport = bounds.hasTopIndicator ? rowInRegion - 1 : rowInRegion;

		if (contentRowInViewport < 0 || contentRowInViewport >= bounds.viewportLines.length) {
			return null;
		}

		// Calculate content line index (viewport row + scroll offset)
		const lineIndex = contentRowInViewport + Math.floor(bounds.scrollOffset);

		// Map visible column to character index
		const line = bounds.viewportLines[contentRowInViewport];
		const charIndex = visualColToCharIndex(line, screen.col);

		return {
			regionId: bounds.regionId,
			lineIndex,
			charIndex,
		};
	}

	/**
	 * Find which region a screen row falls in.
	 */
	findRegion(screenRow: number): RegionBounds | null {
		for (const bounds of this.regionBounds) {
			if (screenRow >= bounds.startRow && screenRow < bounds.startRow + bounds.height) {
				return bounds;
			}
		}
		return null;
	}

	/**
	 * Get the plain text of a rendered line (ANSI codes stripped).
	 */
	getLineText(regionId: string, viewportRow: number): string {
		const bounds = this.regionBounds.find((b) => b.regionId === regionId);
		if (!bounds || viewportRow < 0 || viewportRow >= bounds.viewportLines.length) {
			return "";
		}
		return stripAnsi(bounds.viewportLines[viewportRow]);
	}

	/**
	 * Get the rendered line (with ANSI codes) for a viewport row.
	 */
	getRenderedLine(regionId: string, viewportRow: number): string {
		const bounds = this.regionBounds.find((b) => b.regionId === regionId);
		if (!bounds || viewportRow < 0 || viewportRow >= bounds.viewportLines.length) {
			return "";
		}
		return bounds.viewportLines[viewportRow];
	}

	/**
	 * Get the visible width of a line at a given viewport row.
	 */
	getLineWidth(regionId: string, viewportRow: number): number {
		const line = this.getRenderedLine(regionId, viewportRow);
		return visibleWidth(line);
	}

	/**
	 * Get region bounds for coordinate clamping during drag.
	 */
	getRegionBounds(regionId: string): RegionBounds | null {
		return this.regionBounds.find((b) => b.regionId === regionId) ?? null;
	}

	/**
	 * Get the OSC 8 hyperlink URL at a given screen position, if any.
	 */
	getUrlAtPosition(screen: ScreenPosition): string | null {
		const line = this.getViewportLineAtScreen(screen);
		if (!line) return null;
		return extractOsc8UrlAtCol(line, screen.col);
	}

	/**
	 * Get the link bounds (url + column range) at a given screen position.
	 * Used for hover highlighting.
	 */
	getLinkBoundsAtPosition(screen: ScreenPosition): LinkBounds | null {
		const line = this.getViewportLineAtScreen(screen);
		if (!line) return null;
		return extractOsc8LinkBoundsAtCol(line, screen.col);
	}

	/**
	 * Get the viewport line at a screen position, handling region/indicator offsets.
	 */
	private getViewportLineAtScreen(screen: ScreenPosition): string | null {
		const bounds = this.findRegion(screen.row);
		if (!bounds) return null;

		const rowInRegion = screen.row - bounds.startRow;
		if (bounds.hasTopIndicator && rowInRegion === 0) return null;
		if (bounds.hasBottomIndicator && rowInRegion === bounds.height - 1) return null;

		const contentRow = bounds.hasTopIndicator ? rowInRegion - 1 : rowInRegion;
		if (contentRow < 0 || contentRow >= bounds.viewportLines.length) return null;

		return bounds.viewportLines[contentRow];
	}
}

/**
 * Map a visible column position to a character index in an ANSI-coded string.
 * Walks the string, skipping ANSI escape sequences and counting visible columns.
 *
 * @param line - Rendered line with ANSI codes
 * @param targetCol - Target visible column (0-indexed)
 * @returns Character index (0-indexed, in terms of visible characters)
 */
export function visualColToCharIndex(line: string, targetCol: number): number {
	if (!line) return 0;

	let visibleCol = 0;
	let charIndex = 0;
	let i = 0;

	while (i < line.length) {
		// Skip ANSI escape sequences
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		// Find extent of non-ANSI text
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		// Segment into graphemes
		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			const w = graphemeTerminalWidth(segment);

			if (visibleCol + w > targetCol) {
				// Target falls within this grapheme (or on a wide char boundary)
				return charIndex;
			}

			visibleCol += w;
			charIndex++;

			if (visibleCol > targetCol) {
				return charIndex;
			}
		}

		i = textEnd;
	}

	return charIndex;
}

/**
 * Map a character index back to a visible column position.
 *
 * @param line - Rendered line with ANSI codes
 * @param targetCharIndex - Target character index (0-indexed)
 * @returns Visible column (0-indexed)
 */
export function charIndexToVisualCol(line: string, targetCharIndex: number): number {
	if (!line) return 0;

	let visibleCol = 0;
	let charIndex = 0;
	let i = 0;

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			if (charIndex >= targetCharIndex) {
				return visibleCol;
			}
			visibleCol += graphemeTerminalWidth(segment);
			charIndex++;
		}

		i = textEnd;
	}

	return visibleCol;
}

/**
 * Get the terminal display width of a single grapheme.
 * Simplified version — delegates to visibleWidth for accuracy.
 */
function graphemeTerminalWidth(segment: string): number {
	return visibleWidth(segment);
}

/** Link bounds: URL + visible column range of the link text. */
export interface LinkBounds {
	url: string;
	startCol: number;
	endCol: number;
}

/**
 * Extract the OSC 8 link bounds (URL + column range) at a given visible column.
 * Returns null if no link at that column.
 */
export function extractOsc8LinkBoundsAtCol(line: string, targetCol: number): LinkBounds | null {
	if (!line || !line.includes("\x1b]8;")) return null;

	// First pass: build a map of link regions
	const links: Array<{ url: string; startCol: number; endCol: number }> = [];
	let visibleCol = 0;
	let currentUrl: string | null = null;
	let linkStartCol = 0;
	let i = 0;

	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "]" && line[i + 2] === "8" && line[i + 3] === ";") {
			let j = i + 4;
			while (j < line.length && line[j] !== ";") j++;
			j++;
			const urlStart = j;
			while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
			const url = line.slice(urlStart, j);
			if (line[j] === "\x07") j++;
			else if (line[j] === "\x1b" && line[j + 1] === "\\") j += 2;

			if (url) {
				// Link start
				currentUrl = url;
				linkStartCol = visibleCol;
			} else if (currentUrl) {
				// Link end
				links.push({ url: currentUrl, startCol: linkStartCol, endCol: visibleCol });
				currentUrl = null;
			}
			i = j;
			continue;
		}

		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && line[textEnd] !== "\x1b") textEnd++;
		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			visibleCol += graphemeTerminalWidth(segment);
		}
		i = textEnd;
	}

	// Close any unclosed link
	if (currentUrl) {
		links.push({ url: currentUrl, startCol: linkStartCol, endCol: visibleCol });
	}

	// Find which link contains the target column
	for (const link of links) {
		if (targetCol >= link.startCol && targetCol < link.endCol) {
			return link;
		}
	}

	return null;
}

/**
 * Extract the OSC 8 hyperlink URL at a given visible column in a rendered line.
 * Walks the line tracking which OSC 8 link region the column falls in.
 *
 * OSC 8 format: \x1b]8;;URL\x07 (start) ... \x1b]8;;\x07 (end)
 */
export function extractOsc8UrlAtCol(line: string, targetCol: number): string | null {
	if (!line || !line.includes("\x1b]8;")) return null;

	let visibleCol = 0;
	let currentUrl: string | null = null;
	let i = 0;

	while (i < line.length) {
		// Check for OSC 8 hyperlink sequence
		if (line[i] === "\x1b" && line[i + 1] === "]" && line[i + 2] === "8" && line[i + 3] === ";") {
			// Parse OSC 8: \x1b]8;params;url\x07
			let j = i + 4;
			// Skip params (between first ; and second ;)
			while (j < line.length && line[j] !== ";") j++;
			j++; // skip the second ;
			// Extract URL (until BEL \x07 or ST \x1b\\)
			const urlStart = j;
			while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
			const url = line.slice(urlStart, j);
			// Skip terminator
			if (line[j] === "\x07") j++;
			else if (line[j] === "\x1b" && line[j + 1] === "\\") j += 2;

			currentUrl = url || null; // empty URL = end of hyperlink
			i = j;
			continue;
		}

		// Check for other ANSI codes
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		// Visible character — check if we've reached the target column
		let textEnd = i;
		while (textEnd < line.length && line[textEnd] !== "\x1b") textEnd++;

		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			const w = graphemeTerminalWidth(segment);
			if (visibleCol <= targetCol && targetCol < visibleCol + w) {
				return currentUrl;
			}
			visibleCol += w;
			if (visibleCol > targetCol) return null;
		}

		i = textEnd;
	}

	return null;
}

/**
 * Strip all ANSI escape sequences from a string.
 */
export function stripAnsi(str: string): string {
	if (!str || !str.includes("\x1b")) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
		} else {
			result += str[i];
			i++;
		}
	}
	return result;
}
