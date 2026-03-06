/**
 * Task Storage — Per-file persistence layer
 *
 * Directory structure:
 *   .pi/tasks/
 *   ├── index.json              # Lightweight metadata for fast queries
 *   ├── tasks/
 *   │   ├── 1.json              # Active task files
 *   │   ├── 2.json
 *   │   └── ...
 *   ├── sprints/
 *   │   ├── 1.json              # Active sprint files
 *   │   └── ...
 *   └── archive/
 *       ├── tasks/
 *       │   ├── 5.json          # Archived (done) task files
 *       │   └── ...
 *       └── sprints/
 *           ├── 1.json          # Archived (completed) sprint files
 *           └── ...
 *
 * Archiving: Done tasks and completed sprints are moved from active
 * directories to archive/ to keep the working set small. Archived data
 * is preserved for velocity/metric calculations and history queries.
 *
 * Migration: On first load, if .pi/tasks.json (old format) exists,
 * it is automatically migrated to the per-file structure.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import type { Task, TaskGroup, Sprint, TaskStore, TaskIndex, TaskIndexEntry, GroupIndexEntry, SprintIndexEntry } from "./types.js";
import { createDefaultStore, recalculateNextIds } from "./store.js";

// ─── Interface ───────────────────────────────────────────────────

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

	// ─── Archive ──────────────────────────────────────────────
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

// ─── Per-File Implementation ─────────────────────────────────────

export class PerFileTaskStorage implements TaskStorage {
	public readonly basePath: string;
	private readonly tasksDir: string;
	private readonly groupsDir: string;
	private readonly sprintsDir: string;
	private readonly archiveTasksDir: string;
	private readonly archiveSprintsDir: string;
	private readonly indexPath: string;
	private readonly oldFormatPath: string;

	constructor(cwd: string) {
		this.basePath = join(cwd, ".pi", "tasks");
		this.tasksDir = join(this.basePath, "tasks");
		this.groupsDir = join(this.basePath, "groups");
		this.sprintsDir = join(this.basePath, "sprints");
		this.archiveTasksDir = join(this.basePath, "archive", "tasks");
		this.archiveSprintsDir = join(this.basePath, "archive", "sprints");
		this.indexPath = join(this.basePath, "index.json");
		this.oldFormatPath = join(cwd, ".pi", "tasks.json");
	}

	// ─── Load ────────────────────────────────────────────────────

	load(): TaskStore {
		// Check for old single-file format and migrate if needed
		if (this.needsMigration()) {
			return this.migrateFromOldFormat();
		}

		// No data at all → fresh store
		if (!existsSync(this.indexPath)) {
			return createDefaultStore();
		}

		try {
			return this.loadFromPerFile();
		} catch (err) {
			console.error(`[task-management] Failed to load per-file store: ${err}`);
			return createDefaultStore();
		}
	}

	private loadFromPerFile(): TaskStore {
		// 1. Read index
		const index = this.readIndex();
		if (!index) return createDefaultStore();

		// 2. Read all task files
		const tasks: Task[] = [];
		if (existsSync(this.tasksDir)) {
			const files = readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.tasksDir, file), "utf-8");
					const task = JSON.parse(raw) as Task;
					tasks.push(task);
				} catch (err) {
					console.error(`[task-management] Failed to read task file ${file}: ${err}`);
				}
			}
		}

		// Sort tasks by id for consistent ordering
		tasks.sort((a, b) => a.id - b.id);

		// 3. Read all group files
		const groups: TaskGroup[] = [];
		if (existsSync(this.groupsDir)) {
			const files = readdirSync(this.groupsDir).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.groupsDir, file), "utf-8");
					const group = JSON.parse(raw) as TaskGroup;
					groups.push(group);
				} catch (err) {
					console.error(`[task-management] Failed to read group file ${file}: ${err}`);
				}
			}
		}

		// Sort groups by id
		groups.sort((a, b) => a.id - b.id);

		// 4. Read all sprint files
		const sprints: Sprint[] = [];
		if (existsSync(this.sprintsDir)) {
			const files = readdirSync(this.sprintsDir).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.sprintsDir, file), "utf-8");
					const sprint = JSON.parse(raw) as Sprint;
					sprints.push(sprint);
				} catch (err) {
					console.error(`[task-management] Failed to read sprint file ${file}: ${err}`);
				}
			}
		}

		// Sort sprints by id
		sprints.sort((a, b) => a.id - b.id);

		// 5. Reconstruct TaskStore
		const store: TaskStore = {
			tasks,
			groups,
			sprints,
			nextTaskId: index.nextTaskId,
			nextGroupId: index.nextGroupId ?? 1,
			nextSprintId: index.nextSprintId,
			activeTaskId: index.activeTaskId,
			activeSprintId: index.activeSprintId,
		};

		// 6. Migrate parentId → groupId if old-format tasks detected
		this.migrateParentIdToGroupId(store);

		// 7. Validate & fix index: ensure nextIds match actual disk state
		recalculateNextIds(store);
		this.writeIndex(store);

		// Clear activeTaskId if task no longer exists
		if (store.activeTaskId !== null && !tasks.some((t) => t.id === store.activeTaskId)) {
			store.activeTaskId = null;
			this.writeIndex(store);
		}

		return store;
	}

	/**
	 * Migrate old parentId-based hierarchy to groupId-based groups.
	 * When loading, if any tasks still have `parentId` set (old format),
	 * convert parent tasks into groups and assign children to those groups.
	 */
	private migrateParentIdToGroupId(store: TaskStore): void {
		// Check if any tasks have the old parentId field
		const tasksWithParentId = store.tasks.filter((t) => (t as any).parentId != null);
		if (tasksWithParentId.length === 0) return;

		console.error("[task-management] Migrating parentId hierarchy to task groups...");

		// Find unique parent task IDs
		const parentIds = new Set(tasksWithParentId.map((t) => (t as any).parentId as number));

		// For each parent, create a group and reassign children
		for (const parentId of parentIds) {
			const parentTask = store.tasks.find((t) => t.id === parentId);
			if (!parentTask) continue;

			// Create a group from the parent task
			const group: TaskGroup = {
				id: store.nextGroupId,
				name: parentTask.title,
				description: parentTask.description || "",
				createdAt: parentTask.createdAt,
			};
			store.groups.push(group);
			store.nextGroupId++;

			// Assign children to the new group
			for (const child of store.tasks) {
				if ((child as any).parentId === parentId) {
					child.groupId = group.id;
					delete (child as any).parentId;
				}
			}

			// Remove the parent task (it's now a group)
			store.tasks = store.tasks.filter((t) => t.id !== parentId);
		}

		// Clean remaining parentId fields
		for (const task of store.tasks) {
			if ((task as any).parentId !== undefined) {
				if (task.groupId === undefined || task.groupId === null) {
					task.groupId = null;
				}
				delete (task as any).parentId;
			}
		}

		// Persist migrated state
		this.save(store);
		console.error(`[task-management] Migration complete: ${parentIds.size} parent task(s) converted to groups.`);
	}

	// ─── Save (full store) ───────────────────────────────────────

	save(store: TaskStore): void {
		try {
			this.ensureDirectories();

			// 1. Determine which task files currently exist on disk
			const existingTaskFiles = this.getExistingIds(this.tasksDir);
			const currentTaskIds = new Set(store.tasks.map((t) => t.id));

			// 2. Write each task to its own file (atomic via temp+rename)
			for (const task of store.tasks) {
				this.writeTaskFile(task);
			}

			// 3. Remove deleted task files
			for (const existingId of existingTaskFiles) {
				if (!currentTaskIds.has(existingId)) {
					this.removeFile(join(this.tasksDir, `${existingId}.json`));
				}
			}

			// 4. Determine which group files currently exist on disk
			const existingGroupFiles = this.getExistingIds(this.groupsDir);
			const currentGroupIds = new Set(store.groups.map((g) => g.id));

			// 5. Write each group to its own file
			for (const group of store.groups) {
				this.writeGroupFile(group);
			}

			// 6. Remove deleted group files
			for (const existingId of existingGroupFiles) {
				if (!currentGroupIds.has(existingId)) {
					this.removeFile(join(this.groupsDir, `${existingId}.json`));
				}
			}

			// 7. Determine which sprint files currently exist on disk
			const existingSprintFiles = this.getExistingIds(this.sprintsDir);
			const currentSprintIds = new Set(store.sprints.map((s) => s.id));

			// 8. Write each sprint to its own file
			for (const sprint of store.sprints) {
				this.writeSprintFile(sprint);
			}

			// 9. Remove deleted sprint files
			for (const existingId of existingSprintFiles) {
				if (!currentSprintIds.has(existingId)) {
					this.removeFile(join(this.sprintsDir, `${existingId}.json`));
				}
			}

			// 10. Write index
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to save store: ${err}`);
		}
	}

	// ─── Granular Save (single task) ─────────────────────────────

	saveTask(task: Task, store: TaskStore): void {
		try {
			this.ensureDirectories();
			this.writeTaskFile(task);
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to save task #${task.id}: ${err}`);
		}
	}

	// ─── Granular Save (single group) ────────────────────────────

	saveGroup(group: TaskGroup, store: TaskStore): void {
		try {
			this.ensureDirectories();
			this.writeGroupFile(group);
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to save group #G${group.id}: ${err}`);
		}
	}

	// ─── Delete Group File ───────────────────────────────────────

	deleteGroup(id: number, store: TaskStore): void {
		try {
			this.removeFile(join(this.groupsDir, `${id}.json`));
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to delete group #G${id}: ${err}`);
		}
	}

	// ─── Granular Save (single sprint) ───────────────────────────

	saveSprint(sprint: Sprint, store: TaskStore): void {
		try {
			this.ensureDirectories();
			this.writeSprintFile(sprint);
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to save sprint #S${sprint.id}: ${err}`);
		}
	}

	// ─── Delete Task File ────────────────────────────────────────

	deleteTask(id: number, store: TaskStore): void {
		try {
			this.removeFile(join(this.tasksDir, `${id}.json`));
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to delete task #${id}: ${err}`);
		}
	}

	// ─── Save Index Only ─────────────────────────────────────────

	saveIndex(store: TaskStore): void {
		try {
			this.ensureDirectories();
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to save index: ${err}`);
		}
	}

	// ─── Archive ─────────────────────────────────────────────────

	archiveTasks(tasks: Task[], store: TaskStore): void {
		if (tasks.length === 0) return;
		try {
			this.ensureArchiveDirectories();
			for (const task of tasks) {
				// Write to archive
				const archivePath = join(this.archiveTasksDir, `${task.id}.json`);
				this.atomicWrite(archivePath, JSON.stringify(task, null, 2));
				// Remove from active
				this.removeFile(join(this.tasksDir, `${task.id}.json`));
			}
			// Update index (archived tasks are no longer in store.tasks)
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to archive tasks: ${err}`);
		}
	}

	archiveSprints(sprints: Sprint[], store: TaskStore): void {
		if (sprints.length === 0) return;
		try {
			this.ensureArchiveDirectories();
			for (const sprint of sprints) {
				const archivePath = join(this.archiveSprintsDir, `${sprint.id}.json`);
				this.atomicWrite(archivePath, JSON.stringify(sprint, null, 2));
				this.removeFile(join(this.sprintsDir, `${sprint.id}.json`));
			}
			this.writeIndex(store);
		} catch (err) {
			console.error(`[task-management] Failed to archive sprints: ${err}`);
		}
	}

	loadArchivedTasks(): Task[] {
		const tasks: Task[] = [];
		if (!existsSync(this.archiveTasksDir)) return tasks;
		try {
			const files = readdirSync(this.archiveTasksDir).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.archiveTasksDir, file), "utf-8");
					tasks.push(JSON.parse(raw) as Task);
				} catch { /* skip corrupt files */ }
			}
			tasks.sort((a, b) => a.id - b.id);
		} catch { /* dir read failure */ }
		return tasks;
	}

	loadArchivedSprints(): Sprint[] {
		const sprints: Sprint[] = [];
		if (!existsSync(this.archiveSprintsDir)) return sprints;
		try {
			const files = readdirSync(this.archiveSprintsDir).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(this.archiveSprintsDir, file), "utf-8");
					sprints.push(JSON.parse(raw) as Sprint);
				} catch { /* skip corrupt files */ }
			}
			sprints.sort((a, b) => a.id - b.id);
		} catch { /* dir read failure */ }
		return sprints;
	}

	private ensureArchiveDirectories(): void {
		if (!existsSync(this.archiveTasksDir)) {
			mkdirSync(this.archiveTasksDir, { recursive: true });
		}
		if (!existsSync(this.archiveSprintsDir)) {
			mkdirSync(this.archiveSprintsDir, { recursive: true });
		}
	}

	// ─── Migration ───────────────────────────────────────────────

	private needsMigration(): boolean {
		// Old format exists AND new format doesn't exist yet
		return existsSync(this.oldFormatPath) && !existsSync(this.indexPath);
	}

	private migrateFromOldFormat(): TaskStore {
		console.error("[task-management] Migrating from tasks.json to per-file format...");

		try {
			const raw = readFileSync(this.oldFormatPath, "utf-8");
			const data = JSON.parse(raw) as TaskStore;

			const store: TaskStore = {
				tasks: data.tasks ?? [],
				groups: (data as any).groups ?? [],
				sprints: data.sprints ?? [],
				nextTaskId: data.nextTaskId ?? 1,
				nextGroupId: (data as any).nextGroupId ?? 1,
				nextSprintId: data.nextSprintId ?? 1,
				activeTaskId: data.activeTaskId ?? null,
				activeSprintId: data.activeSprintId ?? null,
			};

			// Migrate parentId → groupId if needed
			this.migrateParentIdToGroupId(store);

			// Write to new per-file format
			this.save(store);

			// Rename old file as backup (don't delete — safety net)
			const backupPath = this.oldFormatPath + ".backup";
			try {
				renameSync(this.oldFormatPath, backupPath);
				console.error(`[task-management] Migration complete. Old file backed up to ${backupPath}`);
			} catch {
				console.error("[task-management] Migration complete. Could not rename old file.");
			}

			return store;
		} catch (err) {
			console.error(`[task-management] Migration failed: ${err}`);
			return createDefaultStore();
		}
	}

	// ─── Internal: File Operations ───────────────────────────────

	private ensureDirectories(): void {
		if (!existsSync(this.tasksDir)) {
			mkdirSync(this.tasksDir, { recursive: true });
		}
		if (!existsSync(this.groupsDir)) {
			mkdirSync(this.groupsDir, { recursive: true });
		}
		if (!existsSync(this.sprintsDir)) {
			mkdirSync(this.sprintsDir, { recursive: true });
		}
	}

	private readIndex(): TaskIndex | null {
		try {
			const raw = readFileSync(this.indexPath, "utf-8");
			return JSON.parse(raw) as TaskIndex;
		} catch {
			return null;
		}
	}

	private writeIndex(store: TaskStore): void {
		const index: TaskIndex = {
			version: 2,
			nextTaskId: store.nextTaskId,
			nextGroupId: store.nextGroupId,
			nextSprintId: store.nextSprintId,
			activeTaskId: store.activeTaskId,
			activeSprintId: store.activeSprintId,
			tasks: {},
			groups: {},
			sprints: {},
		};

		for (const task of store.tasks) {
			index.tasks[String(task.id)] = {
				status: task.status,
				priority: task.priority,
				title: task.title,
				assignee: task.assignee,
				groupId: task.groupId,
				sprintId: task.sprintId,
				agentName: task.agentName ?? null,
				agentColor: task.agentColor ?? null,
			};
		}

		for (const group of store.groups) {
			index.groups[String(group.id)] = {
				name: group.name,
			};
		}

		for (const sprint of store.sprints) {
			index.sprints[String(sprint.id)] = {
				name: sprint.name,
				status: sprint.status,
			};
		}

		this.atomicWrite(this.indexPath, JSON.stringify(index, null, 2));
	}

	private writeTaskFile(task: Task): void {
		const filePath = join(this.tasksDir, `${task.id}.json`);
		this.atomicWrite(filePath, JSON.stringify(task, null, 2));
	}

	private writeGroupFile(group: TaskGroup): void {
		const filePath = join(this.groupsDir, `${group.id}.json`);
		this.atomicWrite(filePath, JSON.stringify(group, null, 2));
	}

	private writeSprintFile(sprint: Sprint): void {
		const filePath = join(this.sprintsDir, `${sprint.id}.json`);
		this.atomicWrite(filePath, JSON.stringify(sprint, null, 2));
	}

	/**
	 * Atomic write: write to temp file, then rename.
	 * rename() is atomic on most filesystems — prevents partial writes.
	 */
	private atomicWrite(filePath: string, content: string): void {
		const tmpPath = filePath + ".tmp";
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, filePath);
	}

	private removeFile(filePath: string): void {
		try {
			if (existsSync(filePath)) {
				unlinkSync(filePath);
			}
		} catch {
			// Silently ignore — file might already be gone
		}
	}

	private getExistingIds(dir: string): number[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => parseInt(f.replace(".json", ""), 10))
			.filter((id) => !isNaN(id));
	}
}
