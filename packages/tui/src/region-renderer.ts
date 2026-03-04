/**
 * Region renderer — paints layout regions to absolute terminal positions
 * using ANSI cursor positioning escape sequences.
 *
 * Each region is rendered independently at its assigned row range.
 * Differential rendering: only changed lines are rewritten.
 *
 * ANSI sequences used:
 * - \x1b[{row};{col}H  — Move cursor to absolute position (1-indexed)
 * - \x1b[2K             — Clear entire current line
 * - \x1b[?2026h/l       — Synchronized output (batch updates, reduce flicker)
 */

import type { RegionLayout } from "./layout.js";
import type { Terminal } from "./terminal.js";
import {
	deleteAllKittyImages,
	deleteKittyImage,
	extractKittyImageId,
	getCapabilities,
	isImageLine,
} from "./terminal-image.js";
import { visibleWidth } from "./utils.js";

/** Stored state for differential rendering */
export interface RegionState {
	/** Region ID */
	id: string;
	/** Previously rendered lines for this region */
	lines: string[];
	/** Absolute start row */
	startRow: number;
	/** Allocated height */
	height: number;
}

/** Reset sequence appended to each line */
const LINE_RESET = "\x1b[0m\x1b]8;;\x07";

export class RegionRenderer {
	private previousStates = new Map<string, RegionState>();
	private terminal: Terminal;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	/**
	 * Render all regions. Uses differential rendering when possible.
	 *
	 * @param layouts - Computed region layouts with rendered lines
	 * @param termWidth - Terminal width for line width validation
	 * @param force - Force full repaint (skip diff, clear and redraw all)
	 */
	renderAll(layouts: RegionLayout[], termWidth: number, force = false): void {
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		const isKitty = getCapabilities().images === "kitty";

		if (force) {
			// Full repaint: clear screen and render everything
			// Delete all Kitty graphics before clearing — \x1b[2J only clears text, not image overlays
			if (isKitty) buffer += deleteAllKittyImages();
			buffer += "\x1b[2J"; // Clear screen (not scrollback)
			for (const layout of layouts) {
				buffer += this.paintRegion(layout, termWidth);
				this.saveState(layout);
			}
		} else {
			// Targeted Kitty image cleanup: delete only images whose IDs left the viewport.
			// Images embed their own deleteKittyImage(id) when re-rendered at a new position.
			// Here we only clean up images that are no longer present at all.
			if (isKitty) {
				buffer += this.computeImageCleanup(layouts);
			}

			// Differential: only repaint changed regions/lines
			for (const layout of layouts) {
				const prev = this.previousStates.get(layout.region.id);
				if (prev && prev.startRow === layout.startRow && prev.height === layout.height) {
					// Same position and size — diff individual lines
					buffer += this.paintRegionDiff(layout, prev, termWidth);
				} else {
					// Position or size changed — full region repaint
					// Clear old region area if it existed at a different position
					if (prev && (prev.startRow !== layout.startRow || prev.height !== layout.height)) {
						buffer += this.clearRegionArea(prev);
					}
					buffer += this.paintRegion(layout, termWidth);
				}
				this.saveState(layout);
			}

			// Clear regions that no longer exist
			const currentIds = new Set(layouts.map((l) => l.region.id));
			for (const [id, state] of this.previousStates) {
				if (!currentIds.has(id)) {
					buffer += this.clearRegionArea(state);
					this.previousStates.delete(id);
				}
			}
		}

		buffer += "\x1b[?2026l"; // End synchronized output
		this.terminal.write(buffer);
	}

