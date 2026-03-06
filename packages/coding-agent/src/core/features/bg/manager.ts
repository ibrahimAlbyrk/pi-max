import { type ChildProcess, spawn } from "node:child_process";
import { RingBuffer } from "./ring-buffer.js";

// ── Public types ────────────────────────────────────────────────────────────

export type ProcessStatus = "running" | "stopped" | "crashed";

export interface ManagedProcess {
	name: string;
	command: string;
	pid: number;
	status: ProcessStatus;
	exitCode: number | null;
	startedAt: number;
	stoppedAt: number | null;
	cwd: string;
	buffer: RingBuffer;
	child: ChildProcess;
	linkedTaskId?: number;
}

export interface ProcessInfo {
	name: string;
	command: string;
	pid: number;
	status: ProcessStatus;
	exitCode: number | null;
	startedAt: number;
	stoppedAt: number | null;
	uptime: string;
	lastOutput: string;
	linkedTaskId?: number;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class BackgroundProcessManager {
	private processes: Map<string, ManagedProcess> = new Map();
	private onChangeCallbacks: Set<() => void> = new Set();

	// --- Change notification ---

	/**
	 * Subscribe to any process state change.
	 * Returns an unsubscribe function.
	 */
	onChange(callback: () => void): () => void {
		this.onChangeCallbacks.add(callback);
		return () => this.onChangeCallbacks.delete(callback);
	}

	private notifyChange(): void {
		for (const cb of this.onChangeCallbacks) {
			try {
				cb();
			} catch {
				// ignore subscriber errors
			}
		}
	}

	// --- Core Operations ---

	/**
	 * Spawn a new background process.
	 * Returns { name, pid } on success or { error } on failure.
	 */
	run(opts: {
		command: string;
		name?: string;
		cwd: string;
		env?: Record<string, string>;
		linkedTaskId?: number;
	}): { name: string; pid: number } | { error: string } {
		const name = opts.name ?? this.deriveName(opts.command);

		const existing = this.processes.get(name);
		if (existing) {
			if (existing.status === "running") {
				return { error: `Process "${name}" is already running (pid ${existing.pid})` };
			}
			// Allow re-use of the name when the previous process is stopped/crashed
			this.processes.delete(name);
		}

		let child: ChildProcess;
		try {
			child = spawn(opts.command, [], {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { error: `Failed to spawn "${name}": ${message}` };
		}

		if (!child.pid) {
			return { error: `Failed to spawn process "${name}"` };
		}

		const buffer = new RingBuffer();

		const managed: ManagedProcess = {
			name,
			command: opts.command,
			pid: child.pid,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			stoppedAt: null,
			cwd: opts.cwd,
			buffer,
			child,
			linkedTaskId: opts.linkedTaskId,
		};

		child.stdout?.on("data", (data: Buffer) => {
			buffer.push(data.toString());
		});

		child.stderr?.on("data", (data: Buffer) => {
			buffer.push(data.toString());
		});

		child.on("exit", (code, signal) => {
			managed.stoppedAt = Date.now();
			managed.exitCode = code;
			if (managed.status === "running") {
				// Killed by SIGTERM / SIGKILL (us) → stopped; otherwise → crashed
				managed.status = signal === "SIGTERM" || signal === "SIGKILL" ? "stopped" : "crashed";
			}
			this.notifyChange();
		});

		child.on("error", (err: Error) => {
			managed.status = "crashed";
			managed.stoppedAt = Date.now();
			buffer.push(`[ERROR] ${err.message}`);
			this.notifyChange();
		});

		this.processes.set(name, managed);
		this.notifyChange();

		return { name, pid: child.pid };
	}

	/**
	 * Stop a running process by name.
	 * Sends SIGTERM, waits up to 5 seconds, then sends SIGKILL.
	 */
	async stop(name: string): Promise<{ success: boolean; error?: string }> {
		const proc = this.processes.get(name);
		if (!proc) {
			return { success: false, error: `No process found with name "${name}"` };
		}
		if (proc.status !== "running") {
			return { success: false, error: `Process "${name}" is not running (status: ${proc.status})` };
		}

		proc.status = "stopped";
		proc.child.kill("SIGTERM");

		const forceKillTimeout = setTimeout(() => {
			try {
				proc.child.kill("SIGKILL");
			} catch {
				// Already dead
			}
		}, 5000);

		return new Promise<{ success: boolean; error?: string }>((resolve) => {
			const cleanup = () => {
				clearTimeout(forceKillTimeout);
				proc.stoppedAt = Date.now();
				this.notifyChange();
				resolve({ success: true });
			};

			// Already exited before we could attach the listener
			if (proc.child.exitCode !== null || proc.child.killed) {
				cleanup();
				return;
			}

			proc.child.once("exit", cleanup);
		});
	}

	/**
	 * Stop and re-run a process with the same command and options.
	 */
	async restart(name: string): Promise<{ name: string; pid: number } | { error: string }> {
		const proc = this.processes.get(name);
		if (!proc) {
			return { error: `No process found with name "${name}"` };
		}

		const { command, cwd, linkedTaskId } = proc;

		if (proc.status === "running") {
			await this.stop(name);
		}

		this.processes.delete(name);
		return this.run({ command, name, cwd, linkedTaskId });
	}

	/**
	 * Retrieve buffered output for a process.
	 * Defaults to the last 50 lines.
	 */
	logs(name: string, lines: number = 50): { lines: string[] } | { error: string } {
		const proc = this.processes.get(name);
		if (!proc) {
			return { error: `No process found with name "${name}"` };
		}
		return { lines: proc.buffer.getLines(lines) };
	}

	/** Return a snapshot of all tracked processes with formatted metadata. */
	list(): ProcessInfo[] {
		const result: ProcessInfo[] = [];
		for (const proc of this.processes.values()) {
			result.push({
				name: proc.name,
				command: proc.command,
				pid: proc.pid,
				status: proc.status,
				exitCode: proc.exitCode,
				startedAt: proc.startedAt,
				stoppedAt: proc.stoppedAt,
				uptime: this.formatUptime(proc),
				lastOutput: proc.buffer.getLines(1)[0] ?? "",
				linkedTaskId: proc.linkedTaskId,
			});
		}
		return result;
	}

	// --- Lifecycle ---

	/** Stop all currently running processes. Called on session shutdown. */
	async stopAll(): Promise<void> {
		const running = [...this.processes.values()].filter((p) => p.status === "running");
		await Promise.all(running.map((p) => this.stop(p.name)));
	}

	/**
	 * Immediately kill a process (SIGKILL) and remove it from tracking.
	 * Returns false if the process does not exist.
	 */
	remove(name: string): boolean {
		const proc = this.processes.get(name);
		if (!proc) return false;
		if (proc.status === "running") {
			try {
				proc.child.kill("SIGKILL");
			} catch {
				// Already dead
			}
		}
		this.processes.delete(name);
		this.notifyChange();
		return true;
	}

	/**
	 * Remove all non-running processes from the map.
	 * Returns the number of entries removed.
	 */
	cleanup(): number {
		let removed = 0;
		for (const [name, proc] of this.processes) {
			if (proc.status !== "running") {
				this.processes.delete(name);
				removed++;
			}
		}
		if (removed > 0) this.notifyChange();
		return removed;
	}

	// --- Lookup ---

	get(name: string): ManagedProcess | undefined {
		return this.processes.get(name);
	}

	getByTaskId(taskId: number): ManagedProcess | undefined {
		for (const proc of this.processes.values()) {
			if (proc.linkedTaskId === taskId) return proc;
		}
		return undefined;
	}

	/** All currently running processes (used by process exit handler). */
	listRunning(): ManagedProcess[] {
		return [...this.processes.values()].filter((p) => p.status === "running");
	}

	// --- State ---

	get size(): number {
		return this.processes.size;
	}

	get runningCount(): number {
		return [...this.processes.values()].filter((p) => p.status === "running").length;
	}

	// --- Internal ---

	/**
	 * Derive a short, filesystem-safe name from a shell command.
	 * "npm run dev" → "npm-run-dev". Appends -2, -3, … to deduplicate.
	 */
	private deriveName(command: string): string {
		const parts = command.trim().split(/\s+/).slice(0, 3);
		let name = parts
			.join("-")
			.replace(/[^a-zA-Z0-9._-]/g, "")
			.toLowerCase();

		if (this.processes.has(name)) {
			let i = 2;
			while (this.processes.has(`${name}-${i}`)) i++;
			name = `${name}-${i}`;
		}

		return name;
	}

	private formatUptime(proc: ManagedProcess): string {
		const ms = (proc.stoppedAt ?? Date.now()) - proc.startedAt;
		return formatMs(ms);
	}
}

function formatMs(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _manager: BackgroundProcessManager | null = null;

/** Return (or lazily create) the per-process BackgroundProcessManager singleton. */
export function getProcessManager(): BackgroundProcessManager {
	if (!_manager) {
		_manager = new BackgroundProcessManager();
	}
	return _manager;
}

/**
 * Dispose the singleton, stopping all running processes.
 * Fire-and-forget during process exit.
 */
export function disposeProcessManager(): void {
	if (_manager) {
		void _manager.stopAll();
		_manager = null;
	}
}

// ── Process exit handlers (Section 6.3) ─────────────────────────────────────
//
// Registered once at module load time so that child processes are cleaned up
// regardless of how this Node.js process exits.

process.on("exit", () => {
	// Synchronous: we cannot await here, so SIGKILL each child directly.
	if (!_manager) return;
	for (const proc of _manager.listRunning()) {
		try {
			proc.child.kill("SIGKILL");
		} catch {
			// Already dead
		}
	}
});

process.on("SIGTERM", () => {
	disposeProcessManager();
	process.exit(0);
});

process.on("SIGINT", () => {
	disposeProcessManager();
	process.exit(0);
});
