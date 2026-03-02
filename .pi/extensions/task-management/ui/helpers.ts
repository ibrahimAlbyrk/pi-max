/**
 * Shared UI helpers — word wrap, box drawing, truncation
 *
 * All width calculations use visibleWidth() from pi-tui
 * so ANSI escape codes, emoji, and CJK chars are handled correctly.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export function wordWrap(text: string, maxWidth: number): string[] {
	if (visibleWidth(text) <= maxWidth) return [text];

	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (visibleWidth(current) + 1 + visibleWidth(word) <= maxWidth) {
			current += " " + word;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

export function padRight(text: string, len: number): string {
	const visible = visibleWidth(text);
	if (visible >= len) return truncateToWidth(text, len, "…");
	return text + " ".repeat(len - visible);
}

export function truncate(text: string, maxLen: number): string {
	if (visibleWidth(text) <= maxLen) return text;
	return truncateToWidth(text, maxLen, "…");
}

export function horizontalLine(width: number, theme: Theme): string {
	return theme.fg("borderMuted", "─".repeat(width));
}

export function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
			" " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
	} catch {
		return iso;
	}
}

export function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
	} catch {
		return iso;
	}
}

/** Short date format: "Feb 25" (no time) */
export function formatDateShort(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	} catch {
		return iso;
	}
}

export const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
