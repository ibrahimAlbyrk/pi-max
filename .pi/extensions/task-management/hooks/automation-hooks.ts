/**
 * Automation Hooks — auto-start on file edit, test detection, auto-notes, plan mode
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SharedContext } from "./shared-context.js";
import { findTaskByFileContext, findBestTaskForFiles } from "../automation/file-correlator.js";
import { detectTestResult } from "../automation/test-detector.js";
import { appendAutoNote, extractTextFromMessage } from "../automation/auto-notes.js";
import { extractPlanSteps } from "../intelligence/plan-converter.js";
import { createTask } from "../store.js";

export function registerAutomationHooks(pi: ExtensionAPI, sc: SharedContext): void {

	// ─── Track Tool Calls + Auto-Start on File Edit ─────────────

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;

		// Track file operations for turn activity
		if (["edit", "write", "read"].includes(toolName)) {
			const filePath: string = event.input?.path ?? "";
			if (filePath) {
				sc.turnTracker.trackFile(filePath, toolName as "edit" | "write" | "read");
			}
		} else if (toolName === "bash") {
			sc.turnTracker.trackToolCall();
		} else {
			sc.turnTracker.trackToolCall();
		}

		// Auto-start logic: only for edit/write
		if (!sc.automationConfig.autoStartOnFileEdit) return;
		if (!["edit", "write"].includes(toolName)) return;

		const filePath: string = event.input?.path ?? "";
		if (!filePath) return;

		const matchingTask = findTaskByFileContext(sc.store, filePath);
		if (matchingTask && matchingTask.status === "todo") {
			matchingTask.status = "in_progress";
			matchingTask.startedAt = new Date().toISOString();
			sc.store.activeTaskId = matchingTask.id;
			sc.saveTaskFile(matchingTask.id);
			sc.refreshWidgets(ctx);
			ctx.ui.notify(`Auto-started #${matchingTask.id}: ${matchingTask.title}`, "info");
			sc.taskEvents.autoStarted(matchingTask, filePath);
		}
	});

	// ─── Track Bash Output + Test Pass Detection ────────────────

	pi.on("tool_result", async (event, ctx) => {
		// Track bash commands in turn tracker
		if (event.toolName === "bash") {
			const content = event.content?.[0];
			const output = (content?.type === "text" ? content.text : "") ?? "";
			const command = (event as any).input?.command ?? "";
			const testRes = detectTestResult(command, output);
			sc.turnTracker.trackBash(command, output, testRes.isTestRun);
		}

		if (!sc.automationConfig.autoCompleteOnTestPass) return;
		if (event.toolName !== "bash") return;
		if (!sc.store.activeTaskId) return;

		const content = event.content?.[0];
		if (content?.type !== "text" || !content.text) return;

		const command = (event as any).input?.command ?? "";
		const testResult = detectTestResult(command, content.text);

		if (testResult.isTestRun && testResult.allPassed) {
			const task = sc.store.tasks.find((t) => t.id === sc.store.activeTaskId);
			if (task && task.status === "in_progress") {
				const oldStatus = task.status;
				task.status = "done";
				task.completedAt = new Date().toISOString();
				if (task.startedAt) {
					task.actualMinutes = Math.round(
						(Date.now() - new Date(task.startedAt).getTime()) / 60000,
					);
				}
				sc.store.activeTaskId = null;
				sc.saveTaskFile(task.id);
				sc.refreshWidgets(ctx);
				sc.taskEvents.statusChanged(task, oldStatus, "done");
				ctx.ui.notify(`Auto-completed #${task.id}: ${task.title}`, "info");
			}
		}
	});

	// ─── Smart Auto-Notes on Agent End ──────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!sc.automationConfig.autoNoteOnAgentEnd) return;
		if (!sc.turnTracker.hasActivity()) return;

		const messages = (event as any).messages;
		let targetTask: import("../types.js").Task | null = null;

		if (sc.store.activeTaskId) {
			targetTask = sc.store.tasks.find((t) => t.id === sc.store.activeTaskId) ?? null;
		} else {
			const modifiedFiles = sc.turnTracker.getModifiedFiles();
			if (modifiedFiles.length > 0) {
				const match = findBestTaskForFiles(sc.store, modifiedFiles);
				if (match) {
					targetTask = match.task;

					if (targetTask.status === "todo") {
						targetTask.status = "in_progress";
						targetTask.startedAt = new Date().toISOString();
						sc.store.activeTaskId = targetTask.id;
						ctx.ui.notify(
							`Auto-matched work to #${targetTask.id}: ${targetTask.title} (score: ${match.score}, files: ${match.matchedFiles.length})`,
							"info",
						);
						sc.taskEvents.autoStarted(targetTask, modifiedFiles[0]);
					} else if (targetTask.status === "in_progress") {
						sc.store.activeTaskId = targetTask.id;
						ctx.ui.notify(
							`Resumed tracking #${targetTask.id}: ${targetTask.title}`,
							"info",
						);
					}
					sc.saveTaskFile(targetTask.id);
					sc.refreshWidgets(ctx);
				}
			}
		}

		if (targetTask) {
			const added = appendAutoNote(targetTask, messages, sc.turnTracker);
			if (added) {
				sc.saveTaskFile(targetTask.id);
				sc.taskEvents.noteAdded(targetTask, targetTask.notes.at(-1)!.text, "agent");
			}
		}
	});

	// ─── Plan Mode Integration (disabled — no interactive prompts) ────
}
