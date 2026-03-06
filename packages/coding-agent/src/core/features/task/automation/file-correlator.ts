/**
 * File-to-Task Correlator — Match file paths to tasks
 *
 * Two modes:
 *   - `findTaskByFileContext`: single-file matching used in tool_call hook for auto-start
 *   - `findBestTaskForFiles`: multi-file scoring used at agent_end for auto-note targeting
 *
 * The multi-file version scores each non-done task against ALL files edited in the turn,
 * picking the task with the highest total score.
 */

import type { Task, TaskStore } from "../types.js";

// ─── Single File Match (for auto-start) ──────────────────────────

/**
 * Find the task most relevant to the given file path.
 *
 * Priority order:
 *   1. Exact path or file name mentioned in task description/notes
 *   2. Task title keywords found in the file path
 *   3. Active task fallback
 *
 * Returns null if no reasonable match is found.
 */
export function findTaskByFileContext(store: TaskStore, filePath: string): Task | null {
	const filePathLower = filePath.toLowerCase();
	const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";

	// Priority 1: Exact path mention in description or notes
	for (const task of store.tasks) {
		if (task.status === "done") continue;
		const allText = buildSearchText(task);
		if (allText.includes(filePathLower) || allText.includes(fileName)) {
			return task;
		}
	}

	// Priority 2: Keyword matching (task title words appear in file path)
	for (const task of store.tasks) {
		if (task.status === "done") continue;
		const keywords = extractKeywords(task.title);
		if (keywords.length === 0) continue;

		const matchCount = keywords.filter((k: string) => filePathLower.includes(k)).length;
		if (matchCount >= 2 || (keywords.length <= 2 && matchCount >= 1)) {
			return task;
		}
	}

	// Priority 3: Active task fallback
	if (store.activeTaskId !== null) {
		return store.tasks.find((t: Task) => t.id === store.activeTaskId && t.status !== "done") ?? null;
	}

	return null;
}

// ─── Multi-File Scoring (for auto-note targeting) ─────────────────

export interface TaskMatchScore {
	task: Task;
	score: number;
	/** Which files contributed to the score */
	matchedFiles: string[];
}

/**
 * Given a list of files edited during a turn, find the best matching task.
 *
 * Scoring rules per file:
 *   +10  exact file path mentioned in task description/notes
 *   +5   file name mentioned in task description/notes
 *   +3   task title keyword appears in file path
 *   +2   task tag appears in file path
 *   +1   description keyword appears in file path
 *
 * Bonuses:
 *   +2   task is currently in_progress
 *   +5   task is the active task
 *
 * Returns null if no task scores at or above the minimum threshold (3).
 */
export function findBestTaskForFiles(store: TaskStore, filePaths: string[]): TaskMatchScore | null {
	if (filePaths.length === 0) return null;

	const candidates: TaskMatchScore[] = [];

	for (const task of store.tasks) {
		if (task.status === "done") continue;

		let score = 0;
		const matchedFiles: string[] = [];
		const searchText = buildSearchText(task);
		const titleKeywords = extractKeywords(task.title);
		const descKeywords = extractKeywords(task.description);
		const tagKeywords = task.tags.map((t: string) => t.toLowerCase());

		for (const filePath of filePaths) {
			const filePathLower = filePath.toLowerCase();
			const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
			let fileScore = 0;

			// Exact path match in task text
			if (searchText.includes(filePathLower)) {
				fileScore += 10;
			} else if (fileName.length > 3 && searchText.includes(fileName)) {
				// File name match in task text
				fileScore += 5;
			}

			// Title keywords in file path
			for (const kw of titleKeywords) {
				if (filePathLower.includes(kw)) fileScore += 3;
			}

			// Description keywords in file path
			for (const kw of descKeywords) {
				if (filePathLower.includes(kw)) fileScore += 1;
			}

			// Tags in file path
			for (const tag of tagKeywords) {
				if (filePathLower.includes(tag)) fileScore += 2;
			}

			if (fileScore > 0) {
				score += fileScore;
				matchedFiles.push(filePath);
			}
		}

		// Bonus: task is currently being worked on
		if (task.status === "in_progress") score += 2;

		// Bonus: this is the designated active task
		if (task.id === store.activeTaskId) score += 5;

		if (score > 0) {
			candidates.push({ task, score, matchedFiles });
		}
	}

	if (candidates.length === 0) return null;

	// Sort by score descending
	candidates.sort((a: TaskMatchScore, b: TaskMatchScore) => b.score - a.score);

	// Minimum threshold of 3 to avoid spurious matches
	const best = candidates[0];
	return best !== undefined && best.score >= 3 ? best : null;
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildSearchText(task: Task): string {
	return [task.title, task.description, ...task.notes.map((n) => n.text), ...task.tags].join(" ").toLowerCase();
}

function extractKeywords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s\-_./,;:!?()[\]{}'"]+/)
		.filter((w: string) => w.length > 3);
}
