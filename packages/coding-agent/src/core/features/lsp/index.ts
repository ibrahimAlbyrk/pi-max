/**
 * Built-in LSP feature.
 *
 * Exports LSP manager primitives and wires lifecycle hooks into an agent session.
 *
 * Note: setupLspFeature() accepts an LspFeatureSession interface rather than
 * importing AgentSession directly, allowing AgentSession to gain these
 * methods incrementally (see spec section 5).
 */

export { LspClient } from "./client.js";
export { disposeLspManager, getLspManager, LspManager } from "./manager.js";

import { detectAndSetup } from "./language-detector.js";
import { disposeLspManager, getLspManager } from "./manager.js";

/**
 * Minimal interface describing the session hooks required by setupLspFeature.
 * AgentSession will implement these when the LSP feature is integrated.
 */
export interface LspFeatureSession {
	/** Register a handler called when the session shuts down. */
	onSessionShutdown(handler: () => Promise<void>): void;
	/**
	 * Register a handler called when a new agent session starts.
	 * Context includes the working directory used for language detection.
	 */
	onSessionStart(handler: (ctx: { cwd: string }) => Promise<void>): void;
	/**
	 * Register a handler called after each tool result is received.
	 * Provides the tool name, input arguments, and the raw tool result.
	 */
	onToolResult(handler: (event: { toolName: string; input: unknown; result?: unknown }) => Promise<void>): void;
}

/**
 * Wire LSP lifecycle hooks into an agent session.
 *
 * 1. session_start → detect languages, start ready servers.
 * 2. session_shutdown → stop all servers.
 * 3. tool_result (edit/write) → notify LSP servers of file changes.
 *
 * Called from AgentSession initialization after the runtime is built.
 */
export function setupLspFeature(session: LspFeatureSession): void {
	const manager = getLspManager();

	// 1. Session start → detect languages, start ready servers
	session.onSessionStart(async (ctx) => {
		try {
			const readyLanguages = await detectAndSetup(ctx.cwd);
			for (const lang of readyLanguages) {
				await manager.startServer(lang.key, lang.config, ctx.cwd);
			}
		} catch (err) {
			console.error("LSP setup failed:", err);
		}
	});

	// 2. Session shutdown → stop all servers
	session.onSessionShutdown(async () => {
		await disposeLspManager();
	});

	// 3. File change notification → keep LSP servers in sync with agent edits
	session.onToolResult(async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const input = event.input as Record<string, unknown> | null | undefined;
			const filePath = input?.path;
			if (typeof filePath === "string") {
				try {
					await manager.notifyFileChanged(filePath);
				} catch {
					// Non-fatal: LSP notification failure should not break the agent
				}
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Process exit handlers
// ---------------------------------------------------------------------------
// Registered once at module load time to guarantee LSP server cleanup even
// when the session shutdown path is not reached (e.g. uncaught exceptions).

process.on("exit", () => {
	// Synchronous: kill all server processes best-effort (async not allowed here)
	getLspManager().killAll();
});

process.on("SIGTERM", () => {
	void disposeLspManager().then(() => {
		process.exit(0);
	});
});
