/**
 * Alternate screen buffer manager for full-screen TUI mode.
 *
 * Switches the terminal to alternate screen buffer (like vim, htop, lazygit)
 * giving full control over the viewport without affecting terminal scrollback.
 *
 * Clean exit guarantee: terminal is always restored, even on crash.
 */

import type { Terminal } from "./terminal.js";

export type ResizeHandler = (width: number, height: number) => void;

export class AlternateScreenManager {
	private active = false;
	private terminal: Terminal;
	private resizeHandler: ResizeHandler | null = null;
	private cleanupHandlers: (() => void)[] = [];

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	/** Whether alternate screen is currently active */
	get isActive(): boolean {
		return this.active;
	}

	/**
	 * Enter alternate screen buffer.
	 * Saves current screen content, switches to clean buffer, hides cursor.
	 */
	enter(): void {
		if (this.active) return;
		this.active = true;

		// Switch to alternate screen buffer + clear it + move cursor to home
		// Enable SGR mouse reporting (?1003h = any-event tracking for click+drag+hover, ?1006h = SGR format)
		// Enable focus reporting (?1004h) to detect tab switches and re-enable mouse reporting
		this.terminal.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1003h\x1b[?1006h\x1b[?1004h");
		// Hide cursor during rendering (shown explicitly at input position)
		this.terminal.hideCursor();

		this.setupCleanExit();
		this.setupResizeListener();
	}

	/**
	 * Exit alternate screen buffer.
	 * Restores original screen content and cursor.
	 */
	exit(): void {
		if (!this.active) return;
		this.active = false;

		// Disable focus reporting + mouse reporting + show cursor + restore original screen buffer
		this.terminal.showCursor();
		this.terminal.write("\x1b[?1004l\x1b[?1006l\x1b[?1003l\x1b[?1049l");

		this.removeCleanupHandlers();
	}

	/** Register a handler called on terminal resize */
	onResize(handler: ResizeHandler): void {
		this.resizeHandler = handler;
	}

	/** Set up process-level handlers to guarantee terminal restoration */
	private setupCleanExit(): void {
		// Handler that restores terminal state
		const restore = (): void => {
			if (this.active) {
				// Direct write to stdout — terminal object may be stopped
				// Disable focus reporting + mouse reporting + show cursor + restore screen
				process.stdout.write("\x1b[?1004l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l");
				this.active = false;
			}
		};

		// SIGINT (Ctrl+C) — restore and exit
		const sigintHandler = (): void => {
			restore();
			process.exit(130);
		};

		// SIGTERM — restore and exit
		const sigtermHandler = (): void => {
			restore();
			process.exit(143);
		};

		// Normal exit — restore
		const exitHandler = (): void => {
			restore();
		};

		// Uncaught exception — restore, then let it crash
		const uncaughtHandler = (err: Error): void => {
			restore();
			console.error("Uncaught exception:", err);
			process.exit(1);
		};

		// Unhandled rejection — restore, then let it crash
		const rejectionHandler = (reason: unknown): void => {
			restore();
			console.error("Unhandled rejection:", reason);
			process.exit(1);
		};

		process.on("SIGINT", sigintHandler);
		process.on("SIGTERM", sigtermHandler);
		process.on("exit", exitHandler);
		process.on("uncaughtException", uncaughtHandler);
		process.on("unhandledRejection", rejectionHandler);

		// Track handlers for removal
		this.cleanupHandlers = [
			() => process.removeListener("SIGINT", sigintHandler),
			() => process.removeListener("SIGTERM", sigtermHandler),
			() => process.removeListener("exit", exitHandler),
			() => process.removeListener("uncaughtException", uncaughtHandler),
			() => process.removeListener("unhandledRejection", rejectionHandler),
		];
	}

	/** Set up SIGWINCH listener for terminal resize */
	private setupResizeListener(): void {
		if (!process.stdout.isTTY) return;

		const handler = (): void => {
			if (!this.active || !this.resizeHandler) return;
			this.resizeHandler(this.terminal.columns, this.terminal.rows);
		};

		process.stdout.on("resize", handler);
		this.cleanupHandlers.push(() => process.stdout.removeListener("resize", handler));
	}

	/** Remove all process-level handlers */
	private removeCleanupHandlers(): void {
		for (const remove of this.cleanupHandlers) {
			remove();
		}
		this.cleanupHandlers = [];
	}
}
