/**
 * Prompt History Search Extension
 *
 * Search through past prompts across all sessions.
 * Press alt+r to open the search overlay, type to filter, enter to select,
 * esc to cancel.
 *
 * Also available via /history command.
 *
 * Template/skill prompts are identified via the `originalCommand` field
 * stored in UserMessage by the core (e.g., "/git:commit staged only").
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

interface PromptEntry {
	text: string;
	originalCommand?: string;
	timestamp: string;
	sessionFile: string;
}

interface FileCache {
	mtime: number;
	prompts: PromptEntry[];
}

// In-memory cache: sessionFile -> FileCache
const fileCache = new Map<string, FileCache>();

// Deduplicated prompt list (rebuilt on cache update)
let cachedPrompts: PromptEntry[] = [];
let cacheValid = false;

/**
 * Extract user prompts from a single JSONL file.
 */
function parseSessionFile(filePath: string): PromptEntry[] {
	const prompts: PromptEntry[] = [];
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || msg.role !== "user") continue;

				const textParts: string[] = [];
				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text" && typeof part.text === "string") {
							textParts.push(part.text);
						}
					}
				}

				if (textParts.length > 0) {
					prompts.push({
						text: textParts.join("\n"),
						originalCommand: msg.originalCommand,
						timestamp: entry.timestamp,
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

/**
 * Get all JSONL session files from the sessions directory.
 */
function getAllSessionFiles(): string[] {
	const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	if (!existsSync(sessionsDir)) return [];

	const files: string[] = [];
	try {
		const cwdDirs = readdirSync(sessionsDir);
		for (const dir of cwdDirs) {
			const dirPath = join(sessionsDir, dir);
			try {
				const stat = statSync(dirPath);
				if (!stat.isDirectory()) continue;

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

/**
 * Rebuild the prompt cache using mtime-based incremental updates.
 * Active session entries are merged from sessionManager to avoid disk I/O.
 */
function rebuildCache(ctx: ExtensionContext): PromptEntry[] {
	if (cacheValid) return cachedPrompts;

	const allFiles = getAllSessionFiles();
	const activeSessionFile = ctx.sessionManager.getSessionFile();

	// Update cache for files with changed mtime or new files
	for (const filePath of allFiles) {
		// Skip active session file — we'll use sessionManager for that
		if (filePath === activeSessionFile) continue;

		try {
			const stat = statSync(filePath);
			const mtime = stat.mtimeMs;
			const cached = fileCache.get(filePath);

			if (cached && cached.mtime === mtime) continue;

			// Parse and cache
			const prompts = parseSessionFile(filePath);
			fileCache.set(filePath, { mtime, prompts });
		} catch {
			// Skip
		}
	}

	// Remove stale cache entries for deleted files
	const fileSet = new Set(allFiles);
	for (const key of fileCache.keys()) {
		if (!fileSet.has(key)) {
			fileCache.delete(key);
		}
	}

	// Collect all prompts from cache
	const allPrompts: PromptEntry[] = [];
	for (const cached of fileCache.values()) {
		allPrompts.push(...cached.prompts);
	}

	// Add active session prompts from sessionManager (no disk I/O)
	const entries = ctx.sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "user") continue;

		const textParts: string[] = [];
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
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
			const originalCommand = "originalCommand" in msg ? (msg.originalCommand as string) : undefined;
			allPrompts.push({
				text: textParts.join("\n"),
				originalCommand,
				timestamp: entry.timestamp,
				sessionFile: activeSessionFile,
			});
		}
	}

	// Dedupe: keep most recent occurrence of each unique prompt
	const dedupeMap = new Map<string, PromptEntry>();
	for (const p of allPrompts) {
		// Use originalCommand as key if available, otherwise first 200 chars of text
		const key = p.originalCommand?.toLowerCase() ?? p.text.trim().toLowerCase().slice(0, 200);
		const existing = dedupeMap.get(key);
		if (!existing || p.timestamp > existing.timestamp) {
			dedupeMap.set(key, p);
		}
	}

	// Sort by timestamp descending (most recent first), limit to 1000
	cachedPrompts = [...dedupeMap.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 1000);

	cacheValid = true;
	return cachedPrompts;
}

/**
 * Invalidate cache so next access triggers a refresh.
 */
function invalidateCache(): void {
	cacheValid = false;
}

/**
 * Format timestamp for display.
 */
function formatTimestamp(ts: string): string {
	try {
		const d = new Date(ts);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return d.toLocaleDateString();
	} catch {
		return "";
	}
}

/**
 * Simple fuzzy match: all query words must appear in the text (case-insensitive).
 */
function fuzzyMatch(text: string, query: string): boolean {
	const lowerText = text.toLowerCase();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return words.every((word) => lowerText.includes(word));
}

/**
 * Build searchable text for a prompt (includes originalCommand if available).
 */
function searchableText(p: PromptEntry): string {
	return p.originalCommand ? `${p.originalCommand} ${p.text}` : p.text;
}

/**
 * Build SelectItem list from prompts, applying optional filter.
 */
function buildItems(prompts: PromptEntry[], query: string): SelectItem[] {
	const filtered = query ? prompts.filter((p) => fuzzyMatch(searchableText(p), query)) : prompts;
	return filtered.map((p) => {
		let value: string;
		let label: string;
		if (p.originalCommand) {
			value = p.originalCommand;
			label = p.originalCommand;
		} else {
			const preview = p.text.replace(/\n/g, " ").trim();
			value = p.text;
			label = preview.length > 80 ? preview.slice(0, 77) + "..." : preview;
		}
		return {
			value,
			label,
			description: formatTimestamp(p.timestamp),
		};
	});
}

/**
 * Show the prompt history search overlay.
 * Returns the selected prompt text, or null if cancelled.
 */
async function showHistorySearch(ctx: ExtensionContext): Promise<string | null> {
	const prompts = rebuildCache(ctx);

	if (prompts.length === 0) {
		ctx.ui.notify("No prompt history found", "info");
		return null;
	}

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let filterText = "";
		let currentItems = buildItems(prompts, "");

		const container = new Container();
		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const title = new Text(theme.fg("accent", theme.bold(" Prompt History")), 0, 0);
		let searchLine = new Text(theme.fg("accent", " search: ") + theme.fg("muted", "type to filter..."), 0, 0);

		const selectList = new SelectList(currentItems, Math.min(currentItems.length, 12), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		const hint = new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"), 0, 0);
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

		container.addChild(topBorder);
		container.addChild(title);
		container.addChild(searchLine);
		container.addChild(selectList);
		container.addChild(hint);
		container.addChild(bottomBorder);

		function rebuildSelectList(): void {
			currentItems = buildItems(prompts, filterText);
			container.clear();
			const newSearchLine = filterText
				? new Text(theme.fg("accent", " search: ") + theme.bold(filterText) + theme.fg("dim", "█"), 0, 0)
				: new Text(theme.fg("accent", " search: ") + theme.fg("muted", "type to filter..."), 0, 0);
			searchLine = newSearchLine;

			const newSelectList = new SelectList(currentItems, Math.min(Math.max(currentItems.length, 1), 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			newSelectList.onSelect = (item) => done(item.value);
			newSelectList.onCancel = () => done(null);

			container.addChild(topBorder);
			container.addChild(title);
			container.addChild(searchLine);
			container.addChild(newSelectList);
			container.addChild(hint);
			container.addChild(bottomBorder);

			// Update reference for handleInput
			activeSelectList = newSelectList;
		}

		let activeSelectList = selectList;

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// Escape — cancel
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}

				// Backspace — remove last char from filter
				if (matchesKey(data, Key.backspace) || data === "\x7f") {
					if (filterText.length > 0) {
						filterText = filterText.slice(0, -1);
						rebuildSelectList();
						tui.requestRender();
					}
					return;
				}

				// Up/Down/Enter — delegate to SelectList
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
					activeSelectList.handleInput(data);
					tui.requestRender();
					return;
				}

				// Printable characters — add to filter
				if (data.length === 1 && data >= " ") {
					filterText += data;
					rebuildSelectList();
					tui.requestRender();
					return;
				}

				// Pass anything else to selectList
				activeSelectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Apply selected prompt to editor and force a render via status flicker.
 */
function applySelection(ctx: ExtensionContext, text: string): void {
	ctx.ui.setEditorText(text);
	// setEditorText doesn't trigger a TUI render. Toggle a status entry to force it.
	ctx.ui.setStatus("_history", " ");
	ctx.ui.setStatus("_history", undefined);
}

export default function (pi: ExtensionAPI) {
	// Invalidate cache on each turn so new prompts are picked up
	pi.on("turn_end", async () => {
		invalidateCache();
	});

	// alt+r shortcut
	pi.registerShortcut(Key.alt("r"), {
		description: "Search prompt history",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const selected = await showHistorySearch(ctx);
			if (selected) {
				applySelection(ctx, selected);
			}
		},
	});

	// /history command
	pi.registerCommand("history", {
		description: "Search prompt history",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			const selected = await showHistorySearch(ctx);
			if (selected) {
				applySelection(ctx, selected);
			}
		},
	});
}
