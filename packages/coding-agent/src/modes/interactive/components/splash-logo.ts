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

/**
 * Splash screen logo component.
 * Displays a centered ASCII art logo with version, model info, keybinding hints, and tip.
 */
export class SplashLogo implements Component {
	private modelInfo = "";
	private hints = "";
	private tip = "";

	/** Dim factor for fade-out animation (1 = visible, 0 = hidden) */
	private dimmed = false;
	private hidden = false;

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

	setTip(tip: string): void {
		this.tip = tip;
	}

	setDimmed(dimmed: boolean): void {
		this.dimmed = dimmed;
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
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
		const colorFn = this.dimmed ? (s: string) => theme.fg("dim", s) : (s: string) => theme.bold(theme.fg("text", s));

		for (const line of LOGO_LINES) {
			lines.push(center(colorFn(line)));
		}

		// Model info
		if (this.modelInfo) {
			lines.push(""); // spacer
			lines.push(""); // spacer
			lines.push(center(theme.fg("muted", this.modelInfo)));
		}

		// Hints
		if (this.hints) {
			lines.push(""); // spacer
			lines.push(center(theme.fg("dim", this.hints)));
		}

		// Tip
		if (this.tip) {
			lines.push(""); // spacer
			lines.push(center(theme.fg("dim", this.tip)));
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
