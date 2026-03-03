import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface BudgetConfig {
	budgetLimit?: number;   // Max spend in $. Generation blocked when reached.
	budgetWarning?: number; // Warning threshold in $. Notification shown when exceeded.
}

interface BudgetState {
	totalSpent: number;
	generationCount: number;
}

interface BudgetEntry {
	totalSpent: number;
	generationCount: number;
}

const ENTRY_TYPE = "image-budget";

function readJsonFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export class BudgetTracker {
	private state: BudgetState = { totalSpent: 0, generationCount: 0 };
	private config: BudgetConfig = {};
	private persistFn?: (customType: string, data: BudgetEntry) => void;

	/** Load config from global + project JSON files. Project overrides global. */
	loadConfig(cwd: string): void {
		const globalPath = join(homedir(), ".pi", "agent", "extensions", "image-generation.json");
		const projectPath = join(cwd, ".pi", "extensions", "image-generation.json");

		const globalConfig = readJsonFile(globalPath) || {};
		const projectConfig = readJsonFile(projectPath) || {};

		const merged = { ...globalConfig, ...projectConfig };

		if (typeof merged.budgetLimit === "number") this.config.budgetLimit = merged.budgetLimit;
		if (typeof merged.budgetWarning === "number") this.config.budgetWarning = merged.budgetWarning;
	}

	/** Reconstruct state from session entries (called on session_start). */
	loadFromEntries(entries: Array<{ type: string; customType?: string; data?: unknown }>): void {
		this.state = { totalSpent: 0, generationCount: 0 };

		// Find the last budget entry — it contains cumulative state
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
				const data = entry.data as BudgetEntry;
				if (typeof data.totalSpent === "number") this.state.totalSpent = data.totalSpent;
				if (typeof data.generationCount === "number") this.state.generationCount = data.generationCount;
				break;
			}
		}
	}

	/** Set the persist function (appendEntry from ExtensionAPI). */
	setPersist(fn: (customType: string, data: BudgetEntry) => void): void {
		this.persistFn = fn;
	}

	/** Check if budget limit is reached. Returns error message or null. */
	check(): string | null {
		if (this.config.budgetLimit !== undefined && this.state.totalSpent >= this.config.budgetLimit) {
			return `Budget limit reached ($${this.state.totalSpent.toFixed(3)} / $${this.config.budgetLimit}). Image generation blocked.`;
		}
		return null;
	}

	/** Record a generation cost. Returns true if warning threshold was crossed. */
	record(cost: number): boolean {
		const wasBelowWarning = this.config.budgetWarning === undefined ||
			this.state.totalSpent < this.config.budgetWarning;

		this.state.totalSpent += cost;
		this.state.generationCount++;

		// Persist cumulative state
		this.persistFn?.(ENTRY_TYPE, {
			totalSpent: this.state.totalSpent,
			generationCount: this.state.generationCount,
		});

		// Check if we crossed the warning threshold
		if (this.config.budgetWarning !== undefined && wasBelowWarning && this.state.totalSpent >= this.config.budgetWarning) {
			return true;
		}

		// Also warn on every generation once past threshold
		if (this.config.budgetWarning !== undefined && this.state.totalSpent >= this.config.budgetWarning) {
			return true;
		}

		return false;
	}

	/** Get current budget status string for display. */
	getStatus(): string {
		const spent = `$${this.state.totalSpent.toFixed(3)}`;
		const count = `${this.state.generationCount} images`;

		if (this.config.budgetLimit !== undefined) {
			const limit = `$${this.config.budgetLimit}`;
			const remaining = `$${(this.config.budgetLimit - this.state.totalSpent).toFixed(3)}`;
			return `${spent} / ${limit} (${remaining} remaining, ${count})`;
		}

		return `${spent} spent (${count})`;
	}

	getConfig(): BudgetConfig {
		return { ...this.config };
	}

	getTotalSpent(): number {
		return this.state.totalSpent;
	}
}