	/**
	 * Paint a region fully at its absolute position.
	 * Lines are padded or truncated to fit the region height.
	 */
	private paintRegion(layout: RegionLayout, termWidth: number): string {
		let buffer = "";
		const { startRow, height, renderedLines } = layout;

		for (let i = 0; i < height; i++) {
			const row = startRow + i + 1; // ANSI is 1-indexed
			const line = i < renderedLines.length ? renderedLines[i] : "";

			buffer += `\x1b[${row};1H\x1b[2K`; // Move + clear line
			if (line.length > 0) {
				this.validateLineWidth(line, termWidth, layout.region.id, i);
				buffer += isImageLine(line) ? line : line + LINE_RESET;
			}
		}

		return buffer;
	}

	/**
	 * Paint only changed lines within a region (differential rendering).
	 */
	private paintRegionDiff(layout: RegionLayout, prev: RegionState, termWidth: number): string {
		let buffer = "";
		const { startRow, height, renderedLines } = layout;

		for (let i = 0; i < height; i++) {
			const newLine = i < renderedLines.length ? renderedLines[i] : "";
			const oldLine = i < prev.lines.length ? prev.lines[i] : "";

			if (newLine !== oldLine) {
				const row = startRow + i + 1; // ANSI is 1-indexed
				buffer += `\x1b[${row};1H\x1b[2K`; // Move + clear line
				if (newLine.length > 0) {
					this.validateLineWidth(newLine, termWidth, layout.region.id, i);
					buffer += isImageLine(newLine) ? newLine : newLine + LINE_RESET;
				}
			}
		}

		return buffer;
	}

	/**
	 * Clear a region's area (used when region moves or is removed).
	 */
	private clearRegionArea(state: RegionState): string {
		let buffer = "";
		for (let i = 0; i < state.height; i++) {
			const row = state.startRow + i + 1;
			buffer += `\x1b[${row};1H\x1b[2K`;
		}
		return buffer;
	}

	/** Save region state for next differential render */
	private saveState(layout: RegionLayout): void {
		this.previousStates.set(layout.region.id, {
			id: layout.region.id,
			lines: layout.renderedLines.slice(0, layout.height),
			startRow: layout.startRow,
			height: layout.height,
		});
	}

	/** Validate that a rendered line doesn't exceed terminal width */
	private validateLineWidth(line: string, termWidth: number, regionId: string, lineIndex: number): void {
		if (!isImageLine(line) && visibleWidth(line) > termWidth) {
			throw new Error(
				`Region "${regionId}" line ${lineIndex} exceeds terminal width ` +
					`(${visibleWidth(line)} > ${termWidth}). ` +
					`Components must truncate output to terminal width.`,
			);
		}
	}

	/**
	 * Compute targeted Kitty image deletion commands.
	 * Compares image IDs in previous state vs new layouts.
	 * Only deletes images whose IDs are no longer present (scrolled out completely).
	 */
	private computeImageCleanup(layouts: RegionLayout[]): string {
		const oldIds = new Set<number>();
		const newIds = new Set<number>();

		// Collect IDs from previous state
		for (const state of this.previousStates.values()) {
			for (const line of state.lines) {
				const id = extractKittyImageId(line);
				if (id !== undefined) oldIds.add(id);
			}
		}

		// Collect IDs from new layouts
		for (const layout of layouts) {
			for (const line of layout.renderedLines) {
				const id = extractKittyImageId(line);
				if (id !== undefined) newIds.add(id);
			}
		}

		// Delete IDs that are no longer present
		let cleanup = "";
		for (const id of oldIds) {
			if (!newIds.has(id)) cleanup += deleteKittyImage(id);
		}
		return cleanup;
	}

	/**
	 * Position the hardware cursor at an absolute row/col.
	 * Used to place cursor at the input area for IME support.
	 *
	 * @param row - 0-indexed row
	 * @param col - 0-indexed column
	 */
	positionCursor(row: number, col: number): void {
		// ANSI cursor positioning is 1-indexed
		this.terminal.write(`\x1b[${row + 1};${col + 1}H`);
	}

	/** Reset all stored state (e.g., after terminal clear or resize) */
	reset(): void {
		this.previousStates.clear();
	}
}
