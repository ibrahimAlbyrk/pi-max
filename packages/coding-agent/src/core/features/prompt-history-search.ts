/**
 * Built-in prompt history search feature.
 *
 * Provides a fuzzy-searchable overlay of all past user prompts across sessions.
 * Activated via Alt+R or the /history command.
 * Selecting an entry inserts it into the editor.
 *
 * Call registerPromptHistoryCommands(pi) once after the extension runner is set up.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { getSessionsDir } from "../../config.js";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.js";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.js";
import type { SessionMessageEntry } from "../session-manager.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PromptEntry {
	/** Full prompt text. */
	text: string;
	/** Template/skill command (e.g., "/git:commit staged only"). */
	originalCommand?: string;
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** Source JSONL file path. */
	sessionFile: string;
}

interface FileCache {
	/** File modification time in ms. */
	mtime: number;
	/** Parsed prompts from this file. */
	prompts: PromptEntry[];
}

// ── Module-level cache state ──────────────────────────────────────────────────

/** Per-file mtime cache: sessionFile → FileCache */
const fileCache = new Map<string, FileCache>();

/** Deduplicated, sorted prompt list (rebuilt on demand). */
let cachedPrompts: PromptEntry[] = [];

/** Set to false by invalidateCache(); next showHistorySearch triggers rebuild. */
let cacheValid = false;

// ── JSONL parsing ─────────────────────────────────────────────────────────────

/**
 * Extract user prompts from a single JSONL session file.
 * Skips malformed lines gracefully.
 */
function parseSessionFile(filePath: string): PromptEntry[] {
	const prompts: PromptEntry[] = [];
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry: unknown = JSON.parse(line);
				if (typeof entry !== "object" || entry === null || (entry as Record<string, unknown>).type !== "message") {
					continue;
				}

				const record = entry as Record<string, unknown>;
				const msg = record.message as Record<string, unknown> | undefined;
				if (!msg || msg.role !== "user") continue;

				const textParts: string[] = [];
				const content = msg.content;
				if (typeof content === "string") {
					if (content.trim()) textParts.push(content);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							(part as Record<string, unknown>).type === "text" &&
							typeof (part as Record<string, unknown>).text === "string"
						) {
							textParts.push((part as Record<string, unknown>).text as string);
						}
					}
				}

				if (textParts.length > 0) {
					const originalCommand = typeof msg.originalCommand === "string" ? msg.originalCommand : undefined;
					const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString();

					prompts.push({
						text: textParts.join("\n"),
						originalCommand,
						timestamp,
						sessionFile: filePath,
					});
				}
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		// Skip unreadable files
	}
	return prompts;
}

// ── Session file discovery ────────────────────────────────────────────────────

/**
 * Recursively scan the sessions directory for all `.jsonl` files.
 */
function getAllSessionFiles(): string[] {
	const sessionsDir = getSessionsDir();
	if (!existsSync(sessionsDir)) return [];

	const files: string[] = [];
	try {
		const cwdDirs = readdirSync(sessionsDir);
		for (const dir of cwdDirs) {
			const dirPath = join(sessionsDir, dir);
			try {
				const dirStat = statSync(dirPath);
				if (!dirStat.isDirectory()) continue;

				const sessionFiles = readdirSync(dirPath);
				for (const file of sessionFiles) {
					if (file.endsWith(".jsonl")) {
						files.push(join(dirPath, file));
					}
				}
			} catch {
				// Skip unreadable directories
			}
		}
	} catch {
		// Sessions dir unreadable
	}
	return files;
}

// ── Cache management ──────────────────────────────────────────────────────────

/**
 * Rebuild the deduplicated prompt cache.
 *
 * Strategy:
 * 1. Scan all session files; only re-parse those with changed mtime.
 * 2. Merge active-session prompts from sessionManager (no disk I/O).
 * 3. Deduplicate by originalCommand (if present) or first 200 chars of text.
 * 4. Sort by timestamp descending; limit to 1000 entries.
 */
