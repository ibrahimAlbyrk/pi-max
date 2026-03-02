/**
 * Custom Statusline Extension
 *
 * Replaces the default pi footer with a single-line statusline:
 *   ⚡ high  ◆ Opus 4.6  ╱  ProjectName  ╱  ⎇ dev [3 modified]  │  ╭ ◆◆◇◇◇◇◇◇◇◇ 18% ↓672 ↑49 ╮          $0.045  •  ✓5/12 ●1
 *
 * Task widget is shown ABOVE the editor (via task-management extension).
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	let cachedModifiedCount = 0;
	let cwd = process.cwd();

	// ── Git status (cached, updated async) ──────────────────────────
	async function updateGitStatus() {
		try {
			const result = await pi.exec("git", ["status", "--porcelain"], { cwd });
			if (result.code === 0 && result.stdout.trim()) {
				cachedModifiedCount = result.stdout.trim().split("\n").length;
			} else {
				cachedModifiedCount = 0;
			}
		} catch {
			cachedModifiedCount = 0;
		}
	}

	// ── Model name shortener ────────────────────────────────────────
	function shortenModelName(id: string): string {
		let name = id;
		if (name.startsWith("claude-")) name = name.slice(7);
		name = name.replace(/-\d{8}$/, "");
		name = name.replace(/-(\d+)-(\d+)$/, " $1.$2");
		name = name.replace(/-(\d+)$/, " $1");
		name = name.replace(/-/g, " ");
		name = name
			.split(" ")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
		return name;
	}

	// ── Token formatter ─────────────────────────────────────────────
	function formatTokens(n: number): string {
		if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
		if (n >= 1000) return `${Math.round(n / 1000)}K`;
		return `${n}`;
	}

	// ── Diamond progress bar ────────────────────────────────────────
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

	// ── Color palette (ANSI 256 – matches Claude Code statusline) ──
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
	};

	// ── Thinking level colors ───────────────────────────────────────
	function thinkingColor(level: string): string {
		switch (level) {
			case "off": return "\x1b[38;5;242m";
			case "minimal": return "\x1b[38;5;153m";
			case "low": return "\x1b[38;5;117m";
			case "medium": return "\x1b[38;5;159m";
			case "high": return "\x1b[38;5;183m";
			case "xhigh": return "\x1b[38;5;210m";
			default: return "\x1b[38;5;242m";
		}
	}

	// ── Setup footer on session start ───────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		await updateGitStatus();

		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				updateGitStatus();
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ── Gather data ─────────────────────────────
					const modelId = ctx.model?.id || "no-model";
					const modelShort = shortenModelName(modelId);
					const projectName = cwd.split("/").pop() || cwd;
					const branch = footerData.getGitBranch();

					// Tokens & cost
					let totalInput = 0;
					let totalOutput = 0;
					let totalCost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCost += m.usage.cost.total;
						}
					}

					// Context usage
					const contextUsage = ctx.getContextUsage();
					const percent = contextUsage?.percent ?? 0;

					// Thinking level
					const thinkingLevel = pi.getThinkingLevel() || "off";

					// ── LEFT PART ───────────────────────────────
					let leftPart = "";

					// Thinking level (leftmost, before model dot)
					if (ctx.model?.reasoning) {
						const thinkColor = thinkingColor(thinkingLevel);
						leftPart += `${thinkColor}⚡ ${thinkingLevel}${c.R}  `;
					}

					// Model name
					leftPart += `${c.model}◆ ${modelShort}${c.R}`;
					leftPart += `  ${c.sep}╱${c.R}  `;
					leftPart += `${c.project}${projectName}${c.R}`;

					if (branch) {
						leftPart += `  ${c.sep}╱${c.R}  `;
						leftPart += `${c.branchIcon}⎇${c.R} ${c.branchName}${branch}${c.R}`;
						if (cachedModifiedCount > 0) {
							leftPart += ` ${c.bracket}[${c.R}${c.modified}${cachedModifiedCount} modified${c.R}${c.bracket}]${c.R}`;
						} else {
							leftPart += ` ${c.clean}✓${c.R}`;
						}
					}

					const bar = makeProgressBar(percent);
					const pctStr =
						contextUsage?.percent !== null && contextUsage?.percent !== undefined
							? `${Math.round(percent)}%`
							: "?%";

					let ctxPart = `${c.outline}╭${c.R} ${bar} ${c.pct}${pctStr}${c.R}`;
					ctxPart += ` ${c.tokenIn}↓${formatTokens(totalInput)}${c.R}`;
					ctxPart += ` ${c.tokenOut}↑${formatTokens(totalOutput)}${c.R}`;
					ctxPart += ` ${c.outline}╮${c.R}`;

					leftPart += `  ${c.sep}│${c.R}  ${ctxPart}`;

					// ── Cost + extension statuses (after context) ──
					leftPart += `  ${c.cost}$${totalCost.toFixed(3)}${c.R}`;

					return [truncateToWidth(leftPart, width)];
				},
			};
		});
	});

	// ── Update git status on turn boundaries ────────────────────────
	pi.on("turn_end", async () => {
		await updateGitStatus();
	});

	// ── Handle session switch ───────────────────────────────────────
	pi.on("session_switch", async (_event, ctx) => {
		cwd = ctx.cwd;
		await updateGitStatus();
	});

	// ── Handle model change ─────────────────────────────────────────
	pi.on("model_select", async () => {
		// Footer re-renders automatically, nothing extra needed
	});
}
