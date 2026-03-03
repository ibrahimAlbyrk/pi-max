/**
 * Region-based layout engine for the TUI.
 *
 * Divides the terminal viewport into fixed-height and flex regions.
 * Fixed regions size to their content, flex regions fill remaining space.
 * Regions are ordered top-to-bottom in definition order.
 *
 * Example layout:
 *   ┌──────────────────────┐ row 0
 *   │ FIXED (header)       │ height: content-driven
 *   ├──────────────────────┤
 *   │ FLEX (chat)          │ height: terminal - fixed heights
 *   │ (scrollable)         │
 *   ├──────────────────────┤
 *   │ FIXED (editor+footer)│ height: content-driven
 *   └──────────────────────┘ row termHeight-1
 */

import type { Component } from "./tui.js";

/**
 * Sizing mode for a layout region.
 * - 'fixed': Height determined by rendered content
 * - 'flex': Fills remaining space after fixed regions are allocated
 */
export type RegionSizing = "fixed" | "flex";

/**
 * Defines a layout region — a vertical section of the terminal viewport.
 */
export interface LayoutRegion {
	/** Unique identifier for this region */
	id: string;
	/** Components rendered in this region (stacked vertically) */
	components: Component[];
	/** How this region is sized */
	sizing: RegionSizing;
	/** Whether this region supports managed scrolling (only for flex regions) */
	scrollable?: boolean;
	/** Minimum height in rows (prevents flex regions from collapsing) */
	minHeight?: number;
	/** Maximum height in rows (caps fixed regions that grow too large) */
	maxHeight?: number;
}

/**
 * Computed layout for a single region — absolute positioning within the viewport.
 */
export interface RegionLayout {
	/** Reference to the region definition */
	region: LayoutRegion;
	/** Absolute start row (0-indexed from top of viewport) */
	startRow: number;
	/** Allocated height in rows */
	height: number;
	/** Rendered lines from all components in this region */
	renderedLines: string[];
}

/**
 * Layout engine that divides the terminal viewport into fixed and flex regions.
 *
 * Algorithm:
 * 1. Render all regions → get natural content heights
 * 2. Fixed regions claim their content height (capped by maxHeight)
 * 3. Remaining height distributed among flex regions
 * 4. Absolute row positions assigned in definition order
 */
export class LayoutEngine {
	/**
	 * Calculate layout for all regions.
	 *
	 * @param regions - Region definitions in display order (top to bottom)
	 * @param termWidth - Terminal width in columns
	 * @param termHeight - Terminal height in rows
	 * @returns Computed layout with absolute row positions for each region
	 */
	calculate(regions: LayoutRegion[], termWidth: number, termHeight: number): RegionLayout[] {
		if (regions.length === 0) return [];

		// Step 1: Render all regions to get natural content heights
		const rendered = regions.map((region) => ({
			region,
			lines: this.renderRegion(region, termWidth),
		}));

		// Step 2: Calculate fixed region heights
		let totalFixedHeight = 0;
		const fixedHeights = new Map<number, number>();

		for (let i = 0; i < rendered.length; i++) {
			const { region, lines } = rendered[i];
			if (region.sizing === "fixed") {
				let height = lines.length;
				if (region.maxHeight !== undefined) {
					height = Math.min(height, region.maxHeight);
				}
				fixedHeights.set(i, height);
				totalFixedHeight += height;
			}
		}

		// Step 3: Distribute remaining height among flex regions
		const flexIndices: number[] = [];
		for (let i = 0; i < rendered.length; i++) {
			if (rendered[i].region.sizing === "flex") {
				flexIndices.push(i);
			}
		}

		const flexHeights = new Map<number, number>();
		if (flexIndices.length > 0) {
			const remainingHeight = Math.max(0, termHeight - totalFixedHeight);

			// Apply minHeight constraints first — these are guaranteed allocations
			let guaranteedHeight = 0;
			for (const idx of flexIndices) {
				const min = rendered[idx].region.minHeight ?? 0;
				guaranteedHeight += min;
			}

			// If guaranteed minimums exceed available space, distribute proportionally
			if (guaranteedHeight > remainingHeight) {
				// Proportional distribution when space is severely constrained
				for (const idx of flexIndices) {
					const min = rendered[idx].region.minHeight ?? 0;
					const proportion = guaranteedHeight > 0 ? min / guaranteedHeight : 1 / flexIndices.length;
					flexHeights.set(idx, Math.max(1, Math.floor(remainingHeight * proportion)));
				}
			} else {
				// Normal distribution: minimums satisfied, distribute surplus equally
				const surplus = remainingHeight - guaranteedHeight;
				const baseExtra = Math.floor(surplus / flexIndices.length);
				let leftover = surplus - baseExtra * flexIndices.length;

				for (const idx of flexIndices) {
					const min = rendered[idx].region.minHeight ?? 0;
					let height = min + baseExtra + (leftover > 0 ? 1 : 0);
					if (leftover > 0) leftover--;

					if (rendered[idx].region.maxHeight !== undefined) {
						height = Math.min(height, rendered[idx].region.maxHeight!);
					}

					flexHeights.set(idx, height);
				}
			}
		}

		// Step 4: Assign absolute row positions in definition order
		const layouts: RegionLayout[] = [];
		let currentRow = 0;

		for (let i = 0; i < rendered.length; i++) {
			const { region, lines } = rendered[i];
			const height = region.sizing === "fixed" ? (fixedHeights.get(i) ?? lines.length) : (flexHeights.get(i) ?? 0);

			layouts.push({
				region,
				startRow: currentRow,
				height,
				renderedLines: lines,
			});

			currentRow += height;
		}

		return layouts;
	}

	/**
	 * Render all components in a region to get their combined output lines.
	 */
	private renderRegion(region: LayoutRegion, width: number): string[] {
		const lines: string[] = [];
		for (const component of region.components) {
			lines.push(...component.render(width));
		}
		return lines;
	}
}
