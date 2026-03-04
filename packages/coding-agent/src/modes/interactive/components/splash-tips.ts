/**
 * Tip of the day messages for the splash screen.
 * Tips are keybinding-aware and use the KeybindingsManager to show correct shortcuts.
 */

import type { KeybindingsManager } from "../../../core/keybindings.js";
import { appKey } from "./keybinding-hints.js";

type TipFn = (kb: KeybindingsManager) => string;

const TIPS: TipFn[] = [
	// Keybinding tips
	(kb) => `${appKey(kb, "expandTools")} to collapse/expand tool output`,
	(kb) => `${appKey(kb, "toggleThinking")} to collapse/expand thinking blocks`,
	(kb) => `${appKey(kb, "externalEditor")} to open your $EDITOR for multi-line prompts`,
	(kb) => `${appKey(kb, "cycleModelForward")} to cycle between scoped models`,
	(kb) => `${appKey(kb, "pasteImage")} to paste an image from clipboard`,
	(kb) => `${appKey(kb, "followUp")} to queue a follow-up (waits for current work)`,
	(kb) => `${appKey(kb, "cycleThinkingLevel")} to cycle thinking levels`,

	// Slash command tips
	() => "/compact to manually compress the conversation context",
	() => "/tree to navigate and switch between session branches",
	() => "/fork to create a new session branch from current point",
	() => "/export to save the session as an HTML file",
	() => "/share to share the session as a secret GitHub gist",
	() => "/session to view current session stats and token usage",
	() => "/hotkeys to see all keyboard shortcuts",
	() => "/resume to continue a previous session",
	() => "/settings to configure model, thinking, and more",
	() => "/reload to hot-reload extensions, skills, and themes",
	() => "/scoped-models to pick which models appear in the cycle",

	// Feature tips
	() => "Type @ to fuzzy-search and reference project files",
	() => "Drag files onto the terminal to attach them",
	() => "Use shift+enter for multi-line input",
	() => "Prefix with ! to run a shell command and send output to the LLM",
	() => "Prefix with !! to run a shell command without sending to the LLM",
	() => "Add AGENTS.md to your project root for persistent context",
	() => "Create .pi/skills/ for on-demand capability packages",
	() => "Create .pi/extensions/ for custom tools and commands",
	() => "Use tab to autocomplete file paths in the input",
	() => "Sessions auto-save to ~/.pi/agent/sessions/",
	() => "Enter interrupts remaining tools; alt+enter waits for completion",
	() => "Context overflow is handled automatically with compaction",
	() => "Use /changelog to see what's new in the latest version",
	() => "Keybindings are configurable via ~/.pi/agent/keybindings.json",
	() => "Themes are customizable via ~/.pi/agent/theme.json",
];

/**
 * Get a random tip string, formatted with current keybindings.
 */
export function getRandomTip(keybindings: KeybindingsManager): string {
	const index = Math.floor(Math.random() * TIPS.length);
	return TIPS[index]!(keybindings);
}
