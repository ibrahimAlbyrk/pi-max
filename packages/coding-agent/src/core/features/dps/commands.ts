/**
 * Built-in /dps:log and /dps:reload slash command registration.
 *
 * Call registerDpsCommands(pi) once after the extension runner is set up.
 * Only registerCommand is used — no shortcuts are needed for DPS debug commands.
 *
 * Commands:
 *   /dps:log              — Summary: enabled status, template count, entries, runtime state
 *   /dps:log prompt       — Recompose current system prompt and dump to temp file
 *   /dps:log segments     — Dump all active resolved entries with content to temp file
 *   /dps:reload           — Hot-reload: invalidate PromptRegistry, clear entry cache
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../extensions/types.js";
import { getDpsDebugHandle } from "./index.js";
import type { Layer } from "./types.js";
import { LAYER_NAMES } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Layer display string: "L0 CORE" */
function layerLabel(layer: Layer): string {
	return `L${layer} ${LAYER_NAMES[layer]}`;
}

/** Pad a string to at least `width` characters. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Write content to a timestamped temp file and return the path. */
function writeTempFile(prefix: string, content: string): string {
	const ts = Date.now();
	const path = join(tmpdir(), `${prefix}-${ts}.md`);
	writeFileSync(path, content, "utf-8");
	return path;
}

// ─── Command Registration ─────────────────────────────────────────────────────

/**
 * Register /dps:log and /dps:reload slash commands via the extension API.
 *
 * Pattern mirrors registerBgCommands in features/bg/commands.ts.
 */
export function registerDpsCommands(pi: ExtensionAPI): void {
	// ── /dps:log ────────────────────────────────────────────────────────────

	pi.registerCommand("dps:log", {
		description: "DPS debug: /dps:log [prompt|segments]",

		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const subs: Array<{ value: string; description: string }> = [
				{ value: "prompt", description: "Dump current system prompt to temp file" },
				{ value: "segments", description: "Dump active resolved entries to temp file" },
			];
			return subs
				.filter((s) => s.value.startsWith(prefix.trim()))
				.map((s) => ({ label: s.value, value: s.value, description: s.description }));
		},

		async handler(args, ctx) {
			const sub = (args ?? "").trim();

			if (sub === "prompt") {
				await handleLogPrompt(ctx);
			} else if (sub === "segments") {
				await handleLogSegments(ctx);
			} else if (sub === "") {
				await handleLogSummary(ctx);
			} else {
				ctx.ui.notify(`Unknown sub-command: "${sub}". Use /dps:log [prompt|segments]`, "warning");
			}
		},
	});

	// ── /dps:reload ─────────────────────────────────────────────────────────

	pi.registerCommand("dps:reload", {
		description: "DPS hot-reload: invalidate PromptRegistry and clear entry cache",

		async handler(_args, ctx) {
			const handle = getDpsDebugHandle();
			if (!handle) {
				ctx.ui.notify("DPS is not active in this session", "warning");
				return;
			}

			handle.reload();
			ctx.ui.notify("DPS reloaded: entry cache cleared, PromptRegistry invalidated", "info");
		},
	});
}

// ─── Sub-command Handlers ────────────────────────────────────────────────────

/**
 * /dps:log (no args) — display a summary of DPS state.
 */
