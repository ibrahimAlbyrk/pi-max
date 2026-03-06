/**
 * Task Management Feature — Type Definitions
 *
 * All interfaces, types, and constants for the built-in task management feature.
 * Migrated from .pi/extensions/task-management/types.ts and related modules.
 */

// ─── Status & Priority ──────────────────────────────────────────

export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "deferred" | "done";
export type TaskPriority = "critical" | "high" | "medium" | "low";

export const ALL_STATUSES: readonly TaskStatus[] = [
	"todo",
	"in_progress",
	"in_review",
	"blocked",
	"deferred",
	"done",
] as const;

export const ALL_PRIORITIES: readonly TaskPriority[] = ["critical", "high", "medium", "low"] as const;

// ─── Task Note ───────────────────────────────────────────────────

export interface TaskNote {
	timestamp: string; // ISO 8601
	author: "user" | "agent";
	text: string;
}

// ─── Task Group ──────────────────────────────────────────────────

export interface TaskGroup {
	id: number;
	name: string;
	description: string;
	createdAt: string; // ISO 8601
}

// ─── Task ────────────────────────────────────────────────────────

export interface Task {
	id: number;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	tags: string[];
	groupId: number | null;
	dependsOn: number[];
	sprintId: number | null;
	notes: TaskNote[];
	estimatedMinutes: number | null;
	actualMinutes: number | null;
	startedAt: string | null; // ISO 8601
	completedAt: string | null; // ISO 8601
	createdAt: string; // ISO 8601
	assignee: "user" | "agent" | null;

	// ─── Agent Assignment (set by subagent system) ───────────────
	agentId: string | null;
	agentName: string | null;
	agentColor: string | null;
}

// ─── Sprint ──────────────────────────────────────────────────────

export interface Sprint {
	id: number;
	name: string;
	description: string;
	status: "planned" | "active" | "completed";
	startDate: string | null;
	endDate: string | null;
	completedDate: string | null;
	createdAt: string; // ISO 8601
}

// ─── Task Store ──────────────────────────────────────────────────

export interface TaskStore {
	tasks: Task[];
	groups: TaskGroup[];
	sprints: Sprint[];
	nextTaskId: number;
	nextGroupId: number;
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
	groupId: number | null;
	sprintId: number | null;
	agentName: string | null;
	agentColor: string | null;
}

export interface GroupIndexEntry {
	name: string;
}

export interface SprintIndexEntry {
	name: string;
	status: "planned" | "active" | "completed";
}

export interface TaskIndex {
	version: number;
	nextTaskId: number;
	nextGroupId: number;
	nextSprintId: number;
	activeTaskId: number | null;
	activeSprintId: number | null;
	tasks: Record<string, TaskIndexEntry>;
	groups: Record<string, GroupIndexEntry>;
	sprints: Record<string, SprintIndexEntry>;
}

// ─── Tool Details (persisted in tool result) ─────────────────────

