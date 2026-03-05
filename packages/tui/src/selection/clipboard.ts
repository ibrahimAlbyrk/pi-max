/**
 * Clipboard integration for TUI text selection.
 *
 * Strategy (tried in order):
 * 1. OSC 52 — universal, works over SSH, no subprocess needed
 * 2. Platform fallback — pbcopy (macOS), xclip/xsel (Linux), clip.exe (WSL)
 */

import { execFile, spawn } from "node:child_process";
import * as os from "node:os";

/**
 * Copy text to system clipboard.
 *
 * @param text - Text to copy
 * @param terminalWrite - Function to write escape sequences to the terminal
 * @returns true if copy succeeded (or was attempted via OSC 52)
 */
export async function copyToClipboard(text: string, terminalWrite: (data: string) => void): Promise<boolean> {
	if (!text) return false;

	// Try OSC 52 first (works in most modern terminals, including over SSH)
	const base64 = Buffer.from(text, "utf-8").toString("base64");
	terminalWrite(`\x1b]52;c;${base64}\x07`);

	// Also try platform-specific fallback (OSC 52 support varies)
	try {
		await platformCopy(text);
	} catch {
		// Platform copy failed — OSC 52 may still have worked
	}

	return true;
}

/**
 * Open a URL with the system default handler.
 */
export function openUrl(url: string): void {
	const platform = os.platform();
	try {
		if (platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else if (platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		} else {
			// Linux / WSL
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// Silently fail — can't open URL
	}
}

/**
 * Platform-specific clipboard copy via subprocess.
 */
function platformCopy(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const platform = os.platform();
		let cmd: string;
		let args: string[];

		if (platform === "darwin") {
			cmd = "pbcopy";
			args = [];
		} else if (platform === "linux") {
			// Check for WSL
			const isWSL = os.release().toLowerCase().includes("microsoft");
			if (isWSL) {
				cmd = "clip.exe";
				args = [];
			} else {
				// Try xclip first (more common), fall back to xsel
				cmd = "xclip";
				args = ["-selection", "clipboard"];
			}
		} else if (platform === "win32") {
			cmd = "clip";
			args = [];
		} else {
			reject(new Error(`Unsupported platform: ${platform}`));
			return;
		}

		const proc = execFile(cmd, args, (err) => {
			if (err) reject(err);
			else resolve();
		});

		if (proc.stdin) {
			proc.stdin.write(text);
			proc.stdin.end();
		} else {
			reject(new Error("Failed to open stdin for clipboard process"));
		}
	});
}
