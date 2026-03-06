/**
 * Built-in background process feature.
 *
 * This module exports the core manager primitives and a setup function
 * that wires lifecycle hooks into an agent session.
 *
 * Note: setupBgFeature() accepts a BgFeatureSession interface rather than
 * importing AgentSession directly, allowing AgentSession to gain these
 * methods incrementally (see spec section 5.1).
 */

export type { ManagedProcess, ProcessInfo, ProcessStatus } from "./manager.js";
export { BackgroundProcessManager, disposeProcessManager, getProcessManager } from "./manager.js";
export { RingBuffer } from "./ring-buffer.js";

import { getProcessManager } from "./manager.js";

/**
 * Minimal interface describing the session hooks required by setupBgFeature.
 * AgentSession will implement these once the session shutdown and event
 * mechanisms are extended (spec section 5.1).
 */
export interface BgFeatureSession {
	/** Register a handler called when the session shuts down. */
	onSessionShutdown(handler: () => Promise<void>): void;
	/** Subscribe to an internal session event. Returns an unsubscribe function. */
	onEvent(event: string, handler: (data: unknown) => void): () => void;
}

/**
 * Wire background process lifecycle hooks into an agent session.
 *
 * 1. Session shutdown → stop all running processes.
 * 2. task:completed  → auto-stop any process linked to the completed task.
 *
 * Called from AgentSession initialization after the runtime is built.
 */
export function setupBgFeature(session: BgFeatureSession): void {
	const manager = getProcessManager();

	// 1. Session shutdown → stop all processes
	session.onSessionShutdown(async () => {
		await manager.stopAll();
	});

	// 2. Task completion → auto-stop linked processes
	session.onEvent("task:completed", (data: unknown) => {
		const taskData = data as { task?: { id?: number } } | null | undefined;
		const taskId = taskData?.task?.id;
		if (taskId === undefined) return;
		const proc = manager.getByTaskId(taskId);
		if (proc?.status === "running") {
			void manager.stop(proc.name);
		}
	});
}
