/**
 * Built-in custom statusline feature.
 *
 * Replaces the default pi footer with a compact, information-dense single-line statusline:
 *   ⚡ high  ◆ Opus 4.6  ╱  ProjectName  ╱  ⎇ dev [3 modified]  │  ╭ ◆◆◇◇◇◇◇◇◇◇ 18% ↓672K ↑49K ╮  $0.045
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentSession } from "../agent-session.js";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.js";

const execFileAsync = promisify(execFile);

// ── Model name shortener ────────────────────────────────────────────────────

/**
 * Transforms model IDs to human-readable short names.
 * Examples: `claude-sonnet-4-6-20250514` → `Sonnet 4.6`
 */
function shortenModelName(id: string): string {
	let name = id;
	if (name.startsWith("claude-")) name = name.slice(7);
	// Remove date suffixes like -20250219
	name = name.replace(/-\d{8}$/, "");
	// Convert version numbers: -4-6 → 4.6
	name = name.replace(/-(\d+)-(\d+)$/, " $1.$2");
	// Convert single trailing version: -3 → 3
	name = name.replace(/-(\d+)$/, " $1");
	// Replace remaining hyphens with spaces
	name = name.replace(/-/g, " ");
	// Title-case each word
	name = name
		.split(" ")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
	return name;
}

// ── Token formatter ─────────────────────────────────────────────────────────

/**
 * Formats token counts: >= 1M → "1.5M", >= 1K → "672K", else raw number.
 */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return `${n}`;
}

// ── Diamond progress bar ────────────────────────────────────────────────────

/**
 * Builds a filled/empty diamond progress bar with ANSI 256 colors.
 * Color transitions: <50% calm (152), <75% moderate (146), 75%+ warm (181).
 */
function makeProgressBar(percent: number, barWidth = 10): string {
	const filled = Math.round((percent * barWidth) / 100);

	let filledColor: string;
	if (percent < 50) filledColor = "\x1b[38;5;152m";
	else if (percent < 75) filledColor = "\x1b[38;5;146m";
	else filledColor = "\x1b[38;5;181m";

	const emptyColor = "\x1b[38;5;237m";
	const R = "\x1b[0m";

	let bar = "";
	for (let i = 0; i < filled; i++) bar += `${filledColor}◆${R}`;
	for (let i = filled; i < barWidth; i++) bar += `${emptyColor}◇${R}`;
	return bar;
}

// ── Thinking level colors ───────────────────────────────────────────────────

/**
 * Maps a thinking level string to an ANSI 256 color escape code.
 */
function thinkingColor(level: string): string {
	switch (level) {
		case "off":
			return "\x1b[38;5;242m";
		case "minimal":
			return "\x1b[38;5;153m";
		case "low":
			return "\x1b[38;5;117m";
		case "medium":
			return "\x1b[38;5;159m";
		case "high":
			return "\x1b[38;5;183m";
		case "xhigh":
			return "\x1b[38;5;210m";
		default:
			return "\x1b[38;5;242m";
	}
}

// ── Color palette ───────────────────────────────────────────────────────────

/**
 * ANSI 256 color palette for the statusline.
 */
const c = {
	model: "\x1b[38;5;189m",
	project: "\x1b[38;5;223m",
	sep: "\x1b[38;5;240m",
	branchIcon: "\x1b[38;5;180m",
	branchName: "\x1b[38;5;151m",
	modified: "\x1b[38;5;186m",
	bracket: "\x1b[38;5;244m",
	clean: "\x1b[38;5;151m",
	tokenIn: "\x1b[38;5;153m",
	tokenOut: "\x1b[38;5;222m",
	pct: "\x1b[38;5;250m",
	outline: "\x1b[38;5;246m",
	cost: "\x1b[38;5;247m",
	dim: "\x1b[38;5;242m",
	R: "\x1b[0m",
} as const;

// ── Module-level git state ──────────────────────────────────────────────────

let cachedModifiedCount = 0;
let statuslineCwd = process.cwd();

// ── Git status updater ──────────────────────────────────────────────────────

/**
 * Runs `git status --porcelain` and updates cachedModifiedCount.
 * Errors are silently swallowed (e.g., not a git repo, git not installed).
 */
