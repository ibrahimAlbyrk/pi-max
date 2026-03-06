import { existsSync, type FSWatcher, watch } from "node:fs";
import { extname, join } from "node:path";
import type { EventBus } from "./event-bus.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Resource types that can be watched. Extensible — add new types here. */
export type WatchableResourceType = "skill" | "prompt" | "theme" | "extension" | "context";

/** Configuration for a single watched directory. */
export interface WatchPathConfig {
	/** Absolute path to the directory to watch. */
	path: string;
	/** Which resource type this directory contains. */
	resourceType: WatchableResourceType;
	/** Whether to watch subdirectories recursively. */
	recursive: boolean;
	/** Optional file extension filter (e.g., ".md", ".json"). Only files with this extension trigger events. */
	extensionFilter?: string;
}

/** Emitted on the EventBus when watched files change. */
export interface ResourceChangeEvent {
	type: WatchableResourceType;
	changes: ResourceFileChange[];
}

/** A single file change within a watched directory. */
export interface ResourceFileChange {
	filePath: string;
	timestamp: number;
}

// ── EventBus channel ───────────────────────────────────────────────────────

export const RESOURCE_CHANGED_CHANNEL = "resource_changed";

// ── ResourceWatcher ────────────────────────────────────────────────────────

/**
 * Watches resource directories for file changes and emits debounced events
 * on the EventBus. Each resource type is debounced independently so that
 * e.g. a skill change does not delay a prompt change notification.
 *
 * Design:
 * - Uses Node's native `fs.watch` (kernel-level: kqueue on macOS, inotify on Linux).
 * - One watcher per directory path (deduped).
 * - Debounce window is configurable (default 300ms).
 * - `dispose()` cleans up all watchers and timers.
 * - `reconcile()` allows dynamic path updates without full teardown.
 */
export class ResourceWatcher {
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly pathConfigs = new Map<string, WatchPathConfig>();
	private readonly debounceTimers = new Map<WatchableResourceType, ReturnType<typeof setTimeout>>();
	private readonly pendingChanges = new Map<WatchableResourceType, ResourceFileChange[]>();
	private disposed = false;

	constructor(
		private readonly eventBus: EventBus,
		private readonly debounceMs: number = 300,
	) {}

	// ── Public API ───────────────────────────────────────────────────────

	/** Start watching the given directories. Skips paths that don't exist or are already watched. */
	watch(configs: ReadonlyArray<WatchPathConfig>): void {
		if (this.disposed) return;

		for (const config of configs) {
			this.addWatcher(config);
		}
	}

	/**
	 * Reconcile watched paths: add new ones, remove stale ones.
	 * Paths present in both old and new sets are left untouched.
	 */
	reconcile(newConfigs: ReadonlyArray<WatchPathConfig>): void {
		if (this.disposed) return;

		const newPaths = new Set(newConfigs.map((c) => c.path));

		// Remove watchers for paths no longer in the new set
		for (const [watchedPath] of this.watchers) {
			if (!newPaths.has(watchedPath)) {
				this.removeWatcher(watchedPath);
			}
		}

		// Add watchers for new paths
		for (const config of newConfigs) {
			if (!this.watchers.has(config.path)) {
				this.addWatcher(config);
			}
		}
	}

	/** Stop all watchers and clear all pending timers. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		for (const [, watcher] of this.watchers) {
			watcher.close();
		}
		for (const [, timer] of this.debounceTimers) {
			clearTimeout(timer);
		}

		this.watchers.clear();
		this.pathConfigs.clear();
		this.debounceTimers.clear();
		this.pendingChanges.clear();
	}

	/** Whether this watcher has been disposed. */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/** Number of actively watched directories. */
	get watchCount(): number {
		return this.watchers.size;
	}

	// ── Private ──────────────────────────────────────────────────────────

	private addWatcher(config: WatchPathConfig): void {
		if (this.watchers.has(config.path)) return;
		if (!existsSync(config.path)) return;

		try {
			const fsWatcher = watch(config.path, { recursive: config.recursive }, (_eventType, filename) => {
				if (this.disposed) return;

				// On some platforms, filename may be null. Treat as a generic change.
				if (!filename) {
					this.enqueueChange(config.resourceType, {
						filePath: config.path,
						timestamp: Date.now(),
					});
					return;
				}

				// Apply extension filter if configured
				if (config.extensionFilter && extname(filename) !== config.extensionFilter) {
					return;
				}

				this.enqueueChange(config.resourceType, {
					filePath: join(config.path, filename),
					timestamp: Date.now(),
				});
			});

			fsWatcher.on("error", () => {
				this.removeWatcher(config.path);
			});

			this.watchers.set(config.path, fsWatcher);
			this.pathConfigs.set(config.path, config);
		} catch {
			// Directory may have been removed between existsSync and watch
		}
	}

	private removeWatcher(dirPath: string): void {
		const watcher = this.watchers.get(dirPath);
		if (watcher) {
			watcher.close();
			this.watchers.delete(dirPath);
			this.pathConfigs.delete(dirPath);
		}
	}

	/**
	 * Enqueue a file change and (re)start the debounce timer for its resource type.
	 * When the timer fires, all accumulated changes for that type are emitted as a single event.
	 */
	private enqueueChange(type: WatchableResourceType, change: ResourceFileChange): void {
		const pending = this.pendingChanges.get(type) ?? [];
		pending.push(change);
		this.pendingChanges.set(type, pending);

		// Reset debounce timer for this resource type
		const existingTimer = this.debounceTimers.get(type);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		this.debounceTimers.set(
			type,
			setTimeout(() => {
				if (this.disposed) return;

				const changes = this.pendingChanges.get(type) ?? [];
				this.pendingChanges.delete(type);
				this.debounceTimers.delete(type);

				if (changes.length > 0) {
					const event: ResourceChangeEvent = { type, changes };
					this.eventBus.emit(RESOURCE_CHANGED_CHANNEL, event);
				}
			}, this.debounceMs),
		);
	}
}
