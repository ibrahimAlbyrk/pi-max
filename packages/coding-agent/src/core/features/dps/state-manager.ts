/**
 * Dynamic Prompt System (DPS) — State Manager
 *
 * Tracks runtime state used for condition evaluation during prompt composition.
 * Singleton per session: reset() on session start/switch/fork.
 */

import { execSync } from "child_process";
import type { RuntimeState } from "./types.js";

// ─── Default State Factory ────────────────────────────────────────

function createDefaultState(): RuntimeState {
	return {
		turnCount: 0,
		activeTools: new Set(),
		allTools: new Set(),
		toolLastUsedAtTurn: new Map(),
		toolUsageCount: new Map(),
		cwd: process.cwd(),
		modelName: "",
		modelCapabilities: new Set(),
		tokenUsagePercent: null,
		reminderLastTriggered: new Map(),
		reminderTriggerCount: new Map(),
		skillsCount: 0,
	};
}

// ─── StateManager ────────────────────────────────────────────────

export class StateManager {
	private state: RuntimeState = createDefaultState();

	/** Cached git branch for the current composition cycle. */
	private gitBranchCache: string | null = null;
	/** Whether the git branch has been fetched in the current cycle. */
	private gitBranchFetched: boolean = false;

	// ─── Core State Access ──────────────────────────────────────

	/**
	 * Reset all state to defaults.
	 * Call on session start, switch, or fork.
	 */
	reset(): void {
		this.state = createDefaultState();
		this.gitBranchCache = null;
		this.gitBranchFetched = false;
	}

	/**
	 * Return an immutable snapshot of the current state.
	 * The returned object is frozen — callers must not mutate it.
	 */
	snapshot(): Readonly<RuntimeState> {
		return Object.freeze({ ...this.state });
	}

	// ─── State Updates ──────────────────────────────────────────

	/** Update the current working directory. */
	setCwd(cwd: string): void {
		this.state.cwd = cwd;
	}

	/** Set the set of tool names currently active for the agent. */
	setActiveTools(tools: Set<string>): void {
		this.state.activeTools = new Set(tools);
	}

	/** Set the full set of known tool names (including inactive). */
	setAllTools(tools: Set<string>): void {
		this.state.allTools = new Set(tools);
	}

	/**
	 * Set the context window usage percentage.
	 * Pass null when the value is unknown.
	 */
	setTokenUsage(percent: number | null): void {
		this.state.tokenUsagePercent = percent;
	}

	/** Set the number of available skills for the current session. */
	setSkillsCount(count: number): void {
		this.state.skillsCount = count;
	}

	/**
	 * Set the active model name and its capability tags.
	 * Capabilities are stored as a Set (e.g., "reasoning", "image").
	 */
	setModel(name: string, capabilities: string[]): void {
		this.state.modelName = name;
		this.state.modelCapabilities = new Set(capabilities);
	}

	/**
	 * Record a tool invocation.
	 * Updates toolLastUsedAtTurn and increments toolUsageCount.
	 */
	recordToolCall(toolName: string): void {
		this.state.toolLastUsedAtTurn.set(toolName, this.state.turnCount);
		const prev = this.state.toolUsageCount.get(toolName) ?? 0;
		this.state.toolUsageCount.set(toolName, prev + 1);
	}

	/** Increment the turn counter. Call at turn_end. */
	incrementTurn(): void {
		this.state.turnCount += 1;
	}

	// ─── Reminder Tracking ──────────────────────────────────────

	/**
	 * Record that an L4 reminder was triggered.
	 * Stores the current turn number and increments the trigger count.
	 */
	recordReminderTriggered(templateName: string): void {
		this.state.reminderLastTriggered.set(templateName, this.state.turnCount);
		const prev = this.state.reminderTriggerCount.get(templateName) ?? 0;
		this.state.reminderTriggerCount.set(templateName, prev + 1);
	}

	/**
	 * Return true if the reminder's cooldown period has elapsed
	 * (or if it has never been triggered), meaning it may fire again.
	 *
	 * Cooldown = minimum number of turns that must have passed
	 * since the last trigger before the reminder can fire again.
	 */
	isReminderCooledDown(templateName: string, cooldown: number): boolean {
		const lastTurn = this.state.reminderLastTriggered.get(templateName);
		if (lastTurn === undefined) {
			// Never triggered — always cooled down.
			return true;
		}
		return this.state.turnCount - lastTurn >= cooldown;
	}

	/**
	 * Return true if the reminder has been triggered at least maxTriggers
	 * times this session, meaning it should no longer fire.
	 */
	isReminderMaxed(templateName: string, maxTriggers: number): boolean {
		const count = this.state.reminderTriggerCount.get(templateName) ?? 0;
		return count >= maxTriggers;
	}

	// ─── Per-Prompt Cache Invalidation ──────────────────────────

	/**
	 * Invalidate caches that are scoped to a single prompt composition cycle.
	 * Called at the start of each before_agent_start hook invocation.
	 *
	 * Clears:
	 * - File/directory existence cache (in condition-engine)
	 * - Git branch cache (turn-scoped, re-fetched each composition)
	 */
	invalidatePerPromptCaches(): void {
		this.gitBranchCache = null;
		this.gitBranchFetched = false;
	}

	// ─── Git Branch ─────────────────────────────────────────────

	/**
	 * Return the current git branch name, or null on failure.
	 *
	 * Result is cached for the duration of the current composition cycle
	 * and cleared by invalidatePerPromptCaches().
	 *
	 * Uses a 500ms timeout. Returns null if:
	 * - Not in a git repository
	 * - git is not installed
	 * - Command times out
	 * - Any other error occurs
	 */
	getGitBranch(): string | null {
		if (this.gitBranchFetched) {
			return this.gitBranchCache;
		}

		this.gitBranchFetched = true;

		try {
			const result = execSync("git rev-parse --abbrev-ref HEAD", {
				timeout: 500,
				cwd: this.state.cwd,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.gitBranchCache = result.trim() || null;
		} catch {
			this.gitBranchCache = null;
		}

		return this.gitBranchCache;
	}
}