export interface TaskToolDetails {
	store: TaskStore;
	action: string;
	/** Tasks removed from the active store during complete_sprint (for storage archiving) */
	archivedTasks?: Task[];
	/** Sprint archived during complete_sprint (for storage archiving) */
	archivedSprint?: Sprint;
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
	groupId?: number;
	assignee?: "user" | "agent";
	estimatedMinutes?: number;
	text?: string;
	filterStatus?: TaskStatus;
	filterPriority?: TaskPriority;
	filterTag?: string;
	filterGroupId?: number;
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

// ─── Storage Interface ───────────────────────────────────────────

export interface TaskStorage {
	/** Load full store from disk into memory */
	load(): TaskStore;
	/** Save full store to disk (writes all files) */
	save(store: TaskStore): void;
	/** Save a single task file + update index */
	saveTask(task: Task, store: TaskStore): void;
	/** Save a single group file + update index */
	saveGroup(group: TaskGroup, store: TaskStore): void;
	/** Save a single sprint file + update index */
	saveSprint(sprint: Sprint, store: TaskStore): void;
	/** Delete a task file + update index */
	deleteTask(id: number, store: TaskStore): void;
	/** Delete a group file + update index */
	deleteGroup(id: number, store: TaskStore): void;
	/** Save only the index (meta changes like activeTaskId) */
	saveIndex(store: TaskStore): void;
	/** Move tasks to archive directory, remove from active */
	archiveTasks(tasks: Task[], store: TaskStore): void;
	/** Move sprints to archive directory, remove from active */
	archiveSprints(sprints: Sprint[], store: TaskStore): void;
	/** Load archived tasks (for metrics/history) */
	loadArchivedTasks(): Task[];
	/** Load archived sprints (for metrics/history) */
	loadArchivedSprints(): Sprint[];
	/** Base directory path */
	readonly basePath: string;
}

// ─── Automation Configuration ────────────────────────────────────

export interface TaskAutomationConfig {
	autoStartOnFileEdit: boolean;
	autoCompleteOnTestPass: boolean;
	autoNoteOnAgentEnd: boolean;
}

export const DEFAULT_AUTOMATION_CONFIG: TaskAutomationConfig = {
	autoStartOnFileEdit: true,
	autoCompleteOnTestPass: true,
	autoNoteOnAgentEnd: true,
};

// ─── Sync Configuration ──────────────────────────────────────────

export interface SyncConfig {
	enabled: boolean;
	path: string;
	format: "summary" | "full";
	autoSync: boolean;
	syncOnExit: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
	enabled: false,
	path: "TASKS.md",
	format: "summary",
	autoSync: false,
	syncOnExit: false,
};

// ─── Turn Tracker Types ──────────────────────────────────────────

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

/** Structural interface for activity tracking within a turn */
export interface ActivityTracker {
	reset(): void;
	trackFile(path: string, operation: "edit" | "write" | "read"): void;
	trackBash(command: string, output: string, isTestRun: boolean): void;
	trackToolCall(): void;
	getActivity(): Readonly<TurnActivity>;
	hasActivity(): boolean;
	getModifiedFiles(): string[];
	buildActivitySummary(): string | null;
}

// ─── Task Event Types ────────────────────────────────────────────

export interface TaskCreatedEvent {
	task: Task;
}

export interface TaskUpdatedEvent {
	task: Task;
	changes: Partial<Task>;
}

export interface TaskDeletedEvent {
	taskId: number;
	title: string;
}

export interface TaskStatusChangedEvent {
	task: Task;
	oldStatus: TaskStatus;
	newStatus: TaskStatus;
}

export interface TaskCompletedEvent {
	task: Task;
}

export interface TaskStartedEvent {
	task: Task;
}

export interface TaskBlockedEvent {
	task: Task;
	reason: string;
}

export interface TaskSprintAssignedEvent {
	task: Task;
	sprint: Sprint;
}

export interface TaskNoteAddedEvent {
	task: Task;
	noteText: string;
	author: "user" | "agent";
}

export interface TaskAutoStartedEvent {
	task: Task;
	filePath: string;
}

/** Structural interface for emitting task events */
export interface TaskEventChannel {
	created(task: Task): void;
	updated(task: Task, changes: Partial<Task>): void;
	deleted(taskId: number, title: string): void;
	statusChanged(task: Task, oldStatus: TaskStatus, newStatus: TaskStatus): void;
	completed(task: Task): void;
	started(task: Task): void;
	blocked(task: Task, reason: string): void;
	sprintAssigned(task: Task, sprint: Sprint): void;
	noteAdded(task: Task, noteText: string, author: "user" | "agent"): void;
	autoStarted(task: Task, filePath: string): void;
}

// ─── Event Name Constants ────────────────────────────────────────

export const TASK_EVENTS = {
	CREATED: "task:created",
	UPDATED: "task:updated",
	DELETED: "task:deleted",
	STATUS_CHANGED: "task:status_changed",
	COMPLETED: "task:completed",
	STARTED: "task:started",
	BLOCKED: "task:blocked",
	SPRINT_ASSIGNED: "task:sprint_assigned",
	NOTE_ADDED: "task:note_added",
	AUTO_STARTED: "task:auto_started",
} as const;

// ─── Task Context Interface ──────────────────────────────────────
//
// Defines what the SharedContext class instance exposes to all hook
// and action modules. The concrete class is implemented in state.ts
// (or index.ts). This interface is the contract.

export interface TaskContext {
	/** Current in-memory task store (mutable) */
	store: TaskStore;
	/** File storage backend (null until session_start) */
	storage: TaskStorage | null;
	/** Automation toggles */
	automationConfig: TaskAutomationConfig;
	/** TASKS.md sync settings */
	syncConfig: SyncConfig;
	/** Task event channel for inter-feature communication */
	taskEvents: TaskEventChannel;
	/** Per-turn activity tracker */
	turnTracker: ActivityTracker;
	/** Whether the editor widget is collapsed */
	widgetCollapsed: boolean;

	// ── Utility functions (bound in setup) ──────────────────────
	saveToFile(): void;
	saveTaskFile(taskId: number): void;
	saveIndex(): void;
}
