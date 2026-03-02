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
import type { Task, Sprint, TaskStore, TaskIndex, TaskIndexEntry, SprintIndexEntry } from "./types.js";
import { createDefaultStore, recalculateNextIds } from "./store.js";

// ─── Interface ───────────────────────────────────────────────────

export interface TaskStorage {
	/** Load full store from disk into memory */
	load(): TaskStore;
	/** Save full store to disk (writes all files) */
	save(store: TaskStore): void;
	/** Save a single task file + update index */
	saveTask(task: Task, store: TaskStore): void;
	/** Save a single sprint file + update index */
	saveSprint(sprint: Sprint, store: TaskStore): void;
	/** Delete a task file + update index */
	deleteTask(id: number, store: TaskStore): void;
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
	private readonly sprintsDir: string;
	private readonly archiveTasksDir: string;
	private readonly archiveSprintsDir: string;
	private readonly indexPath: string;
	private readonly oldFormatPath: string;

	constructor(cwd: string) {
		this.basePath = join(cwd, ".pi", "tasks");
		this.tasksDir = join(this.basePath, "tasks");
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

		// 3. Read all sprint files
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

		// 4. Reconstruct TaskStore
		const store: TaskStore = {
			tasks,
			sprints,
			nextTaskId: index.nextTaskId,
			nextSprintId: index.nextSprintId,
			activeTaskId: index.activeTaskId,
			activeSprintId: index.activeSprintId,
		};

		// 5. Validate & fix index: ensure nextIds match actual disk state
		const expectedNextTaskId = tasks.length > 0
			? Math.max(...tasks.map((t) => t.id)) + 1
			: 1;
		const expectedNextSprintId = sprints.length > 0
			? Math.max(...sprints.map((s) => s.id)) + 1
			: 1;

		if (store.nextTaskId !== expectedNextTaskId || store.nextSprintId !== expectedNextSprintId) {
			recalculateNextIds(store);
			// Persist corrected index to disk
			this.writeIndex(store);
		}

		// Clear activeTaskId if task no longer exists
		if (store.activeTaskId !== null && !tasks.some((t) => t.id === store.activeTaskId)) {
			store.activeTaskId = null;
			this.writeIndex(store);
		}

		return store;
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

			// 4. Determine which sprint files currently exist on disk
			const existingSprintFiles = this.getExistingIds(this.sprintsDir);
			const currentSprintIds = new Set(store.sprints.map((s) => s.id));

			// 5. Write each sprint to its own file
			for (const sprint of store.sprints) {
				this.writeSprintFile(sprint);
			}

			// 6. Remove deleted sprint files
			for (const existingId of existingSprintFiles) {
				if (!currentSprintIds.has(existingId)) {
					this.removeFile(join(this.sprintsDir, `${existingId}.json`));
				}
			}

			// 7. Write index
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
				sprints: data.sprints ?? [],
				nextTaskId: data.nextTaskId ?? 1,
				nextSprintId: data.nextSprintId ?? 1,
				activeTaskId: data.activeTaskId ?? null,
				activeSprintId: data.activeSprintId ?? null,
			};

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
			version: 1,
			nextTaskId: store.nextTaskId,
			nextSprintId: store.nextSprintId,
			activeTaskId: store.activeTaskId,
			activeSprintId: store.activeSprintId,
			tasks: {},
			sprints: {},
		};

		for (const task of store.tasks) {
			index.tasks[String(task.id)] = {
				status: task.status,
				priority: task.priority,
				title: task.title,
				assignee: task.assignee,
				parentId: task.parentId,
				sprintId: task.sprintId,
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
