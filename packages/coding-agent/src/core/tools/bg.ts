/**
 * bg tool — lets the agent manage long-running background processes.
 *
 * Two exports:
 * - bgToolDefinition: ToolDefinition for main agent (has renderCall/renderResult + ExtensionContext)
 * - createBgTool(cwd): factory returning a plain AgentTool for subagents via tool registry
 *
 * Both share the same ProcessManager singleton within the Node.js process.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { ProcessInfo } from "../features/bg/index.js";
import { getProcessManager } from "../features/bg/index.js";

// ── Parameter Schema ────────────────────────────────────────────────────────

const bgSchema = Type.Object({
	action: StringEnum(["run", "stop", "list", "logs", "restart"] as const),
	command: Type.Optional(Type.String({ description: "Shell command to run (for 'run' action)" })),
	name: Type.Optional(
		Type.String({
			description: "Process name/identifier. Auto-derived from command if not provided.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the process" })),
	lines: Type.Optional(Type.Number({ description: "Number of log lines to retrieve (default: 50)" })),
	taskId: Type.Optional(Type.Number({ description: "Link this process to a task ID" })),
});

export type BgToolInput = Static<typeof bgSchema>;

export interface BgToolDetails {
	action: string;
	isError?: boolean;
	processName?: string;
	pid?: number;
	count?: number;
	processes?: ProcessInfo[];
	stopped?: boolean;
}

// ── Shared description ──────────────────────────────────────────────────────

const TOOL_DESCRIPTION = `Manage background processes (servers, watchers, long-running tasks).

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
  bg restart devserver`;

// ── Shared execute logic ────────────────────────────────────────────────────

function formatListTable(processes: ProcessInfo[]): string {
	const running = processes.filter((p) => p.status === "running").length;
	const crashed = processes.filter((p) => p.status === "crashed").length;

	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (crashed > 0) parts.push(`${crashed} crashed`);
	const stopped = processes.length - running - crashed;
	if (stopped > 0) parts.push(`${stopped} stopped`);

	const header = `${processes.length} process${processes.length === 1 ? "" : "es"} (${parts.join(", ")}):`;

	// Column widths
	const nameW = Math.max(4, ...processes.map((p) => p.name.length));
	const cmdW = Math.max(7, ...processes.map((p) => Math.min(p.command.length, 20)));
	const pidW = Math.max(5, ...processes.map((p) => String(p.pid).length));
	const statusW = Math.max(6, ...processes.map((p) => p.status.length));
	const uptimeW = Math.max(6, ...processes.map((p) => p.uptime.length));

	const pad = (s: string, w: number) => s.padEnd(w);
	const trunc = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

	const colHeader = [
		pad("Name", nameW),
		pad("Command", cmdW),
		pad("PID", pidW),
		pad("Status", statusW),
		pad("Uptime", uptimeW),
		"Last Output",
	].join("  ");

	const rows = processes.map((p) => {
		const pid = p.status === "stopped" || p.status === "crashed" ? "--" : String(p.pid);
		const uptime = p.status === "running" ? p.uptime : "--";
		return [
			pad(p.name, nameW),
			pad(trunc(p.command, cmdW), cmdW),
			pad(pid, pidW),
			pad(p.status, statusW),
			pad(uptime, uptimeW),
			p.lastOutput || "",
		].join("  ");
	});

	return [header, "", colHeader, ...rows].join("\n");
}

async function executeBgAction(
	params: BgToolInput,
	effectiveCwd: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: BgToolDetails }> {
	const manager = getProcessManager();

	switch (params.action) {
		case "run": {
			if (!params.command) {
				return {
					content: [{ type: "text", text: "Error: 'command' is required for 'run' action." }],
					details: { action: "run", isError: true },
				};
			}
			const result = manager.run({
				command: params.command,
				name: params.name,
				cwd: effectiveCwd,
				linkedTaskId: params.taskId,
			});
			if ("error" in result) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { action: "run", isError: true },
				};
			}
			return {
				content: [{ type: "text", text: `Started "${result.name}" (PID ${result.pid})` }],
				details: { action: "run", processName: result.name, pid: result.pid },
			};
		}

		case "stop": {
			if (!params.name) {
				return {
					content: [{ type: "text", text: "Error: 'name' is required for 'stop' action." }],
					details: { action: "stop", isError: true },
				};
			}
			const result = await manager.stop(params.name);
			if (!result.success) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { action: "stop", processName: params.name, isError: true },
				};
			}
			return {
				content: [{ type: "text", text: `Stopped "${params.name}"` }],
				details: { action: "stop", processName: params.name, stopped: true },
			};
		}

		case "list": {
			const processes = manager.list();
			if (processes.length === 0) {
				return {
					content: [{ type: "text", text: "No background processes." }],
					details: { action: "list", count: 0, processes: [] },
				};
			}
			return {
				content: [{ type: "text", text: formatListTable(processes) }],
				details: { action: "list", count: processes.length, processes },
			};
		}

		case "logs": {
			if (!params.name) {
				return {
					content: [{ type: "text", text: "Error: 'name' is required for 'logs' action." }],
					details: { action: "logs", isError: true },
				};
			}
			const lineCount = params.lines ?? 50;
			const result = manager.logs(params.name, lineCount);
			if ("error" in result) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { action: "logs", processName: params.name, isError: true },
				};
			}
			const output = result.lines.length > 0 ? result.lines.join("\n") : "(no output yet)";
			return {
				content: [{ type: "text", text: `Last ${lineCount} lines from "${params.name}":\n\n${output}` }],
				details: { action: "logs", processName: params.name },
			};
		}

		case "restart": {
			if (!params.name) {
				return {
					content: [{ type: "text", text: "Error: 'name' is required for 'restart' action." }],
					details: { action: "restart", isError: true },
				};
			}
			const result = await manager.restart(params.name);
			if ("error" in result) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { action: "restart", processName: params.name, isError: true },
				};
			}
			return {
				content: [{ type: "text", text: `Restarted "${result.name}" (PID ${result.pid})` }],
				details: { action: "restart", processName: result.name, pid: result.pid },
			};
		}

		default: {
			const _exhaustive: never = params.action;
			return {
				content: [{ type: "text", text: `Unknown action: ${_exhaustive}` }],
				details: { action: String(_exhaustive), isError: true },
			};
		}
	}
}

// ── Tool Definition (main agent — includes renderCall/renderResult) ──────────

export const bgToolDefinition: ToolDefinition<typeof bgSchema, BgToolDetails> = {
	name: "bg",
	label: "Background Process",
	description: TOOL_DESCRIPTION,
	parameters: bgSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const effectiveCwd = params.cwd ?? ctx.cwd;
		return executeBgAction(params, effectiveCwd);
	},

	renderCall(args, _options, theme) {
		const action = (args?.action as string | undefined) ?? "?";
		const name = (args?.name as string | undefined) ?? (args?.command as string | undefined) ?? "";
		const label = `${action}${name ? ` ${name}` : ""}`;
		return new Text(theme.fg("toolTitle", theme.bold("Background Process ")) + theme.fg("accent", label), 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		if (result.details?.isError) {
			const raw = result.content[0];
			const text = raw?.type === "text" ? raw.text : "Error";
			return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
		}
		const raw = result.content[0];
		const text = raw?.type === "text" ? raw.text : "Done";
		if (!expanded) {
			return new Text(theme.fg("success", text.split("\n")[0] ?? text), 0, 0);
		}
		return new Text(text, 0, 0);
	},
};

// ── Factory (subagents via tool registry — plain AgentTool) ────────────────

export function createBgTool(cwd: string): AgentTool<typeof bgSchema> {
	return {
		name: "bg",
		label: "bg",
		sideEffects: true,
		description: TOOL_DESCRIPTION,
		parameters: bgSchema,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			const effectiveCwd = params.cwd ?? cwd;
			return executeBgAction(params, effectiveCwd);
		},
	};
}
