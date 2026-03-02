/**
 * Notification Extension for Pi CLI
 *
 * Plays sound and sends OS notifications when:
 * - Agent finishes work and is waiting for input
 * - Agent encounters an error
 *
 * Commands: /notify on|off|status
 *
 * Platform support:
 * - macOS: afplay + osascript
 * - Linux: paplay/aplay + notify-send
 * - Fallback: terminal bell (\x07)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import { platform } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

type NotificationType = "complete" | "error";

interface NotificationConfig {
	enabled: boolean;
	sound: boolean;
	osNotification: boolean;
}

interface AgentRunStats {
	toolCalls: Map<string, number>;
	startTime: number;
}

// ─── Sound Configuration ─────────────────────────────────────────────────────

const MACOS_SOUNDS: Record<NotificationType, string> = {
	complete: "/System/Library/Sounds/Funk.aiff",
	error: "/System/Library/Sounds/Basso.aiff",
};

// ─── Platform Detection ──────────────────────────────────────────────────────

const PLATFORM = platform();

async function commandExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		exec(`which ${cmd}`, (error) => resolve(!error));
	});
}

// ─── Sound Playback ──────────────────────────────────────────────────────────

function playSound(type: NotificationType): void {
	if (PLATFORM === "darwin") {
		const soundFile = MACOS_SOUNDS[type];
		exec(`afplay "${soundFile}"`, () => {});
	} else if (PLATFORM === "linux") {
		// Try paplay first, then aplay, then bell
		exec(`which paplay`, (err) => {
			if (!err) {
				exec(`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`, () => {});
			} else {
				exec(`which aplay`, (err2) => {
					if (!err2) {
						exec(`aplay /usr/share/sounds/freedesktop/stereo/complete.oga`, () => {});
					} else {
						process.stdout.write("\x07"); // Terminal bell
					}
				});
			}
		});
	} else {
		// Windows/other — terminal bell
		process.stdout.write("\x07");
	}
}

// ─── OS Notification ─────────────────────────────────────────────────────────

function sendOSNotification(title: string, message: string): void {
	if (PLATFORM === "darwin") {
		const escapedTitle = title.replace(/"/g, '\\"');
		const escapedMessage = message.replace(/"/g, '\\"');
		exec(
			`osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`,
			() => {}
		);
	} else if (PLATFORM === "linux") {
		const escapedTitle = title.replace(/'/g, "'\\''");
		const escapedMessage = message.replace(/'/g, "'\\''");
		exec(`notify-send '${escapedTitle}' '${escapedMessage}'`, () => {});
	}
	// Windows: could use PowerShell toast, skipping for now
}

// ─── Summary Builder ─────────────────────────────────────────────────────────

function buildSummary(stats: AgentRunStats): string {
	const parts: string[] = [];
	const toolNames: Record<string, string> = {
		edit: "edit",
		write: "file write",
		read: "file read",
		bash: "command",
		grep: "search",
		find: "file find",
		ls: "listing",
		task: "task management",
	};

	for (const [tool, count] of stats.toolCalls) {
		const label = toolNames[tool] || tool;
		parts.push(`${count} ${label}`);
	}

	const elapsed = Math.round((Date.now() - stats.startTime) / 1000);

	if (parts.length === 0) {
		return `Responded (${elapsed}s)`;
	}

	return `${parts.join(", ")} (${elapsed}s)`;
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// State
	let config: NotificationConfig = {
		enabled: true,
		sound: true,
		osNotification: false,
	};

	let currentRun: AgentRunStats | null = null;

	// ─── Notify Helper ─────────────────────────────────────────────────────

	function notify(type: NotificationType, title: string, message: string, ctx?: ExtensionContext) {
		if (!config.enabled) return;

		if (config.sound) {
			playSound(type);
		}

		if (config.osNotification) {
			sendOSNotification(title, message);
		}
	}

	// ─── Restore settings from session ─────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Restore config from persisted entries
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === "notification-config"
			) {
				config = { ...config, ...(entry.data as Partial<NotificationConfig>) };
			}
		}
	});

	// ─── Track agent run ───────────────────────────────────────────────────

	pi.on("agent_start", async (_event, _ctx) => {
		currentRun = {
			toolCalls: new Map(),
			startTime: Date.now(),
		};
	});

	// ─── Track tool calls for summary ──────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		if (currentRun) {
			const count = currentRun.toolCalls.get(event.toolName) || 0;
			currentRun.toolCalls.set(event.toolName, count + 1);
		}
	});

	// ─── Agent finished → Notify ───────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		const summary = currentRun ? buildSummary(currentRun) : "Completed";
		const hasError = (event as any).error;

		if (hasError) {
			notify("error", "⚠️ Pi Agent — Error", `Error occurred: ${summary}`, ctx);
		} else {
			notify("complete", "✅ Pi Agent", `${summary}`, ctx);
		}

		currentRun = null;
	});

	// ─── /notify Command ───────────────────────────────────────────────────

	pi.registerCommand("notify", {
		description: "Notification settings — /notify [on|off|status|sound on|off|os on|off]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().toLowerCase().split(/\s+/);
			const subCommand = parts[0] || "status";

			switch (subCommand) {
				case "on":
					config.enabled = true;
					pi.appendEntry("notification-config", config);
					ctx.ui.notify("🔔 Notifications enabled", "info");
					break;

				case "off":
					config.enabled = false;
					pi.appendEntry("notification-config", config);
					ctx.ui.notify("🔕 Notifications disabled", "info");
					break;

				case "sound":
					if (parts[1] === "on") {
						config.sound = true;
						ctx.ui.notify("🔊 Sound notifications enabled", "info");
					} else if (parts[1] === "off") {
						config.sound = false;
						ctx.ui.notify("🔇 Sound notifications disabled", "info");
					} else {
						ctx.ui.notify(`🔊 Sound: ${config.sound ? "on" : "off"}`, "info");
					}
					pi.appendEntry("notification-config", config);
					break;

				case "os":
					if (parts[1] === "on") {
						config.osNotification = true;
						ctx.ui.notify("🖥️  OS notifications enabled", "info");
					} else if (parts[1] === "off") {
						config.osNotification = false;
						ctx.ui.notify("🖥️  OS notifications disabled", "info");
					} else {
						ctx.ui.notify(`🖥️  OS notification: ${config.osNotification ? "on" : "off"}`, "info");
					}
					pi.appendEntry("notification-config", config);
					break;

				case "test":
					notify("complete", "🔔 Test Notification", "Notification system is working!", ctx);
					ctx.ui.notify("Test notification sent", "info");
					break;

				case "status":
				default:
					const status = [
						`🔔 Notifications: ${config.enabled ? "✅ On" : "❌ Off"}`,
						`🔊 Sound: ${config.sound ? "✅ On" : "❌ Off"}`,
						`🖥️  OS Notification: ${config.osNotification ? "✅ On" : "❌ Off"}`,
						``,
						`Usage:`,
						`  /notify on|off      — Enable/disable notifications`,
						`  /notify sound on|off — Enable/disable sound`,
						`  /notify os on|off    — Enable/disable OS notifications`,
						`  /notify test        — Send a test notification`,
					].join("\n");
					ctx.ui.notify(status, "info");
					break;
			}
		},
	});
}