async function handleLogSummary(ctx: ExtensionCommandContext): Promise<void> {
	const handle = getDpsDebugHandle();
	if (!handle) {
		ctx.ui.notify("DPS is not active in this session", "warning");
		return;
	}

	const config = handle.getConfig();
	const state = handle.getRuntimeState();
	const allEntries = handle.getAllTemplateEntries();
	const lastResolved = handle.getLastResolvedEntries();
	const lastResult = handle.getLastComposeResult();
	const progSegments = handle.getAllProgrammaticSegments();

	// Active template IDs from last composition (programmatic IDs start with __)
	const activeTemplateIds = new Set(lastResult?.activeIds.filter((id) => !id.startsWith("__")) ?? []);
	const activeSegmentIds = new Set(lastResult?.activeIds.filter((id) => id.startsWith("__")) ?? []);

	const lines: string[] = [];

	// ── Header ────────────────────────────────────────────────────────────
	lines.push("=== DPS Status ===");
	lines.push("");

	// ── Config ────────────────────────────────────────────────────────────
	const enabledLabel = config.enabled ? "enabled" : "disabled";
	const budgetLabel = config.maxSegmentChars > 0 ? `${config.maxSegmentChars} chars` : "unlimited";
	const varCount = Object.keys(config.variables).length;
	lines.push(`Config: ${enabledLabel}, budget=${budgetLabel}, custom_vars=${varCount}`);
	lines.push("");

	// ── Templates ─────────────────────────────────────────────────────────
	const activeTemplateCount = activeTemplateIds.size;
	lines.push(`Templates (${allEntries.length} loaded, ${activeTemplateCount} active):`);

	if (allEntries.length === 0) {
		lines.push("  (none found — no templates with dps: frontmatter)");
	} else {
		// Sort by layer then priority for display
		const sorted = allEntries.slice().sort((a, b) => {
			if (a.layer !== b.layer) return a.layer - b.layer;
			return a.priority - b.priority;
		});

		for (const entry of sorted) {
			const icon = activeTemplateIds.has(entry.templateName) ? "✓" : "✗";
			const name = pad(entry.templateName, 36);
			const layer = pad(layerLabel(entry.layer), 14);
			const prio = `prio=${entry.priority}`;
			lines.push(`  ${icon} ${name} ${layer} ${prio}`);
		}
	}
	lines.push("");

	// ── Programmatic Segments ─────────────────────────────────────────────
	const activeSegCount = lastResolved.filter((e) => e.programmatic).length;
	lines.push(`Programmatic Segments (${progSegments.length} registered, ${activeSegCount} active):`);

	for (const seg of progSegments) {
		const icon = activeSegmentIds.has(seg.id) ? "✓" : "✗";
		const id = pad(seg.id, 20);
		const layer = pad(layerLabel(seg.layer), 14);
		const prio = `prio=${seg.priority}`;
		lines.push(`  ${icon} ${id} ${layer} ${prio}`);
	}
	lines.push("");

	// ── Runtime State ─────────────────────────────────────────────────────
	lines.push("Runtime State:");
	lines.push(`  Turn:         ${state.turnCount}`);
	lines.push(`  CWD:          ${state.cwd}`);
	lines.push(`  Model:        ${state.modelName || "(none)"}`);
	const caps = [...state.modelCapabilities];
	lines.push(`  Capabilities: ${caps.length > 0 ? caps.join(", ") : "(none)"}`);
	const tokenPct = state.tokenUsagePercent !== null ? `${state.tokenUsagePercent.toFixed(1)}%` : "unknown";
	lines.push(`  Token usage:  ${tokenPct}`);
	lines.push(`  Active tools: ${[...state.activeTools].join(", ") || "(none)"}`);
	lines.push("");

	// ── Tool Usage ────────────────────────────────────────────────────────
	lines.push("Tool Usage (calls this session):");
	if (state.toolUsageCount.size === 0) {
		lines.push("  (no tool calls recorded)");
	} else {
		const sorted = [...state.toolUsageCount.entries()].sort((a, b) => b[1] - a[1]);
		for (const [tool, count] of sorted) {
			lines.push(`  ${pad(tool, 24)} ${count}`);
		}
	}
	lines.push("");

	// ── Reminder State ────────────────────────────────────────────────────
	const l4Entries = allEntries.filter((e) => e.layer === 4);
	lines.push(`Reminder State (${l4Entries.length} L4 templates):`);
	if (l4Entries.length === 0) {
		lines.push("  (no L4 reminder templates found)");
	} else {
		for (const entry of l4Entries) {
			const count = state.reminderTriggerCount.get(entry.templateName) ?? 0;
			const lastAt = state.reminderLastTriggered.get(entry.templateName);
			const lastLabel = lastAt !== undefined ? `last at turn ${lastAt}` : "never triggered";
			const limitLabel = entry.maxTriggers !== undefined ? `/${entry.maxTriggers}` : "";
			const cooldownLabel = entry.cooldown !== undefined ? ` (cooldown=${entry.cooldown})` : "";
			lines.push(`  ${entry.templateName}: triggered ${count}${limitLabel}${cooldownLabel}, ${lastLabel}`);
		}
	}
	lines.push("");

	// ── Fingerprint ───────────────────────────────────────────────────────
	if (lastResult) {
		lines.push(`Last fingerprint: ${lastResult.fingerprint}`);
		lines.push(`Composed ${lastResult.activeIds.length} entries`);
	} else {
		lines.push("No composition run yet (first turn not reached)");
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * /dps:log prompt — recompose and dump the current system prompt to a temp file.
 */
async function handleLogPrompt(ctx: ExtensionCommandContext): Promise<void> {
	const handle = getDpsDebugHandle();
	if (!handle) {
		ctx.ui.notify("DPS is not active in this session", "warning");
		return;
	}

	const lastResult = handle.getLastComposeResult();
	if (!lastResult) {
		ctx.ui.notify("No system prompt composed yet (no agent turn has completed). Submit a prompt first.", "warning");
		return;
	}

	const content = [
		`# DPS System Prompt (composed at ${new Date().toISOString()})`,
		`# Fingerprint: ${lastResult.fingerprint}`,
		`# Active entries (${lastResult.activeIds.length}): ${lastResult.activeIds.join(", ")}`,
		"",
		lastResult.text,
	].join("\n");

	const path = writeTempFile("dps-prompt", content);
	ctx.ui.notify(`DPS system prompt written to:\n${path}`, "info");
}

/**
 * /dps:log segments — dump all active resolved entries with content to a temp file.
 */
async function handleLogSegments(ctx: ExtensionCommandContext): Promise<void> {
	const handle = getDpsDebugHandle();
	if (!handle) {
		ctx.ui.notify("DPS is not active in this session", "warning");
		return;
	}

	const resolved = handle.getLastResolvedEntries();
	if (resolved.length === 0) {
		ctx.ui.notify(
			"No resolved entries available yet (no agent turn has completed). Submit a prompt first.",
			"warning",
		);
		return;
	}

	const lines: string[] = [
		`# DPS Active Segments (${new Date().toISOString()})`,
		`# Total: ${resolved.length} entries`,
		"",
	];

	for (const entry of resolved) {
		const kind = entry.programmatic ? "programmatic" : "template";
		lines.push(`${"─".repeat(72)}`);
		lines.push(`# [${kind}] ${entry.id}  |  ${layerLabel(entry.layer)}  |  priority=${entry.priority}`);
		lines.push("");
		lines.push(entry.content);
		lines.push("");
	}

	const path = writeTempFile("dps-segments", lines.join("\n"));
	ctx.ui.notify(`DPS segments (${resolved.length}) written to:\n${path}`, "info");
}
