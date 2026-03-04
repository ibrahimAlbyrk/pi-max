import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

// Gradient depth π symbol using ░▒▓█ characters
const LOGO_LINES = [
	" ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ",
	" ░░░░▓█░░░░░░░▓█░░░░ ",
	"     ▒█       ▒█     ",
	"     ▓█       ▓█     ",
	"     █▓       █▓     ",
	"    ▓██▓     ▓██▓    ",
];

const LOGO_WIDTH = visibleWidth(LOGO_LINES[0]);

// Character density order for dissolve animation (highest → lowest)
const DENSITY_ORDER = ["█", "▓", "▒", "░", "·", " "];

function dissolveChar(ch: string, level: number): string {
	if (ch === " ") return " ";
	const idx = DENSITY_ORDER.indexOf(ch);
	if (idx === -1) return level >= 2 ? " " : ch;
	const newIdx = Math.min(idx + level, DENSITY_ORDER.length - 1);
	return DENSITY_ORDER[newIdx];
}

function dissolveLine(line: string, level: number): string {
	if (level <= 0) return line;
	return Array.from(line)
		.map((ch) => dissolveChar(ch, level))
		.join("");
}

/**
 * Splash screen logo component.
 * Displays a centered ASCII art logo with version, model info, keybinding hints, and tip.
 */
export class SplashLogo implements Component {
	private modelInfo = "";
	private hints = "";
	/** Dim factor for fade-out animation (1 = visible, 0 = hidden) */
	private dimmed = false;
	private hidden = false;

	/** Per-row dissolve levels for shockwave animation (0 = normal, >=5 = gone) */
	private rowDissolveLevels: number[] = [];
	/** Info text dissolve level (0 = normal, 1 = dim, >=2 = hidden) */
	private infoDissolveLevel = 0;

	setModelInfo(modelId: string, provider: string, thinkingLevel?: string): void {
		let info = `${modelId} · ${provider}`;
		if (thinkingLevel) {
			info += ` · ${thinkingLevel}`;
		}
		this.modelInfo = info;
	}

	setHints(hints: string): void {
		this.hints = hints;
	}

	setDimmed(dimmed: boolean): void {
		this.dimmed = dimmed;
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	setRowDissolve(row: number, level: number): void {
		if (this.rowDissolveLevels.length === 0) {
			this.rowDissolveLevels = new Array(LOGO_LINES.length).fill(0);
		}
		if (row >= 0 && row < this.rowDissolveLevels.length) {
			this.rowDissolveLevels[row] = level;
		}
	}

	setInfoDissolve(level: number): void {
		this.infoDissolveLevel = level;
	}

	invalidate(): void {
		// No cache
	}

	render(width: number): string[] {
		if (this.hidden) {
			return [];
		}

		const lines: string[] = [];
		const center = (text: string): string => {
			const w = visibleWidth(text);
			const pad = Math.max(0, Math.floor((width - w) / 2));
			return " ".repeat(pad) + text;
		};

		// Logo
		const isDissolving = this.rowDissolveLevels.length > 0;

		for (let i = 0; i < LOGO_LINES.length; i++) {
			const dissolveLevel = isDissolving ? this.rowDissolveLevels[i] : 0;

			if (dissolveLevel >= 5) {
				lines.push(""); // maintain line count
				continue;
			}

			const line = dissolveLevel > 0 ? dissolveLine(LOGO_LINES[i], dissolveLevel) : LOGO_LINES[i];

			let colorFn: (s: string) => string;
			if (this.dimmed) {
				colorFn = (s: string) => theme.fg("dim", s);
			} else if (dissolveLevel <= 0) {
				colorFn = (s: string) => theme.bold(theme.fg("text", s));
			} else if (dissolveLevel === 1) {
				colorFn = (s: string) => theme.fg("text", s);
			} else if (dissolveLevel === 2) {
				colorFn = (s: string) => theme.fg("muted", s);
			} else {
				colorFn = (s: string) => theme.fg("dim", s);
			}

			lines.push(center(colorFn(line)));
		}

		// Model info
		if (this.modelInfo) {
			lines.push(""); // spacer
			lines.push(""); // spacer
			if (this.infoDissolveLevel >= 2) {
				lines.push(""); // hidden but maintain line
			} else if (this.infoDissolveLevel === 1) {
				lines.push(center(theme.fg("dim", this.modelInfo)));
			} else {
				lines.push(center(theme.fg("muted", this.modelInfo)));
			}
		}

		// Hints
		if (this.hints) {
			lines.push(""); // spacer
			if (this.infoDissolveLevel >= 2) {
				lines.push("");
			} else {
				lines.push(center(theme.fg("dim", this.hints)));
			}
		}

		return lines;
	}
}

/**
 * Get the height of the logo block alone (without info lines).
 */
export function getLogoHeight(): number {
	return LOGO_LINES.length;
}

/**
 * Get the width of the logo.
 */
export function getLogoWidth(): number {
	return LOGO_WIDTH;
}
