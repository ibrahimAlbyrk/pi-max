/**
 * renderCall — Compact one-liner display of tool calls
 */

import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.js";

export function taskRenderCall(args: Record<string, unknown>, theme: Theme): Text {
	const action = args.action as string;
	let text = theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("muted", action);

	switch (action) {
		case "create":
			if (args.title) text += ` ${theme.fg("text", `"${args.title}"`)}`;
			if (args.priority) text += ` ${theme.fg("dim", `priority:${args.priority}`)}`;
			if (args.tags && Array.isArray(args.tags) && args.tags.length > 0)
				text += ` ${theme.fg("dim", `tags:[${args.tags.join(",")}]`)}`;
			break;

		case "get":
		case "start":
		case "complete":
		case "delete":
		case "unblock":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			break;

		case "set_status":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` → ${theme.fg("text", args.status as string)}`;
			break;

		case "block":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			break;

		case "update":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			{
				const fields = [
					"title",
					"description",
					"priority",
					"tags",
					"assignee",
					"estimatedMinutes",
					"groupId",
				].filter((f) => args[f] !== undefined);
				if (fields.length > 0) text += ` ${theme.fg("dim", `[${fields.join(", ")}]`)}`;
			}
			break;

		case "add_note":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) {
				const noteText =
					(args.text as string).length > 40 ? `${(args.text as string).slice(0, 40)}…` : (args.text as string);
				text += ` ${theme.fg("dim", `"${noteText}"`)}`;
			}
			break;

		case "list":
			{
				const filters: string[] = [];
				if (args.filterStatus) filters.push(`status:${args.filterStatus}`);
				if (args.filterPriority) filters.push(`priority:${args.filterPriority}`);
				if (args.filterTag) filters.push(`tag:${args.filterTag}`);
				if (filters.length > 0) text += ` ${theme.fg("dim", filters.join(" "))}`;
			}
			break;

		case "bulk_create":
			if (args.text && typeof args.text === "string") {
				const lineCount = (args.text as string)
					.split("\n")
					.filter((l: string) => l.trim() && !l.trim().startsWith(">")).length;
				text += ` ${theme.fg("dim", `(~${lineCount} tasks, compact)`)}`;
			} else if (args.tasks && Array.isArray(args.tasks)) {
				text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
			}
			break;

		case "bulk_delete":
			if (args.ids && Array.isArray(args.ids))
				text +=
					` ${theme.fg("dim", `(${args.ids.length} tasks)`)} ` +
					theme.fg("accent", (args.ids as number[]).map((id: number) => `#${id}`).join(", "));
			break;

		case "bulk_set_status":
			if (args.ids && Array.isArray(args.ids)) text += ` ${theme.fg("dim", `(${args.ids.length} tasks)`)}`;
			if (args.status) text += ` → ${theme.fg("text", args.status as string)}`;
			break;

		case "bulk_update":
			if (args.ids && Array.isArray(args.ids)) text += ` ${theme.fg("dim", `(${args.ids.length} tasks)`)}`;
			{
				const bulkFields = ["priority", "tags", "assignee", "estimatedMinutes"].filter(
					(f) => args[f] !== undefined,
				);
				if (bulkFields.length > 0) text += ` ${theme.fg("dim", `[${bulkFields.join(", ")}]`)}`;
			}
			break;

		case "bulk_assign_sprint":
			if (args.ids && Array.isArray(args.ids)) text += ` ${theme.fg("dim", `(${args.ids.length} tasks)`)}`;
			if (args.parentId !== undefined) text += ` → ${theme.fg("accent", `#S${args.parentId}`)}`;
			break;

		// Groups
		case "create_group":
			if (args.title) text += ` ${theme.fg("text", `"${args.title}"`)}`;
			break;

		case "delete_group":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `G${args.id}`)}`;
			break;

		case "rename_group":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `G${args.id}`)}`;
			if (args.title) text += ` → ${theme.fg("text", `"${args.title}"`)}`;
			break;

		case "assign_group":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.groupId !== undefined) text += ` → ${theme.fg("accent", `G${args.groupId}`)}`;
			break;

		case "unassign_group":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			break;

		case "tree":
			break;

		// Dependencies
		case "add_dependency":
		case "remove_dependency":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.parentId !== undefined)
				text += ` ${theme.fg("dim", "depends on")} ${theme.fg("accent", `#${args.parentId}`)}`;
			break;

		case "check_dependencies":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			break;

		// Sprints
		case "create_sprint":
			if (args.title) text += ` ${theme.fg("text", `"${args.title}"`)}`;
			break;

		case "start_sprint":
		case "complete_sprint":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#S${args.id}`)}`;
			break;

		case "assign_sprint":
		case "unassign_sprint":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.parentId !== undefined && action === "assign_sprint")
				text += ` → ${theme.fg("accent", `#S${args.parentId}`)}`;
			break;

		case "sprint_status":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#S${args.id}`)}`;
			else text += ` ${theme.fg("dim", "(active)")}`;
			break;

		case "list_sprints":
			break;

		case "log_time":
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.estimatedMinutes !== undefined) text += ` ${theme.fg("dim", `+${args.estimatedMinutes}m`)}`;
			break;
	}

	return new Text(text, 0, 0);
}