function rebuildCache(ctx: ExtensionContext): PromptEntry[] {
	if (cacheValid) return cachedPrompts;

	const allFiles = getAllSessionFiles();
	const activeSessionFile = ctx.sessionManager.getSessionFile();

	// Update cache for new/changed files; skip active session file
	for (const filePath of allFiles) {
		if (filePath === activeSessionFile) continue;
		try {
			const fileStat = statSync(filePath);
			const mtime = fileStat.mtimeMs;
			const cached = fileCache.get(filePath);
			if (cached && cached.mtime === mtime) continue;

			const prompts = parseSessionFile(filePath);
			fileCache.set(filePath, { mtime, prompts });
		} catch {
			// Skip unreadable files
		}
	}

	// Remove stale cache entries for deleted files
	const fileSet = new Set(allFiles);
	for (const key of fileCache.keys()) {
		if (!fileSet.has(key)) {
			fileCache.delete(key);
		}
	}

	// Collect all on-disk prompts from cache
	const allPrompts: PromptEntry[] = [];
	for (const cached of fileCache.values()) {
		allPrompts.push(...cached.prompts);
	}

	// Merge active session prompts (in-memory, no disk I/O)
	const entries = ctx.sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message;

		// Narrow to user messages
		if (!("role" in msg) || msg.role !== "user") continue;

		const textParts: string[] = [];
		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim()) textParts.push(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string"
				) {
					textParts.push(part.text);
				}
			}
		}

		if (textParts.length > 0) {
			const originalCommand =
				"originalCommand" in msg && typeof msg.originalCommand === "string" ? msg.originalCommand : undefined;

			allPrompts.push({
				text: textParts.join("\n"),
				originalCommand,
				timestamp: entry.timestamp,
				sessionFile: activeSessionFile ?? "",
			});
		}
	}

	// Deduplicate: key = originalCommand (lowercased) or first 200 chars of text
	// Keep most-recent entry per key.
	const dedupeMap = new Map<string, PromptEntry>();
	for (const p of allPrompts) {
		const key =
			p.originalCommand !== undefined ? p.originalCommand.toLowerCase() : p.text.trim().toLowerCase().slice(0, 200);
		const existing = dedupeMap.get(key);
		if (!existing || p.timestamp > existing.timestamp) {
			dedupeMap.set(key, p);
		}
	}

	// Sort by timestamp descending (newest first), cap at 1000
	cachedPrompts = [...dedupeMap.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 1000);

	cacheValid = true;
	return cachedPrompts;
}

/**
 * Invalidate the cache so the next call to showHistorySearch triggers a rebuild.
 */
