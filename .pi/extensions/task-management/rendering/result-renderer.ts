/**
 * renderResult — Rich display of tool results
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { TaskToolDetails, Task } from "../types.js";
import { STATUS_ICONS, PRIORITY_COLORS, priorityLabel } from "./icons.js";
import { formatElapsed } from "../store.js";

export function taskRenderResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): ReturnType<typeof Text> {
	const details = result.details as TaskToolDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" && text.text ? text.text : "", 0, 0);
	}

	const { store, action } = details;

	// Error results — pass through
	const firstText = result.content[0];
	const rawText = firstText?.type === "text" ? firstText.text ?? "" : "";
	if (rawText.startsWith("Error:")) {
		return new Text(theme.fg("error", rawText), 0, 0);
	}

	switch (action) {
		case "create": {
			const task = store.tasks[store.tasks.length - 1];
			if (!task) return new Text(rawText, 0, 0);
			return new Text(
				theme.fg("success", "✓ Created ") +
					theme.fg("accent", `#${task.id}`) +
					" — " +
					theme.fg("text", task.title) +
					" " +
					theme.fg(PRIORITY_COLORS[task.priority] as any, `[${priorityLabel(task.priority)}]`) +
					(task.tags.length > 0
						? " " + theme.fg("dim", `[${task.tags.join(", ")}]`)
						: ""),
				0,
				0,
			);
		}

		case "list": {
			const tasks = store.tasks;
			if (tasks.length === 0) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}

			// Collapsed: summary only
			const counts: Record<string, number> = {};
			for (const t of tasks) {
				counts[t.status] = (counts[t.status] || 0) + 1;
			}
			const countStr = Object.entries(counts)
				.map(([s, c]) => `${c} ${s.replace(/_/g, " ")}`)
				.join(", ");

			if (!options.expanded) {
				return new Text(
					theme.fg("muted", `${tasks.length} task(s) (${countStr})`),
					0,
					0,
				);
			}

			// Expanded: full list
			const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
			const sorted = [...tasks].sort((a, b) => {
				const pa = priorityOrder[a.priority] ?? 2;
				const pb = priorityOrder[b.priority] ?? 2;
				return pa !== pb ? pa - pb : a.id - b.id;
			});

			let listText = theme.fg("muted", `${tasks.length} task(s) (${countStr}):`);
			for (const t of sorted) {
				listText += "\n" + renderTaskLine(t, theme);
			}
			return new Text(listText, 0, 0);
		}

		case "get": {
			return new Text(rawText, 0, 0);
		}

		case "update": {
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", rawText),
				0,
				0,
			);
		}

		case "delete": {
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", rawText),
				0,
				0,
			);
		}

		case "start":
		case "complete":
		case "set_status":
		case "block":
		case "unblock": {
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", rawText),
				0,
				0,
			);
		}

		case "add_note": {
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", rawText),
				0,
				0,
			);
		}

		case "bulk_create":
		case "bulk_delete":
		case "bulk_update":
		case "bulk_set_status":
		case "bulk_assign_sprint": {
			const lines = rawText.split("\n");
			const header = lines[0] ?? "";
			if (!options.expanded) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", header), 0, 0);
			}
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", rawText),
				0,
				0,
			);
		}

		default:
			return new Text(rawText, 0, 0);
	}
}

function renderTaskLine(t: Task, theme: Theme): string {
	const icon = STATUS_ICONS[t.status];
	const statusIcon = t.status === "done"
		? theme.fg("success", icon)
		: t.status === "blocked"
			? theme.fg("error", icon)
			: t.status === "in_progress"
				? theme.fg("accent", icon)
				: theme.fg("dim", icon);

	const id = theme.fg("accent", `#${t.id}`);
	const pri = theme.fg(PRIORITY_COLORS[t.priority] as any, `[${priorityLabel(t.priority)}]`);
	const title = t.status === "done"
		? theme.fg("dim", t.title)
		: theme.fg("text", t.title);

	let line = `${statusIcon} ${id} ${pri} ${title}`;

	if (t.agentName) {
		const agentColor = t.agentColor
			? `\x1b[38;2;${parseInt(t.agentColor.slice(1, 3), 16)};${parseInt(t.agentColor.slice(3, 5), 16)};${parseInt(t.agentColor.slice(5, 7), 16)}m`
			: "";
		line += ` ${agentColor}@${t.agentName}\x1b[0m`;
	}

	if (t.status === "in_progress" && t.startedAt) {
		const elapsed = Date.now() - new Date(t.startedAt).getTime();
		line += ` ${theme.fg("dim", `(${formatElapsed(elapsed)})`)}`;
	}

	if (t.status === "done" && t.actualMinutes !== null) {
		line += ` ${theme.fg("dim", `(${t.actualMinutes}m)`)}`;
	}

	return line;
}
