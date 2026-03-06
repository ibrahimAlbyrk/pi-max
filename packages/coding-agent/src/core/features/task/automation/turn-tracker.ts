/**
 * Turn Tracker — Track agent activity within a single turn
 *
 * Collects file edits, bash commands, tool calls, and read operations
 * that happen during one agent turn. This data is used to:
 *
 *   1. Build rich auto-notes (instead of just LLM text summary)
 *   2. Better correlate turn activity to tasks
 *   3. Detect when agent is working without an active task
 *
 * Implements the ActivityTracker interface from types.ts.
 * Reset at turn_start, consumed at agent_end.
 */

import type { ActivityTracker, BashActivity, FileActivity, TurnActivity } from "../types.js";

/**
 * Manages per-turn activity tracking. Call `reset()` at turn_start,
 * then `trackFile()` / `trackBash()` during the turn,
 * and `getActivity()` / `buildActivitySummary()` at agent_end.
 */
export class TurnTracker implements ActivityTracker {
	private current: TurnActivity = TurnTracker.empty();

	private static empty(): TurnActivity {
		return {
			filesEdited: [],
			bashCommands: [],
			toolCallCount: 0,
			startedAt: new Date().toISOString(),
		};
	}

	/** Reset at the start of each turn */
	reset(): void {
		this.current = TurnTracker.empty();
	}

	/** Track a file edit/write/read operation */
	trackFile(path: string, operation: "edit" | "write" | "read"): void {
		// Avoid duplicate entries for same file+operation
		const exists = this.current.filesEdited.some((f: FileActivity) => f.path === path && f.operation === operation);
		if (!exists) {
			this.current.filesEdited.push({
				path,
				operation,
				timestamp: new Date().toISOString(),
			});
		}
		this.current.toolCallCount++;
	}

	/** Track a bash command execution */
	trackBash(command: string, output: string, isTestRun: boolean): void {
		const entry: BashActivity = {
			command: command.slice(0, 200),
			outputSnippet: output.slice(0, 100).trim(),
			isTestRun,
			timestamp: new Date().toISOString(),
		};
		this.current.bashCommands.push(entry);
		this.current.toolCallCount++;
	}

	/** Track any other tool call */
	trackToolCall(): void {
		this.current.toolCallCount++;
	}

	/** Get current turn activity snapshot */
	getActivity(): Readonly<TurnActivity> {
		return this.current;
	}

	/** Was there any meaningful activity this turn? */
	hasActivity(): boolean {
		return this.current.filesEdited.length > 0 || this.current.bashCommands.length > 0;
	}

	/** Get unique edited/written file paths (excludes reads) */
	getModifiedFiles(): string[] {
		return this.current.filesEdited
			.filter((f: FileActivity) => f.operation !== "read")
			.map((f: FileActivity) => f.path);
	}

	/**
	 * Build a human-readable summary of this turn's activity.
	 * Used for auto-notes instead of raw LLM text.
	 */
	buildActivitySummary(): string | null {
		if (!this.hasActivity()) return null;

		const parts: string[] = [];

		const edits = this.current.filesEdited.filter((f: FileActivity) => f.operation === "edit");
		const writes = this.current.filesEdited.filter((f: FileActivity) => f.operation === "write");

		if (writes.length > 0) {
			const paths = writes.map((f: FileActivity) => shortPath(f.path));
			parts.push(`Created: ${paths.join(", ")}`);
		}

		if (edits.length > 0) {
			const paths = edits.map((f: FileActivity) => shortPath(f.path));
			parts.push(`Edited: ${paths.join(", ")}`);
		}

		// Bash commands (non-trivial only)
		const meaningfulBash = this.current.bashCommands.filter((b: BashActivity) => !isTrivialCommand(b.command));
		if (meaningfulBash.length > 0) {
			const cmds = meaningfulBash.map((b: BashActivity) => {
				const short = b.command.length > 60 ? `${b.command.slice(0, 57)}...` : b.command;
				return `\`${short}\``;
			});
			parts.push(`Ran: ${cmds.join(", ")}`);
		}

		// Test results
		const tests = this.current.bashCommands.filter((b: BashActivity) => b.isTestRun);
		if (tests.length > 0) {
			parts.push(`Tests executed: ${tests.length}`);
		}

		if (parts.length === 0) return null;
		return parts.join(" | ");
	}
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Shorten a file path to just the last 2 segments */
function shortPath(filePath: string): string {
	const segments = filePath.split("/");
	if (segments.length <= 2) return filePath;
	return segments.slice(-2).join("/");
}

/** Filter out trivial commands like ls, pwd, echo, cd */
function isTrivialCommand(cmd: string): boolean {
	const trimmed = cmd.trim();
	return /^(ls|pwd|echo|cd|cat|head|tail|wc|which|type)\b/.test(trimmed);
}
