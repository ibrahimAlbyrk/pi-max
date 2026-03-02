/**
 * Turn Tracker — Track agent activity within a single turn
 *
 * Collects file edits, bash commands, tool calls, and read operations
 * that happen during one agent turn. This data is used to:
 *
 *   1. Build rich auto-notes (instead of just LLM text summary)
 *   2. Better correlate turn activity to tasks
 *   3. Detect when agent is working without an active task
 */

export interface FileActivity {
	path: string;
	operation: "edit" | "write" | "read";
	timestamp: string;
}

export interface BashActivity {
	command: string;
	/** First 100 chars of output (for context) */
	outputSnippet: string;
	isTestRun: boolean;
	timestamp: string;
}

export interface TurnActivity {
	filesEdited: FileActivity[];
	bashCommands: BashActivity[];
	toolCallCount: number;
	startedAt: string;
}

/**
 * Manages per-turn activity tracking. Call `reset()` at turn_start,
 * then `trackFile()` / `trackBash()` during the turn,
 * and `getSummary()` at agent_end.
 */
export class TurnTracker {
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
		const exists = this.current.filesEdited.some(
			(f) => f.path === path && f.operation === operation,
		);
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
		this.current.bashCommands.push({
			command: command.slice(0, 200),
			outputSnippet: output.slice(0, 100).trim(),
			isTestRun,
			timestamp: new Date().toISOString(),
		});
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

	/** Get unique edited/written file paths (no reads) */
	getModifiedFiles(): string[] {
		return this.current.filesEdited
			.filter((f) => f.operation !== "read")
			.map((f) => f.path);
	}

	/**
	 * Build a human-readable summary of this turn's activity.
	 * Used for auto-notes instead of raw LLM text.
	 */
	buildActivitySummary(): string | null {
		if (!this.hasActivity()) return null;

		const parts: string[] = [];

		// File edits/writes
		const edits = this.current.filesEdited.filter((f) => f.operation === "edit");
		const writes = this.current.filesEdited.filter((f) => f.operation === "write");

		if (writes.length > 0) {
			const paths = writes.map((f) => shortPath(f.path));
			parts.push(`Created: ${paths.join(", ")}`);
		}

		if (edits.length > 0) {
			const paths = edits.map((f) => shortPath(f.path));
			parts.push(`Edited: ${paths.join(", ")}`);
		}

		// Bash commands (non-trivial ones)
		const meaningfulBash = this.current.bashCommands.filter(
			(b) => !isTrivialCommand(b.command),
		);
		if (meaningfulBash.length > 0) {
			const cmds = meaningfulBash.map((b) => {
				const short = b.command.length > 60 ? b.command.slice(0, 57) + "..." : b.command;
				return `\`${short}\``;
			});
			parts.push(`Ran: ${cmds.join(", ")}`);
		}

		// Test results
		const tests = this.current.bashCommands.filter((b) => b.isTestRun);
		if (tests.length > 0) {
			parts.push(`Tests executed: ${tests.length}`);
		}

		if (parts.length === 0) return null;
		return parts.join(" | ");
	}
}

/** Shorten a file path to just the last 2 segments */
function shortPath(filePath: string): string {
	const segments = filePath.split("/");
	if (segments.length <= 2) return filePath;
	return segments.slice(-2).join("/");
}

/** Filter out trivial commands like ls, pwd, echo */
function isTrivialCommand(cmd: string): boolean {
	const trimmed = cmd.trim();
	return /^(ls|pwd|echo|cd|cat|head|tail|wc|which|type)\b/.test(trimmed);
}
