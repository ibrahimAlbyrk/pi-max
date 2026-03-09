/**
 * Built-in prompt URL widget feature.
 *
 * Detects GitHub PR/Issue URLs in user prompts and displays a persistent
 * widget with metadata (title, author) fetched via the `gh` CLI. Also sets
 * the session name to include the PR/Issue title.
 *
 * Supported prompt patterns:
 *   - "You are given one or more GitHub PR URLs: <url>"
 *   - "Analyze GitHub issue(s): <url>"
 *
 * Call registerPromptUrlWidget(pi) once after the extension runner is set up.
 */

import { execFile } from "node:child_process";
import type { TextContent } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.js";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.js";
import type { SessionMessageEntry } from "../session-manager.js";

// ── Detection patterns ────────────────────────────────────────────────────────

const PR_PROMPT_PATTERN = /^\s*You are given one or more GitHub PR URLs:\s*(\S+)/im;
const ISSUE_PROMPT_PATTERN = /^\s*Analyze GitHub issue\(s\):\s*(\S+)/im;

type PromptMatch = {
	kind: "pr" | "issue";
	url: string;
};

// ── Metadata types ────────────────────────────────────────────────────────────

type GhMetadata = {
	title?: string;
	author?: {
		login?: string;
		name?: string | null;
	};
};

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Detect a PR or Issue URL in the given prompt text.
 * Returns the first match found, or undefined if no pattern matches.
 */
function extractPromptMatch(prompt: string): PromptMatch | undefined {
	const prMatch = prompt.match(PR_PROMPT_PATTERN);
	if (prMatch?.[1]) {
		return { kind: "pr", url: prMatch[1].trim() };
	}

	const issueMatch = prompt.match(ISSUE_PROMPT_PATTERN);
	if (issueMatch?.[1]) {
		return { kind: "issue", url: issueMatch[1].trim() };
	}

	return undefined;
}

// ── Metadata fetch ────────────────────────────────────────────────────────────

/**
 * Fetch PR or Issue metadata via the `gh` CLI.
 *
 * Uses child_process.execFile directly (not pi.exec) because built-in
 * extensions cannot use pi.exec without throwing. Returns undefined on any
 * error (gh not installed, auth failure, network, timeout).
 */
function fetchGhMetadata(kind: PromptMatch["kind"], url: string): Promise<GhMetadata | undefined> {
	const args =
		kind === "pr" ? ["pr", "view", url, "--json", "title,author"] : ["issue", "view", url, "--json", "title,author"];

	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 10_000);

		execFile("gh", args, { encoding: "utf-8" }, (error, stdout) => {
			clearTimeout(timer);
			if (error || !stdout) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(stdout) as GhMetadata);
			} catch {
				resolve(undefined);
			}
		});
	});
}

// ── Author formatting ─────────────────────────────────────────────────────────

/**
 * Format a gh author object into a display string.
 * Formats: "Name (@login)" | "@login" | "Name" | undefined
 */
function formatAuthor(author?: GhMetadata["author"]): string | undefined {
	if (!author) return undefined;
	const name = author.name?.trim();
	const login = author.login?.trim();
	if (name && login) return `${name} (@${login})`;
	if (login) return `@${login}`;
	if (name) return name;
	return undefined;
}

// ── Widget rendering ──────────────────────────────────────────────────────────

/**
 * Set (or update) the "prompt-url" widget in the UI.
 *
 * Renders a DynamicBorder + Text widget below the editor showing:
 *   - Title (or URL if metadata not yet available) in accent color
 *   - Author in muted color (omitted if unavailable)
 *   - URL in dim color
 */
function setWidget(ctx: ExtensionContext, match: PromptMatch, title?: string, authorText?: string): void {
	ctx.ui.setWidget("prompt-url", (_tui, thm) => {
		const titleLine = title ? thm.fg("accent", title) : thm.fg("accent", match.url);
		const authorLine = authorText ? thm.fg("muted", authorText) : undefined;
		const urlLine = thm.fg("dim", match.url);

		const lines = [titleLine];
		if (authorLine) lines.push(authorLine);
		lines.push(urlLine);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => thm.fg("muted", s)));
		container.addChild(new Text(lines.join("\n"), 1, 0));
		return container;
	});
}