async function updateGitStatus(): Promise<void> {
	try {
		const result = await execFileAsync("git", ["status", "--porcelain"], {
			cwd: statuslineCwd,
			timeout: 5000,
		});
		const stdout = result.stdout.trim();
		cachedModifiedCount = stdout ? stdout.split("\n").length : 0;
	} catch {
		cachedModifiedCount = 0;
	}
}

// ── CustomStatuslineComponent ───────────────────────────────────────────────

/**
 * A footer component that renders a compact single-line statusline showing:
 * thinking level, model name, project name, git branch/modified count,
 * context usage bar, token counts, and cost.
 */
export class CustomStatuslineComponent implements Component {
	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	invalidate(): void {
		// No-op: state is re-read on each render call
	}

	dispose(): void {
		// No-op: no resources to clean up
	}

	render(width: number): string[] {
		// ── Gather data ─────────────────────────────────────────────
		const model = this.session.model;
		const modelId = model?.id ?? "no-model";
		const modelShort = shortenModelName(modelId);
		const thinkingLevel = this.session.thinkingLevel;
		const projectName = statuslineCwd.split("/").pop() || statuslineCwd;
		const branch = this.footerData.getGitBranch();

		// Sum tokens and cost from all assistant messages in current branch
		let totalInput = 0;
		let totalOutput = 0;
		let totalCost = 0;
		for (const entry of this.session.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				totalInput += m.usage.input;
				totalOutput += m.usage.output;
				totalCost += m.usage.cost.total;
			}
		}

		// Context usage
		const contextUsage = this.session.getContextUsage();
		const percent = contextUsage?.percent ?? 0;
		const pctStr =
			contextUsage?.percent !== null && contextUsage?.percent !== undefined ? `${Math.round(percent)}%` : "?%";

		// ── Build statusline ────────────────────────────────────────
		let line = "";

		// Thinking level (only for reasoning-capable models)
		if (model?.reasoning) {
			const tc = thinkingColor(thinkingLevel);
			line += `${tc}⚡ ${thinkingLevel}${c.R}  `;
		}

		// Model name
		line += `${c.model}◆ ${modelShort}${c.R}`;
		line += `  ${c.sep}╱${c.R}  `;
		line += `${c.project}${projectName}${c.R}`;

		// Git branch and modified count
		if (branch) {
			line += `  ${c.sep}╱${c.R}  `;
			line += `${c.branchIcon}⎇${c.R} ${c.branchName}${branch}${c.R}`;
			if (cachedModifiedCount > 0) {
				line += ` ${c.bracket}[${c.R}${c.modified}${cachedModifiedCount} modified${c.R}${c.bracket}]${c.R}`;
			} else {
				line += ` ${c.clean}✓${c.R}`;
			}
		}

		// Context bar + token counts
		const bar = makeProgressBar(percent);
		let ctxPart = `${c.outline}╭${c.R} ${bar} ${c.pct}${pctStr}${c.R}`;
		ctxPart += ` ${c.tokenIn}↓${formatTokens(totalInput)}${c.R}`;
		ctxPart += ` ${c.tokenOut}↑${formatTokens(totalOutput)}${c.R}`;
		ctxPart += ` ${c.outline}╮${c.R}`;

		line += `  ${c.sep}│${c.R}  ${ctxPart}`;

		// Cost
		line += `  ${c.cost}$${totalCost.toFixed(3)}${c.R}`;

		return [truncateToWidth(line, width)];
	}
}

// ── CustomStatuslineSession interface ───────────────────────────────────────

/**
 * Minimal interface describing the session hooks required by setupCustomStatuslineHooks.
 * AgentSession satisfies this interface.
 */
export interface CustomStatuslineSession {
	onSessionStart(handler: (ctx: { cwd: string }) => Promise<void>): void;
	onSessionSwitch(
		handler: (event: { reason: string; previousSessionFile: string | undefined }) => Promise<void>,
	): void;
	onTurnEnd(handler: (event: { turnIndex: number }) => Promise<void>): void;
}

// ── Hook registration ───────────────────────────────────────────────────────

/**
 * Registers lifecycle hooks that keep the module-level git status up to date.
 * Called once during session initialization.
 */
export function setupCustomStatuslineHooks(session: CustomStatuslineSession): void {
	session.onSessionStart(async (ctx) => {
		statuslineCwd = ctx.cwd;
		await updateGitStatus();
	});

	session.onSessionSwitch(async () => {
		await updateGitStatus();
	});

	session.onTurnEnd(async () => {
		await updateGitStatus();
	});
}
