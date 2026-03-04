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
			// Full repaint: delete all Kitty graphics + clear screen
			if (isKitty) buffer += deleteAllKittyImages();
			buffer += "\x1b[2J"; // Clear screen (not scrollback)
			for (const layout of layouts) {
				buffer += this.paintRegion(layout, termWidth);
				this.saveState(layout);
			}
		} else {
			// Find dirty image IDs: images with any tile that changed position.
			// Delete ALL placements for dirty images, then force-render all their tiles.
			const dirtyImageIds = new Set<number>();
			if (isKitty) {
				for (const layout of layouts) {
					const prev = this.previousStates.get(layout.region.id);
					if (prev) {
						this.collectDirtyImageIds(layout, prev, dirtyImageIds);
					}
				}
				// Also check removed regions
				const currentIds = new Set(layouts.map((l) => l.region.id));
				for (const [id, state] of this.previousStates) {
					if (!currentIds.has(id)) {
						for (const line of state.lines) {
							const imgId = extractKittyImageId(line);
							if (imgId !== undefined) dirtyImageIds.add(imgId);
						}
					}
				}
				for (const id of dirtyImageIds) {
					buffer += deleteKittyImage(id);
				}
			}

			// Differential: only repaint changed regions/lines
			for (const layout of layouts) {
				const prev = this.previousStates.get(layout.region.id);
				if (prev && prev.startRow === layout.startRow && prev.height === layout.height) {
					buffer += this.paintRegionDiff(layout, prev, termWidth, dirtyImageIds);
				} else {
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
	 */
	private paintRegion(layout: RegionLayout, termWidth: number): string {
		let buffer = "";
		const { startRow, height, renderedLines } = layout;

		for (let i = 0; i < height; i++) {
			const row = startRow + i + 1;
			const line = i < renderedLines.length ? renderedLines[i] : "";
			buffer += `\x1b[${row};1H\x1b[2K`;
			if (line.length > 0) {
				this.validateLineWidth(line, termWidth, layout.region.id, i);
				buffer += isImageLine(line) ? line : line + LINE_RESET;
			}
		}

		return buffer;
	}

	/**
	 * Paint only changed lines within a region (differential rendering).
	 * Also force-renders lines whose image ID is in the dirty set.
	 */
	private paintRegionDiff(
		layout: RegionLayout,
		prev: RegionState,
		termWidth: number,
		dirtyImageIds: Set<number>,
	): string {
		let buffer = "";
		const { startRow, height, renderedLines } = layout;

		for (let i = 0; i < height; i++) {
			const newLine = i < renderedLines.length ? renderedLines[i] : "";
			const oldLine = i < prev.lines.length ? prev.lines[i] : "";

			// Force-render if this line's image was deleted (dirty)
			const lineId = extractKittyImageId(newLine);
			const isDirtyImage = lineId !== undefined && dirtyImageIds.has(lineId);

			if (newLine !== oldLine || isDirtyImage) {
				const row = startRow + i + 1;
				buffer += `\x1b[${row};1H\x1b[2K`;
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
	 * Collect image IDs that have any changed tiles between old and new state.
	 */
	private collectDirtyImageIds(layout: RegionLayout, prev: RegionState, dirtyIds: Set<number>): void {
		const height = Math.max(layout.height, prev.height);
		for (let i = 0; i < height; i++) {
			const newLine = i < layout.renderedLines.length ? layout.renderedLines[i] : "";
			const oldLine = i < prev.lines.length ? prev.lines[i] : "";
			if (newLine !== oldLine) {
				const oldId = extractKittyImageId(oldLine);
				const newId = extractKittyImageId(newLine);
				if (oldId !== undefined) dirtyIds.add(oldId);
				if (newId !== undefined) dirtyIds.add(newId);
			}
		}
	}

	positionCursor(row: number, col: number): void {
		this.terminal.write(`\x1b[${row + 1};${col + 1}H`);
	}

	reset(): void {
		this.previousStates.clear();
	}
}