// ── Session naming ────────────────────────────────────────────────────────────

/**
 * Apply a session name derived from the PR/Issue URL and optional title.
 *
 * Format: "PR: Title (url)" or "Issue: Title (url)"
 * Fallback (no title): "PR: url" or "Issue: url"
 *
 * Only overwrites the current session name if it is empty, equal to the raw
 * URL, or equal to the fallback format (i.e., a name we previously set).
 */
function applySessionName(pi: ExtensionAPI, match: PromptMatch, title?: string): void {
	const label = match.kind === "pr" ? "PR" : "Issue";
	const trimmedTitle = title?.trim();
	const fallbackName = `${label}: ${match.url}`;
	const desiredName = trimmedTitle ? `${label}: ${trimmedTitle} (${match.url})` : fallbackName;

	const currentName = pi.getSessionName()?.trim();
	if (!currentName) {
		pi.setSessionName(desiredName);
		return;
	}
	if (currentName === match.url || currentName === fallbackName) {
		pi.setSessionName(desiredName);
	}
}

// ── Text extraction ───────────────────────────────────────────────────────────

/**
 * Extract plain text from a user message content value.
 * Handles both string content and content block arrays.
 */
function getUserText(content: string | (TextContent | { type: string })[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text" && "text" in block)
		.map((block) => block.text)
		.join("\n");
}

// ── Session recovery ──────────────────────────────────────────────────────────

/**
 * Rebuild the URL widget from session history.
 *
 * Walks session entries in reverse to find the last user message that
 * matches a PR/Issue pattern. If found, shows the widget and fetches
 * metadata asynchronously. If not found, clears the widget.
 */
function rebuildFromSession(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const entries = ctx.sessionManager.getEntries();

	// Find the last user message matching a PR/Issue pattern
	const lastMatch = [...entries].reverse().find((entry) => {
		if (entry.type !== "message") return false;
		const msgEntry = entry as SessionMessageEntry;
		if (!("role" in msgEntry.message) || msgEntry.message.role !== "user") return false;
		const text = getUserText(msgEntry.message.content as string | (TextContent | { type: string })[] | undefined);
		return !!extractPromptMatch(text);
	});

	if (!lastMatch || lastMatch.type !== "message") {
		ctx.ui.setWidget("prompt-url", undefined);
		return;
	}

	const msgEntry = lastMatch as SessionMessageEntry;
	if (!("role" in msgEntry.message) || msgEntry.message.role !== "user") {
		ctx.ui.setWidget("prompt-url", undefined);
		return;
	}

	const text = getUserText(msgEntry.message.content as string | (TextContent | { type: string })[] | undefined);
	const match = extractPromptMatch(text);

	if (!match) {
		ctx.ui.setWidget("prompt-url", undefined);
		return;
	}

	setWidget(ctx, match);
	applySessionName(pi, match);

	void fetchGhMetadata(match.kind, match.url).then((meta) => {
		const title = meta?.title?.trim();
		const authorText = formatAuthor(meta?.author);
		setWidget(ctx, match, title, authorText);
		applySessionName(pi, match, title);
	});
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the prompt URL widget hooks via the extension API.
 *
 * Hooks:
 *   - before_agent_start: detect URL in prompt, show widget, fetch metadata
 *   - session_start:      rebuild widget from session history
 *   - session_switch:     rebuild widget from session history
 *
 * Usage:
 *   extensionRunner.registerBuiltinExtension("<builtin-prompt-url-widget>", registerPromptUrlWidget)
 */
export function registerPromptUrlWidget(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const match = extractPromptMatch(event.prompt);
		if (!match) return;

		// Phase 1: immediate widget with URL only
		setWidget(ctx, match);
		applySessionName(pi, match);

		// Phase 2: async update with title + author after gh responds
		void fetchGhMetadata(match.kind, match.url).then((meta) => {
			const title = meta?.title?.trim();
			const authorText = formatAuthor(meta?.author);
			setWidget(ctx, match, title, authorText);
			applySessionName(pi, match, title);
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromSession(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		rebuildFromSession(pi, ctx);
	});
}
