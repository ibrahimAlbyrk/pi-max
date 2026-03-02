import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text, Key, matchesKey, visibleWidth, CURSOR_MARKER, type Focusable } from "@mariozechner/pi-tui";
import { BackgroundProcessManager } from "./manager.ts";

const LOG_LINES = 5;

export default function (pi: ExtensionAPI) {
	const manager = new BackgroundProcessManager(pi);

	// ═══════════════════════════════════════════════════════════════════
	// TOOL: bg
	// ═══════════════════════════════════════════════════════════════════
	pi.registerTool({
		name: "bg",
		label: "Background Process",
		description: `Manage background processes (servers, watchers, long-running tasks).

Actions:
- **run**: Start a command in the background. Returns immediately with process name and PID.
- **stop**: Stop a running process by name (SIGTERM → 5s → SIGKILL).
- **list**: Show all tracked processes with status, uptime, and last output line.
- **logs**: Get recent output (stdout+stderr) from a process.
- **restart**: Stop and re-run a process with the same command.

Examples:
  bg run "npm run dev" --name devserver
  bg run "python3 -m http.server 8080"
  bg list
  bg logs devserver --lines 100
  bg stop devserver
  bg restart devserver`,

		parameters: Type.Object({
			action: StringEnum(["run", "stop", "list", "logs", "restart"] as const),
			command: Type.Optional(Type.String({ description: "Shell command to run (for 'run' action)" })),
			name: Type.Optional(Type.String({ description: "Process name/identifier. Auto-derived from command if not provided." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the process" })),
			lines: Type.Optional(Type.Number({ description: "Number of log lines to retrieve (default: 50)" })),
			taskId: Type.Optional(Type.Number({ description: "Link this process to a task ID" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "run": {
					if (!params.command) {
						return { content: [{ type: "text", text: "Error: 'command' is required for 'run' action." }], isError: true };
					}
					const result = manager.run({
						command: params.command,
						name: params.name,
						cwd: params.cwd ?? ctx.cwd,
						linkedTaskId: params.taskId,
					});
					if ("error" in result) {
						return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
					}
					return {
						content: [{ type: "text", text: `✓ Background process started\n  Name: ${result.name}\n  PID:  ${result.pid}\n  Cmd:  ${params.command}\n\nUse bg logs "${result.name}" to check output.\nUse bg stop "${result.name}" to terminate.` }],
						details: { processName: result.name, pid: result.pid },
					};
				}
				case "stop": {
					if (!params.name) {
						return { content: [{ type: "text", text: "Error: 'name' is required for 'stop' action." }], isError: true };
					}
					const result = await manager.stop(params.name);
					if (!result.success) {
						return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
					}
					return {
						content: [{ type: "text", text: `✓ Process "${params.name}" stopped.` }],
						details: { processName: params.name, stopped: true },
					};
				}
				case "list": {
					const processes = manager.list();
					if (processes.length === 0) {
						return { content: [{ type: "text", text: "No background processes." }] };
					}
					const lines = processes.map((p) => {
						const icon = p.status === "running" ? "▶" : p.status === "crashed" ? "✗" : "■";
						const taskInfo = p.linkedTaskId ? ` [task #${p.linkedTaskId}]` : "";
						return `${icon} ${p.name} (pid ${p.pid}) — ${p.status} — ${p.uptime}${taskInfo}\n  cmd: ${p.command}\n  out: ${p.lastOutput || "(no output)"}`;
					});
					return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: processes.length, processes } };
				}
				case "logs": {
					if (!params.name) {
						return { content: [{ type: "text", text: "Error: 'name' is required for 'logs' action." }], isError: true };
					}
					const result = manager.logs(params.name, params.lines ?? 50);
					if ("error" in result) {
						return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
					}
					return { content: [{ type: "text", text: `── Logs: ${params.name} (last ${params.lines ?? 50} lines) ──\n${result.lines.join("\n") || "(no output yet)"}` }] };
				}
				case "restart": {
					if (!params.name) {
						return { content: [{ type: "text", text: "Error: 'name' is required for 'restart' action." }], isError: true };
					}
					const result = await manager.restart(params.name);
					if ("error" in result) {
						return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
					}
					return {
						content: [{ type: "text", text: `✓ Process "${params.name}" restarted\n  New PID: ${result.pid}` }],
						details: { processName: result.name, pid: result.pid },
					};
				}
				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], isError: true };
			}
		},

		renderCall(args, theme) {
			const action = args?.action ?? "?";
			const name = args?.name ?? args?.command ?? "";
			return new Text(theme.bold("bg ") + theme.fg("accent", `${action}${name ? ` ${name}` : ""}`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (result.isError) {
				const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "Error";
				return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
			}
			const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "Done";
			if (!expanded) return new Text(theme.fg("success", text.split("\n")[0]), 0, 0);
			return new Text(text, 0, 0);
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// COMMANDS
	// ═══════════════════════════════════════════════════════════════════

	pi.registerCommand("bg", {
		description: "Background processes: /bg [stop <name>|stopall|clean]",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["stop", "stopall", "clean"];
			const parts = prefix.trim().split(/\s+/);
			if (parts.length <= 1) {
				return subcommands.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ label: s, value: s + " " }));
			}
			if (parts[0] === "stop") {
				const names = manager.list().map((p) => p.name);
				return names.filter((n) => n.startsWith(parts[1] ?? "")).map((n) => ({ label: n, value: `stop ${n}` }));
			}
			return [];
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0] || "";
			switch (sub) {
				case "stop": {
					const name = parts[1];
					if (!name) { ctx.ui.notify("Usage: /bg stop <name>", "warning"); return; }
					const result = await manager.stop(name);
					ctx.ui.notify(result.success ? `Stopped "${name}"` : result.error!, result.success ? "info" : "error");
					return;
				}
				case "stopall": {
					const count = manager.runningCount;
					await manager.stopAll();
					ctx.ui.notify(`Stopped ${count} process(es)`, "info");
					return;
				}
				case "clean": {
					const removed = manager.cleanup();
					ctx.ui.notify(`Cleaned up ${removed} dead process(es)`, "info");
					return;
				}
				default:
					// No args or "list" → open panel in editor area
					if (ctx.hasUI) {
						await showProcessPanel(manager, ctx);
					} else {
						const processes = manager.list();
						ctx.ui.notify(processes.length === 0 ? "No background processes" : processes.map((p) => `${p.status === "running" ? "▶" : "■"} ${p.name} (${p.status})`).join("\n"), "info");
					}
			}
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// SHORTCUTS
	// ═══════════════════════════════════════════════════════════════════

	pi.registerShortcut("shift+down", {
		description: "Open background processes panel",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await showProcessPanel(manager, ctx);
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// HOOKS
	// ═══════════════════════════════════════════════════════════════════

	pi.on("session_shutdown", async () => {
		if (manager.runningCount > 0) await manager.stopAll();
	});

	pi.events.on("task:completed", async (data: any) => {
		const task = data?.task;
		if (!task?.id) return;
		const proc = manager.getByTaskId(task.id);
		if (proc && proc.status === "running") await manager.stop(proc.name);
	});

	pi.events.emit("bg:ready", { manager });

	// ═══════════════════════════════════════════════════════════════════
	// EDITOR BADGE — shows running process count on bottom border
	// ═══════════════════════════════════════════════════════════════════

	let badgeCtx: ExtensionContext | null = null;
	let badgeTimer: ReturnType<typeof setInterval> | null = null;
	let badgeFrame = 0;

	const BADGE_KEY = "bg-count";
	const SHINE_INTERVAL = 120; // ms per frame
	const SHINE_PAUSE_FRAMES = 12; // pause frames between sweeps

	function renderBadge(ctx: ExtensionContext, count: number): void {
		if (!ctx.hasUI) return;
		const th = ctx.ui.theme;

		// Badge content: "⚙ bg 3" — characters to animate
		const icon = "⚙";
		const label = `bg ${count}`;
		const fullText = `${icon} ${label}`;
		const totalChars = fullText.length;
		const totalFrames = totalChars + SHINE_PAUSE_FRAMES;

		// Current shine position (wraps around)
		const shinePos = badgeFrame % totalFrames;

		// Build character-by-character with shine
		let content = "";
		for (let i = 0; i < totalChars; i++) {
			const char = fullText[i];
			const dist = Math.abs(i - shinePos);

			if (dist === 0) {
				// Shine peak — bright white bold
				content += `\x1b[1;97m${char}\x1b[0m`;
			} else if (dist === 1) {
				// Near shine — accent color
				content += th.fg("accent", char!);
			} else {
				// Normal — dim
				content += th.fg("dim", char!);
			}
		}

		// Wrap in brackets with border color
		const badge = th.fg("border", "[ ") + content + th.fg("border", " ]");
		ctx.ui.setEditorBadge(BADGE_KEY, badge);
	}

	function updateBadge(): void {
		if (!badgeCtx) return;
		const count = manager.runningCount;

		if (count === 0) {
			// No running processes — clear badge and stop timer
			badgeCtx.ui.setEditorBadge(BADGE_KEY, undefined);
			if (badgeTimer) {
				clearInterval(badgeTimer);
				badgeTimer = null;
			}
			badgeFrame = 0;
			return;
		}

		renderBadge(badgeCtx, count);
		badgeFrame++;

		// Start animation timer if not running
		if (!badgeTimer) {
			badgeTimer = setInterval(() => {
				if (!badgeCtx || manager.runningCount === 0) {
					updateBadge(); // will clear
					return;
				}
				badgeFrame++;
				renderBadge(badgeCtx!, manager.runningCount);
			}, SHINE_INTERVAL);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		badgeCtx = ctx;
		// Check if there are already running processes
		if (manager.runningCount > 0) updateBadge();
	});

	pi.on("session_shutdown", () => {
		if (badgeTimer) {
			clearInterval(badgeTimer);
			badgeTimer = null;
		}
		badgeCtx = null;
	});

	// React to process lifecycle events
	pi.events.on("bg:started", () => updateBadge());
	pi.events.on("bg:stopped", () => updateBadge());
	pi.events.on("bg:crashed", () => updateBadge());
}

// ═══════════════════════════════════════════════════════════════════════
// PROCESS PANEL — replaces editor in input bar area
// ═══════════════════════════════════════════════════════════════════════

type PanelResult =
	| { action: "stop" | "restart" | "kill" | "stopall" | "killall"; name?: string }
	| null;

class ProcessPanel implements Focusable {
	focused = false;
	private selectedIndex = 0;
	private expandedIndex = -1; // -1 = none expanded
	private cachedLines?: string[];
	private cachedWidth?: number;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private tui: { requestRender: () => void } | null = null;

	constructor(
		private manager: BackgroundProcessManager,
		private theme: Theme,
		private done: (result: PanelResult) => void,
		tui: any,
	) {
		this.tui = tui;
		this.refreshTimer = setInterval(() => {
			this.invalidate();
			this.tui?.requestRender();
		}, 1000);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "shift+up")) {
			if (this.expandedIndex >= 0) {
				// Close detail view, back to list
				this.expandedIndex = -1;
				this.invalidate();
				return;
			}
			this.done(null);
			return;
		}

		const processes = this.manager.list();
		const totalItems = processes.length + 1; // +1 for Stop All

		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) { this.selectedIndex--; this.invalidate(); }
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.selectedIndex < totalItems - 1) { this.selectedIndex++; this.invalidate(); }
			return;
		}

		// Enter → toggle detail view for selected process
		if (matchesKey(data, "return")) {
			if (this.selectedIndex === processes.length) {
				// Stop All row
				this.done({ action: "stopall" });
				return;
			}
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? -1 : this.selectedIndex;
			this.invalidate();
			return;
		}

		// s/S → stop (SIGTERM)
		if (data === "s" || data === "S") {
			const p = processes[this.selectedIndex];
			if (p?.status === "running") this.done({ action: "stop", name: p.name });
			return;
		}

		// k/K → kill & remove from list
		if (data === "k" || data === "K") {
			const p = processes[this.selectedIndex];
			if (p) this.done({ action: "kill", name: p.name });
			return;
		}

		// r/R → restart
		if (data === "r" || data === "R") {
			const p = processes[this.selectedIndex];
			if (p) this.done({ action: "restart", name: p.name });
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const processes = this.manager.list();
		const lines: string[] = [];

		// ── Top border with title ──
		const title = " ⚙ Background Processes ";
		const titleStyled = th.fg("accent", th.bold(title));
		const titleVis = visibleWidth(title);
		const topRight = Math.max(0, width - 3 - titleVis);
		lines.push(th.fg("border", "──") + titleStyled + th.fg("border", "─".repeat(topRight)));

		if (processes.length === 0) {
			lines.push(`  ${th.fg("dim", "No background processes running.")}`);
			lines.push("");
			lines.push(`  ${th.fg("dim", "Use")} bg run "command" ${th.fg("dim", "to start one.")}`);
		} else {
			// Summary
			const running = processes.filter((p) => p.status === "running").length;
			const crashed = processes.filter((p) => p.status === "crashed").length;
			let summary = `${running} running`;
			if (crashed) summary += `, ${th.fg("error", `${crashed} crashed`)}`;
			lines.push(`  ${th.fg("dim", summary)}`);
			lines.push("");

			// Process entries
			for (let i = 0; i < processes.length; i++) {
				const p = processes[i];
				const sel = i === this.selectedIndex;
				const expanded = i === this.expandedIndex;

				const icon = p.status === "running"
					? th.fg("success", "▶")
					: p.status === "crashed" ? th.fg("error", "✗") : th.fg("dim", "■");

				const pointer = sel ? th.fg("accent", "❯") : " ";
				const name = sel ? th.fg("accent", th.bold(p.name)) : th.bold(p.name);
				const status = p.status === "running"
					? th.fg("success", p.status)
					: p.status === "crashed" ? th.fg("error", p.status) : th.fg("dim", p.status);
				const arrow = expanded ? th.fg("dim", " ▾") : th.fg("dim", " ▸");

				lines.push(`  ${pointer} ${icon} ${name} ${th.fg("dim", "—")} ${status} ${th.fg("dim", "—")} ${th.fg("dim", p.uptime)}${arrow}`);

				// Expanded detail: command + last 5 log lines
				if (expanded) {
					lines.push(`      ${th.fg("dim", "cmd:")} ${th.fg("muted", p.command)}`);
					lines.push(`      ${th.fg("dim", "pid:")} ${th.fg("muted", String(p.pid))}${p.linkedTaskId ? `  ${th.fg("dim", "task:")} ${th.fg("muted", "#" + p.linkedTaskId)}` : ""}`);

					const logResult = this.manager.logs(p.name, LOG_LINES);
					if ("lines" in logResult && logResult.lines.length > 0) {
						lines.push(`      ${th.fg("dim", "─── logs ───")}`);
						for (const logLine of logResult.lines) {
							const trimmed = logLine.trimEnd();
							if (trimmed) {
								lines.push(`      ${th.fg("dim", trimmed)}`);
							}
						}
					} else {
						lines.push(`      ${th.fg("dim", "(no output)")}`);
					}
					lines.push("");
				}
			}

			// Stop All option
			lines.push("");
			const stopSel = this.selectedIndex === processes.length;
			const stopPointer = stopSel ? th.fg("error", "❯") : " ";
			const stopLabel = stopSel ? th.fg("error", th.bold("■ Stop All")) : th.fg("dim", "■ Stop All");
			lines.push(`  ${stopPointer} ${stopLabel}`);
		}

		// ── Footer ──
		lines.push(th.fg("border", "─".repeat(width)));

		const shortcuts = [
			[th.fg("dim", "↑↓"), th.fg("muted", "navigate")],
			[th.fg("dim", "↵"), th.fg("muted", "detail")],
			[th.fg("dim", "s"), th.fg("muted", "stop")],
			[th.fg("dim", "k"), th.fg("muted", "kill+remove")],
			[th.fg("dim", "r"), th.fg("muted", "restart")],
			[th.fg("dim", "esc"), th.fg("muted", "close")],
		];
		const footerStr = shortcuts.map(([k, v]) => `${k} ${v}`).join("  ");
		lines.push(`  ${footerStr}`);

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

async function showProcessPanel(manager: BackgroundProcessManager, ctx: ExtensionContext): Promise<void> {
	while (true) {
		const result = await ctx.ui.custom<PanelResult>(
			(tui, theme, _kb, done) => new ProcessPanel(manager, theme, done, tui),
		);

		if (!result) return; // Esc

		switch (result.action) {
			case "stop":
				if (result.name) {
					await manager.stop(result.name);
					ctx.ui.notify(`Stopped "${result.name}"`, "info");
				}
				break;
			case "kill":
				if (result.name) {
					await manager.stop(result.name);
					manager.remove(result.name);
					ctx.ui.notify(`Killed & removed "${result.name}"`, "info");
				}
				break;
			case "restart":
				if (result.name) {
					await manager.restart(result.name);
					ctx.ui.notify(`Restarted "${result.name}"`, "info");
				}
				break;
			case "stopall":
				await manager.stopAll();
				ctx.ui.notify("All processes stopped", "info");
				return;
		}

		// Loop back if still have processes
		if (manager.list().length === 0) return;
	}
}
