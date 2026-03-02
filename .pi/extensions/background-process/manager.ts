import { spawn, type ChildProcess } from "child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Ring Buffer ─────────────────────────────────────────────────────────
export class RingBuffer {
	private lines: string[] = [];
	private head = 0;
	private count = 0;

	constructor(private capacity: number = 500) {
		this.lines = new Array(capacity).fill("");
	}

	push(text: string): void {
		const newLines = text.split("\n");
		for (const line of newLines) {
			if (line === "" && newLines.length > 1) continue; // skip empty splits
			this.lines[this.head] = line;
			this.head = (this.head + 1) % this.capacity;
			if (this.count < this.capacity) this.count++;
		}
	}

	getLines(n?: number): string[] {
		const total = Math.min(n ?? this.count, this.count);
		const result: string[] = [];
		const start = (this.head - this.count + this.capacity) % this.capacity;
		const offset = this.count - total;
		for (let i = 0; i < total; i++) {
			result.push(this.lines[(start + offset + i) % this.capacity]);
		}
		return result;
	}

	get size(): number {
		return this.count;
	}

	clear(): void {
		this.head = 0;
		this.count = 0;
	}
}

// ── Types ───────────────────────────────────────────────────────────────
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

// ── Manager ─────────────────────────────────────────────────────────────
export class BackgroundProcessManager {
	private processes = new Map<string, ManagedProcess>();
	private pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	// ── Run ───────────────────────────────────────────────────────────
	run(opts: {
		command: string;
		name?: string;
		cwd?: string;
		env?: Record<string, string>;
		linkedTaskId?: number;
	}): { name: string; pid: number } | { error: string } {
		const name = opts.name ?? this.deriveName(opts.command);

		if (this.processes.has(name)) {
			const existing = this.processes.get(name)!;
			if (existing.status === "running") {
				return { error: `Process "${name}" is already running (pid ${existing.pid})` };
			}
			// Re-use name if previous process is dead
			this.processes.delete(name);
		}

		const child = spawn(opts.command, [], {
			cwd: opts.cwd ?? process.cwd(),
			env: { ...process.env, ...opts.env },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		if (!child.pid) {
			return { error: `Failed to spawn process "${name}"` };
		}

		const buffer = new RingBuffer(500);

		const managed: ManagedProcess = {
			name,
			command: opts.command,
			pid: child.pid,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			stoppedAt: null,
			cwd: opts.cwd ?? process.cwd(),
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
				// Not stopped by us → crashed
				managed.status = signal === "SIGTERM" || signal === "SIGKILL" ? "stopped" : "crashed";
				this.pi.events.emit("bg:crashed", {
					name: managed.name,
					pid: managed.pid,
					exitCode: code,
					signal,
				});
			}
		});

		child.on("error", (err: Error) => {
			managed.status = "crashed";
			managed.stoppedAt = Date.now();
			buffer.push(`[ERROR] ${err.message}`);
			this.pi.events.emit("bg:crashed", {
				name: managed.name,
				pid: managed.pid,
				error: err.message,
			});
		});

		this.processes.set(name, managed);
		this.pi.events.emit("bg:started", { name, pid: child.pid, command: opts.command });

		return { name, pid: child.pid };
	}

	// ── Stop ──────────────────────────────────────────────────────────
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

		// Force kill after 5 seconds
		const forceKillTimeout = setTimeout(() => {
			try {
				proc.child.kill("SIGKILL");
			} catch {
				// Already dead
			}
		}, 5000);

		return new Promise((resolve) => {
			proc.child.on("exit", () => {
				clearTimeout(forceKillTimeout);
				proc.stoppedAt = Date.now();
				this.pi.events.emit("bg:stopped", { name, pid: proc.pid });
				resolve({ success: true });
			});

			// If already exited
			if (proc.child.exitCode !== null || proc.child.killed) {
				clearTimeout(forceKillTimeout);
				proc.stoppedAt = Date.now();
				this.pi.events.emit("bg:stopped", { name, pid: proc.pid });
				resolve({ success: true });
			}
		});
	}

	// ── Restart ───────────────────────────────────────────────────────
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

	// ── Logs ──────────────────────────────────────────────────────────
	logs(name: string, lines: number = 50): { lines: string[] } | { error: string } {
		const proc = this.processes.get(name);
		if (!proc) {
			return { error: `No process found with name "${name}"` };
		}
		return { lines: proc.buffer.getLines(lines) };
	}

	// ── List ──────────────────────────────────────────────────────────
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

	// ── Get ───────────────────────────────────────────────────────────
	get(name: string): ManagedProcess | undefined {
		return this.processes.get(name);
	}

	// ── Get by Task ID ────────────────────────────────────────────────
	getByTaskId(taskId: number): ManagedProcess | undefined {
		for (const proc of this.processes.values()) {
			if (proc.linkedTaskId === taskId) return proc;
		}
		return undefined;
	}

	// ── Stop All ──────────────────────────────────────────────────────
	async stopAll(): Promise<void> {
		const running = [...this.processes.values()].filter((p) => p.status === "running");
		await Promise.all(running.map((p) => this.stop(p.name)));
	}

	// ── Remove (kill + delete from tracking) ─────────────────────────
	remove(name: string): boolean {
		const proc = this.processes.get(name);
		if (!proc) return false;
		if (proc.status === "running") {
			try { proc.child.kill("SIGKILL"); } catch { /* already dead */ }
		}
		this.processes.delete(name);
		return true;
	}

	// ── Cleanup (remove dead processes from map) ──────────────────────
	cleanup(): number {
		let removed = 0;
		for (const [name, proc] of this.processes) {
			if (proc.status !== "running") {
				this.processes.delete(name);
				removed++;
			}
		}
		return removed;
	}

	// ── Helpers ───────────────────────────────────────────────────────
	get size(): number {
		return this.processes.size;
	}

	get runningCount(): number {
		return [...this.processes.values()].filter((p) => p.status === "running").length;
	}

	private deriveName(command: string): string {
		// "npm run dev" → "npm-run-dev"
		// "python3 server.py --port 8080" → "python3-server.py"
		const parts = command.trim().split(/\s+/).slice(0, 3);
		let name = parts
			.join("-")
			.replace(/[^a-zA-Z0-9._-]/g, "")
			.toLowerCase();

		// Deduplicate
		if (this.processes.has(name)) {
			let i = 2;
			while (this.processes.has(`${name}-${i}`)) i++;
			name = `${name}-${i}`;
		}

		return name;
	}

	private formatUptime(proc: ManagedProcess): string {
		const end = proc.stoppedAt ?? Date.now();
		const ms = end - proc.startedAt;
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}
}
