/**
 * Selection and hover highlight renderer.
 *
 * Two approaches:
 * - Selection: sliceByColumn (needs full segment replacement for bg)
 * - Hover: inject ANSI codes at byte positions (preserves all original codes intact)
 */

import { extractAnsiCode, visibleWidth } from "../utils.js";

// Selection background: #264F78 (VS Code dark selection — proven, easy on the eyes)
const SELECTION_BG = "\x1b[48;2;38;79;120m";
// Reset only background to default (preserves fg and other attributes)
const SELECTION_BG_RESET = "\x1b[49m";

// Link hover: colored underline + subtle bg + bold (brightens fg ~30%)
// \x1b[4:1m = straight underline, \x1b[58;2;R;G;Bm = underline color
const HOVER_UNDERLINE = "\x1b[4:1m\x1b[58;2;108;182;255m";
const HOVER_UNDERLINE_OFF = "\x1b[4:0m\x1b[59m";
const HOVER_BG = "\x1b[48;2;35;45;60m";
const HOVER_BG_RESET = "\x1b[49m";
const HOVER_BOLD = "\x1b[1m";
const HOVER_BOLD_OFF = "\x1b[22m";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Apply selection highlight to a rendered line.
 *
 * Uses injection approach (like hover): walks the line and injects
 * SELECTION_BG at startCol, restores original bg at endCol.
 * This preserves all original ANSI/OSC codes and background colors.
 */
export function applySelectionHighlight(line: string, startCol: number, endCol: number, lineWidth: number): string {
	if (startCol >= endCol || lineWidth === 0 || !line) return line;

	const actualStart = Math.max(0, startCol);
	const actualEnd = Math.min(endCol, lineWidth);
	if (actualStart >= actualEnd) return line;

	let result = "";
	let visibleCol = 0;
	let injectedStart = false;
	let injectedEnd = false;
	let activeBg = "";
	let i = 0;

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			result += ansi.code;
			trackBgFromCode(ansi.code, (bg) => {
				activeBg = bg;
			});
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			if (!injectedStart && visibleCol >= actualStart) {
				result += SELECTION_BG;
				injectedStart = true;
			}

			if (!injectedEnd && visibleCol >= actualEnd) {
				result += activeBg || SELECTION_BG_RESET;
				injectedEnd = true;
			}

			result += segment;
			visibleCol += visibleWidth(segment);
		}

		i = textEnd;
	}

	if (injectedStart && !injectedEnd) {
		result += activeBg || SELECTION_BG_RESET;
	}

	return result;
}

/**
 * Apply hover highlight to a link region in a rendered line.
 *
 * Walks the line and injects HOVER_BG at startCol and restores the
 * original background at endCol. Tracks active bg state so we restore
 * the correct background (not just default) after hover.
 */
export function applyLinkHoverHighlight(line: string, startCol: number, endCol: number, _lineWidth: number): string {
	if (startCol >= endCol || !line) return line;

	let result = "";
	let visibleCol = 0;
	let injectedStart = false;
	let injectedEnd = false;
	let activeBg = "";
	let activeUnderline = false;
	let activeBold = false;
	let i = 0;

	while (i < line.length) {
		// Pass through ANSI codes, tracking bg/underline/bold state
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			result += ansi.code;
			trackBgFromCode(ansi.code, (bg) => {
				activeBg = bg;
			});
			trackUnderlineFromCode(ansi.code, (ul) => {
				activeUnderline = ul;
			});
			trackBoldFromCode(ansi.code, (b) => {
				activeBold = b;
			});
			i += ansi.length;
			continue;
		}

		// Find extent of non-ANSI text
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		const textPortion = line.slice(i, textEnd);
		for (const { segment } of segmenter.segment(textPortion)) {
			// Inject hover start: bold + colored underline + subtle bg
			if (!injectedStart && visibleCol >= startCol) {
				result += `${HOVER_BOLD}${HOVER_BG}${HOVER_UNDERLINE}`;
				injectedStart = true;
			}

			// Inject hover end: restore original bg + underline + bold state
			if (!injectedEnd && visibleCol >= endCol) {
				const bgRestore = activeBg || HOVER_BG_RESET;
				const ulRestore = activeUnderline ? "\x1b[4m" : HOVER_UNDERLINE_OFF;
				const boldRestore = activeBold ? "" : HOVER_BOLD_OFF;
				result += `${bgRestore}${ulRestore}${boldRestore}`;
				injectedEnd = true;
			}

			result += segment;
			visibleCol += visibleWidth(segment);
		}

		i = textEnd;
	}

	// If endCol was at or past the end of visible content
	if (injectedStart && !injectedEnd) {
		const bgRestore = activeBg || HOVER_BG_RESET;
		const boldRestore = activeBold ? "" : HOVER_BOLD_OFF;
		result += `${bgRestore}${HOVER_UNDERLINE_OFF}${boldRestore}`;
	}

	return result;
}

/**
 * Track bold state changes from an SGR ANSI code.
 */
function trackBoldFromCode(code: string, onBold: (active: boolean) => void): void {
	if (!code.endsWith("m")) return;
	const match = code.match(/\x1b\[([\d;]*)m/);
	if (!match) return;

	const params = match[1];
	if (params === "" || params === "0") {
		onBold(false);
		return;
	}

	for (const p of params.split(";")) {
		const c = parseInt(p, 10);
		if (c === 1) onBold(true);
		else if (c === 22) onBold(false);
	}
}

/**
 * Track underline state changes from an SGR ANSI code.
 */
function trackUnderlineFromCode(code: string, onUl: (active: boolean) => void): void {
	if (!code.endsWith("m")) return;
	const match = code.match(/\x1b\[([\d;:]*)m/);
	if (!match) return;

	const params = match[1];
	if (params === "" || params === "0") {
		onUl(false);
		return;
	}

	// Handle colon-separated params (e.g., 4:1, 4:0)
	if (params.includes(":")) {
		const parts = params.split(":");
		if (parts[0] === "4") {
			onUl(parts[1] !== "0");
		}
		return;
	}

	for (const p of params.split(";")) {
		const c = parseInt(p, 10);
		if (c === 4) onUl(true);
		else if (c === 24) onUl(false);
	}
}

/**
 * Extract background color changes from an SGR ANSI code.
 * Calls `onBg` with the code to restore the background, or "" for default.
 */
function trackBgFromCode(code: string, onBg: (bg: string) => void): void {
	if (!code.endsWith("m")) return;
	const match = code.match(/\x1b\[([\d;]*)m/);
	if (!match) return;

	const params = match[1];
	if (params === "" || params === "0") {
		// Full reset — background goes to default
		onBg("");
		return;
	}

	const parts = params.split(";");
	let i = 0;
	while (i < parts.length) {
		const c = parseInt(parts[i], 10);
		if (c === 48) {
			// 48;5;N or 48;2;R;G;B — capture the full bg code
			if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
				onBg(`\x1b[48;5;${parts[i + 2]}m`);
				i += 3;
				continue;
			}
			if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
				onBg(`\x1b[48;2;${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}m`);
				i += 5;
				continue;
			}
		} else if (c === 49) {
			onBg("");
			i++;
			continue;
		} else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) {
			onBg(`\x1b[${c}m`);
			i++;
			continue;
		}
		i++;
	}
}