function invalidateCache(): void {
	cacheValid = false;
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Word-based AND fuzzy match: every space-separated word in `query`
 * must appear somewhere in `text` (case-insensitive).
 */
function fuzzyMatch(text: string, query: string): boolean {
	const lower = text.toLowerCase();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return words.every((w) => lower.includes(w));
}

/** Build the searchable string for a prompt (includes originalCommand when present). */
function searchableText(p: PromptEntry): string {
	return p.originalCommand !== undefined ? `${p.originalCommand} ${p.text}` : p.text;
}

// ── Timestamp display ─────────────────────────────────────────────────────────

/**
 * Format a timestamp for display:
 * "just now" | "5m ago" | "2h ago" | "3d ago" | locale date string
 */
function formatTimestamp(ts: string): string {
	try {
		const d = new Date(ts);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMins = Math.floor(diffMs / 60_000);
		const diffHours = Math.floor(diffMs / 3_600_000);
		const diffDays = Math.floor(diffMs / 86_400_000);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return d.toLocaleDateString();
	} catch {
		return "";
	}
}

// ── SelectItem construction ───────────────────────────────────────────────────

/**
 * Build a SelectItem list from prompts, applying an optional filter query.
 */
function buildItems(prompts: PromptEntry[], query: string): SelectItem[] {
	const filtered = query ? prompts.filter((p) => fuzzyMatch(searchableText(p), query)) : prompts;

	return filtered.map((p) => {
		let value: string;
		let label: string;

		if (p.originalCommand !== undefined) {
			value = p.originalCommand;
			label = p.originalCommand;
		} else {
			const preview = p.text.replace(/\n/g, " ").trim();
			value = p.text;
			label = preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
		}

		return { value, label, description: formatTimestamp(p.timestamp) };
	});
}

// ── TUI overlay ───────────────────────────────────────────────────────────────

/**
 * Show the prompt history search overlay.
 * Returns the selected prompt text, or null if cancelled.
 */
export async function showHistorySearch(ctx: ExtensionContext): Promise<string | null> {
	const prompts = rebuildCache(ctx);

	if (prompts.length === 0) {
		ctx.ui.notify("No prompt history found", "info");
		return null;
	}

	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		let filterText = "";
		let currentItems = buildItems(prompts, "");

		const container = new Container();
		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const title = new Text(theme.fg("accent", theme.bold(" Prompt History")), 0, 0);
		const hint = new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"), 0, 0);
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

		const selectListTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		};

		let activeSelectList = new SelectList(currentItems, Math.min(currentItems.length, 12), selectListTheme);
		activeSelectList.onSelect = (item) => done(item.value);
		activeSelectList.onCancel = () => done(null);

		function buildContainer(): void {
			container.clear();

			const searchText = filterText
				? theme.fg("accent", " search: ") + theme.bold(filterText) + theme.fg("dim", "█")
				: theme.fg("accent", " search: ") + theme.fg("muted", "type to filter...");

			container.addChild(topBorder);
			container.addChild(title);
			container.addChild(new Text(searchText, 0, 0));
			container.addChild(activeSelectList);
			container.addChild(hint);
			container.addChild(bottomBorder);
		}

		buildContainer();

		function rebuildList(): void {
			currentItems = buildItems(prompts, filterText);
			const newList = new SelectList(currentItems, Math.min(Math.max(currentItems.length, 1), 12), selectListTheme);
			newList.onSelect = (item) => done(item.value);
			newList.onCancel = () => done(null);
			activeSelectList = newList;
			buildContainer();
		}

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// Escape — cancel
				if (matchesKey(data, "escape")) {
					done(null);
					return;
				}

				// Backspace — remove last filter char
				if (matchesKey(data, "backspace") || data === "\x7f") {
					if (filterText.length > 0) {
						filterText = filterText.slice(0, -1);
						rebuildList();
						tui.requestRender();
					}
					return;
				}

				// Up / Down / Enter — delegate to the active SelectList
				if (
					matchesKey(data, "up") ||
					matchesKey(data, "down") ||
					matchesKey(data, "enter") ||
					matchesKey(data, "return")
				) {
					activeSelectList.handleInput(data);
					tui.requestRender();
					return;
				}

				// Printable characters — append to filter
				if (data.length === 1 && data >= " ") {
					filterText += data;
					rebuildList();
					tui.requestRender();
					return;
				}

				// Pass anything else to the SelectList
				activeSelectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ── Editor integration ────────────────────────────────────────────────────────

/**
 * Insert the selected prompt text into the editor and force a TUI re-render
 * via a brief status toggle.
 */
export function applySelection(ctx: ExtensionContext, text: string): void {
	ctx.ui.setEditorText(text);
	// setEditorText alone doesn't trigger a render cycle; toggling a status
	// entry forces the TUI to re-render.
	ctx.ui.setStatus("_history", " ");
	ctx.ui.setStatus("_history", undefined);
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the /history command and turn_end cache-invalidation hook
 * via the extension API.
 *
 * The Alt+R shortcut is handled via the configurable keybinding system
 * (historySearch app action) rather than pi.registerShortcut, so it
 * can be remapped by the user. See interactive-mode.ts for the action handler.
 *
 * Usage:
 *   extensionRunner.registerBuiltinExtension("<builtin-prompt-history>", registerPromptHistoryCommands)
 */
export function registerPromptHistoryCommands(pi: ExtensionAPI): void {
	// Invalidate cache after each turn so new prompts are picked up next time.
	pi.on("turn_end", async () => {
		invalidateCache();
	});

	// /history command
	pi.registerCommand("history", {
		description: "Search prompt history",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("History search requires interactive mode", "error");
				return;
			}
			const selected = await showHistorySearch(ctx);
			if (selected) applySelection(ctx, selected);
		},
	});
}
