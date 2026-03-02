/**
 * DPS State Manager
 *
 * Manages runtime state: turn counter, tool tracking, model info,
 * token usage, reminder cooldowns.
 * Provides snapshot() for condition evaluation.
 */

import type { RuntimeState } from "./types.js";
import { fileCheckCache } from "./condition-engine.js";
import { gitBranchCache } from "./variable-resolver.js";

// ============================================================================
// State Manager
// ============================================================================

export class StateManager {
	private state: RuntimeState;

	constructor() {
		this.state = createEmptyState();
	}

	/**
	 * Reset all state (on session start).
	 */
	reset(): void {
		this.state = createEmptyState();
	}

	/**
	 * Get a snapshot of current state for condition evaluation.
	 * Returns the live reference — do not mutate externally.
	 */
	snapshot(): RuntimeState {
		return this.state;
	}

	// ========================================================================
	// Turn Tracking
	// ========================================================================

	incrementTurn(): void {
		this.state.turnCount++;
	}

	getTurnCount(): number {
		return this.state.turnCount;
	}

	// ========================================================================
	// Tool Tracking
	// ========================================================================

	/**
	 * Record that a tool was called (tool_call event).
	 */
	recordToolCall(toolName: string): void {
		this.state.toolLastUsedAtTurn.set(toolName, this.state.turnCount);
		const count = this.state.toolUsageCount.get(toolName) || 0;
		this.state.toolUsageCount.set(toolName, count + 1);
	}

	/**
	 * Update the active tools list.
	 */
	setActiveTools(tools: string[]): void {
		this.state.activeTools = new Set(tools);
	}

	/**
	 * Update all tools list.
	 */
	setAllTools(tools: string[]): void {
		this.state.allTools = new Set(tools);
	}

	// ========================================================================
	// Model Tracking
	// ========================================================================

	setModel(name: string, capabilities: string[]): void {
		this.state.modelName = name;
		this.state.modelCapabilities = new Set(capabilities);
	}

	// ========================================================================
	// Context Tracking
	// ========================================================================

	setCwd(cwd: string): void {
		this.state.cwd = cwd;
	}

	setTokenUsage(percent: number | null): void {
		this.state.tokenUsagePercent = percent;
	}

	// ========================================================================
	// Reminder Tracking
	// ========================================================================

	/**
	 * Record that a reminder was triggered at current turn.
	 */
	recordReminderTriggered(segmentId: string): void {
		this.state.reminderLastTriggered.set(segmentId, this.state.turnCount);
		const count = this.state.reminderTriggerCount.get(segmentId) || 0;
		this.state.reminderTriggerCount.set(segmentId, count + 1);
	}

	/**
	 * Check if a reminder is cooled down (can fire again).
	 */
	isReminderCooledDown(segmentId: string, cooldown: number): boolean {
		const lastTriggered = this.state.reminderLastTriggered.get(segmentId);
		if (lastTriggered === undefined) return true; // Never triggered
		return this.state.turnCount - lastTriggered >= cooldown;
	}

	/**
	 * Check if a reminder has reached max triggers.
	 */
	isReminderMaxed(segmentId: string, maxTriggers: number): boolean {
		const count = this.state.reminderTriggerCount.get(segmentId) || 0;
		return count >= maxTriggers;
	}

	// ========================================================================
	// Cache Invalidation (Per-Prompt)
	// ========================================================================

	/**
	 * Invalidate turn-scoped caches.
	 * Called at the start of each prompt (before_agent_start).
	 */
	invalidatePerPromptCaches(): void {
		fileCheckCache.invalidate();
		gitBranchCache.invalidate();
	}
}

// ============================================================================
// Factory
// ============================================================================

function createEmptyState(): RuntimeState {
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
	};
}
