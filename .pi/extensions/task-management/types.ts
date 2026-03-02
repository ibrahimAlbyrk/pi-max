/**
 * Task Management Extension — Type Definitions
 *
 * All interfaces, types, and constants used across the extension.
 * Phase 3+ fields (sprints, dependencies, time) are included now
 * to avoid schema migration later — they default to null/empty.
 */

// ─── Status & Priority ──────────────────────────────────────────

export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "deferred" | "done";
export type TaskPriority = "critical" | "high" | "medium" | "low";

export const ALL_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "blocked", "deferred", "done"] as const;
export const ALL_PRIORITIES: readonly TaskPriority[] = ["critical", "high", "medium", "low"] as const;

// ─── Task Note ───────────────────────────────────────────────────

export interface TaskNote {
	timestamp: string; // ISO 8601
	author: "user" | "agent";
	text: string;
}

// ─── Task ────────────────────────────────────────────────────────

export interface Task {
	id: number;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	tags: string[];
	parentId: number | null;
	dependsOn: number[];
	sprintId: number | null;
	notes: TaskNote[];
	estimatedMinutes: number | null;
	actualMinutes: number | null;
	startedAt: string | null; // ISO 8601
	completedAt: string | null; // ISO 8601
	createdAt: string; // ISO 8601
	assignee: "user" | "agent" | null;

	// ─── Agent Assignment (cross-extension, set by subagent system) ──
	agentId: string | null;
	agentName: string | null;
	agentColor: string | null;
}

// ─── Sprint (Phase 3 — stored now, logic later) ─────────────────

export interface Sprint {
	id: number;
	name: string;
	description: string;
	status: "planned" | "active" | "completed";
	startDate: string | null;
	endDate: string | null;
	completedDate: string | null;
	createdAt: string;
}

// ─── Task Store ──────────────────────────────────────────────────

export interface TaskStore {
	tasks: Task[];
	sprints: Sprint[];
	nextTaskId: number;
	nextSprintId: number;
	activeTaskId: number | null;
	activeSprintId: number | null;
}

// ─── Per-File Index (lightweight metadata for fast queries) ──────

export interface TaskIndexEntry {
	status: TaskStatus;
	priority: TaskPriority;
	title: string;
	assignee: "user" | "agent" | null;
	parentId: number | null;
	sprintId: number | null;
	agentName: string | null;
	agentColor: string | null;
}

export interface SprintIndexEntry {
	name: string;
	status: "planned" | "active" | "completed";
}

export interface TaskIndex {
	version: number;
	nextTaskId: number;
	nextSprintId: number;
	activeTaskId: number | null;
	activeSprintId: number | null;
	tasks: Record<string, TaskIndexEntry>;
	sprints: Record<string, SprintIndexEntry>;
}

// ─── Tool Details (persisted in tool result) ─────────────────────

export interface TaskToolDetails {
	store: TaskStore;
	action: string;
}

// ─── Tool Result ─────────────────────────────────────────────────

export interface TaskToolResult {
	content: { type: "text"; text: string }[];
	details: TaskToolDetails;
}

// ─── Action Params (typed subset of tool params) ─────────────────

export interface TaskActionParams {
	action: string;
	id?: number;
	ids?: number[];
	title?: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	tags?: string[];
	parentId?: number;
	assignee?: "user" | "agent";
	estimatedMinutes?: number;
	text?: string;
	filterStatus?: TaskStatus;
	filterPriority?: TaskPriority;
	filterTag?: string;
	filterParentId?: number;
	tasks?: {
		title: string;
		description?: string;
		priority?: TaskPriority;
		tags?: string[];
		parentId?: number;
		assignee?: "user" | "agent";
		estimatedMinutes?: number;
	}[];
}
