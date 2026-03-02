/**
 * DPS Debug Command: /dps:log
 *
 * Subcommands:
 *   /dps:log          — Segment listesi, state özeti
 *   /dps:log prompt   — Tam system prompt'u dosyaya yaz
 *   /dps:log segments — Sadece aktif segment içeriklerini dosyaya yaz
 *
 * Development tool — can be removed in production.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SegmentRegistry } from "../core/segment-registry.js";
import { discoverSegmentDirs } from "../core/segment-registry.js";
import type { StateManager } from "../core/state-manager.js";
import type { PromptComposer } from "../core/prompt-composer.js";
import type { DPSConfig } from "../core/types.js";
import { evaluateSegments } from "../core/condition-engine.js";
import { resolveDependencies } from "../core/dependency-resolver.js";
import { resolveSegments, buildVariableContext } from "../core/variable-resolver.js";
import { LAYER_NAMES } from "../core/types.js";

export function registerDpsLogCommand(
	pi: ExtensionAPI,
	registry: SegmentRegistry,
	stateManager: StateManager,
	composer: PromptComposer,
	config: DPSConfig,
	extensionDir: string,
) {
	pi.registerCommand("dps:log", {
		description: "DPS debug — /dps:log | /dps:log prompt | /dps:log segments",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim().toLowerCase();

			if (subcommand === "prompt") {
				return handlePromptDump(pi, registry, stateManager, composer, config, ctx);
			}

			if (subcommand === "segments") {
				return handleSegmentsDump(registry, stateManager, config, ctx);
			}

			// Default: summary
			return handleSummary(pi, registry, stateManager, config, ctx);
		},
	});

	pi.registerCommand("dps:reload", {
		description: "Reload all DPS segments without restarting the session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			return handleReload(registry, stateManager, composer, extensionDir, ctx);
		},
	});
}

// ============================================================================
// /dps:log prompt — Tam system prompt dosyaya yaz
// ============================================================================

async function handlePromptDump(
	pi: ExtensionAPI,
	registry: SegmentRegistry,
	stateManager: StateManager,
	composer: PromptComposer,
	config: DPSConfig,
	ctx: ExtensionCommandContext,
) {
	// Live compose: agent'taki mevcut prompt yerine, her zaman taze compose yap
	const basePrompt = ctx.getSystemPrompt();
	let systemPrompt = basePrompt;

	if (config.enabled) {
		stateManager.setCwd(ctx.cwd);
		stateManager.setActiveTools(pi.getActiveTools());
		stateManager.setAllTools(pi.getAllTools().map((t) => t.name));

		const usage = ctx.getContextUsage();
		stateManager.setTokenUsage(usage?.percent ?? null);

		if (ctx.model) {
			const capabilities: string[] = [];
			if (ctx.model.reasoning) capabilities.push("reasoning");
			if (ctx.model.input?.includes("image")) capabilities.push("image");
			stateManager.setModel(ctx.model.id || ctx.model.name || "", capabilities);
		}

		const state = stateManager.snapshot();
		const allSegments = registry.getAll();
		const conditionActive = evaluateSegments(allSegments, state);
		const activeSegments = resolveDependencies(conditionActive);
		const promptSegments = activeSegments.filter((s) => s.layer <= 3);

		if (promptSegments.length > 0) {
			const varContext = buildVariableContext(state, config.variables);
			const resolved = resolveSegments(promptSegments, varContext);
			const result = composer.compose(resolved, config.maxSegmentChars);

			if (result.text.trim()) {
				systemPrompt = basePrompt + "\n\n" + result.text;
			}
		}
	}

	const outPath = join(tmpdir(), `dps-system-prompt-${Date.now()}.md`);
	writeFileSync(outPath, systemPrompt, "utf-8");

	const charCount = systemPrompt.length;
	const lineCount = systemPrompt.split("\n").length;

	ctx.ui.notify(
		`System prompt dumped (${lineCount} lines, ${charCount} chars)\n→ ${outPath}`,
		"info",
	);
}

// ============================================================================
// /dps:log segments — Aktif segment içerikleri dosyaya yaz
// ============================================================================

async function handleSegmentsDump(
	registry: SegmentRegistry,
	stateManager: StateManager,
	config: DPSConfig,
	ctx: ExtensionCommandContext,
) {
	const state = stateManager.snapshot();
	const allSegments = registry.getAll();
	const conditionActive = evaluateSegments(allSegments, state);
	const active = resolveDependencies(conditionActive);

	// Sort by layer + priority
	active.sort((a, b) => {
		if (a.layer !== b.layer) return a.layer - b.layer;
		return a.priority - b.priority;
	});

	// Resolve variables
	const varContext = buildVariableContext(state, config.variables);
	const resolved = resolveSegments(active, varContext);

	const lines: string[] = [];
	lines.push("# DPS Active Segments");
	lines.push("");
	lines.push(`Total: ${resolved.length} active / ${allSegments.length} loaded`);
	lines.push(`Timestamp: ${new Date().toISOString()}`);
	lines.push("");

	for (const seg of resolved) {
		const layerName = LAYER_NAMES[seg.layer] || `L${seg.layer}`;
		lines.push("---");
		lines.push(`## [${layerName}:${seg.priority}] ${seg.id} (${seg.source})`);
		lines.push("");
		lines.push(seg.resolvedContent);
		lines.push("");
	}

	const outPath = join(tmpdir(), `dps-segments-${Date.now()}.md`);
	writeFileSync(outPath, lines.join("\n"), "utf-8");

	ctx.ui.notify(
		`${resolved.length} active segments dumped\n→ ${outPath}`,
		"info",
	);
}

// ============================================================================
// /dps:log — Özet (mevcut davranış)
// ============================================================================

async function handleSummary(
	pi: ExtensionAPI,
	registry: SegmentRegistry,
	stateManager: StateManager,
	config: DPSConfig,
	ctx: ExtensionCommandContext,
) {
	const state = stateManager.snapshot();
	const allSegments = registry.getAll();
	const activeSegments = evaluateSegments(allSegments, state);

	const lines: string[] = [];
	lines.push("═══ DPS Dynamic Prompt System ═══");
	lines.push("");

	// Config
	lines.push(`Enabled: ${config.enabled}`);
	lines.push(`Total segments loaded: ${allSegments.length}`);
	lines.push(`Active segments: ${activeSegments.length}`);
	lines.push("");

	// All segments with status
	lines.push("── Segments ──");
	const activeIds = new Set(activeSegments.map((s) => s.id));
	for (const seg of allSegments) {
		const status = activeIds.has(seg.id) ? "✅" : "❌";
		const layerName = LAYER_NAMES[seg.layer] || `L${seg.layer}`;
		lines.push(
			`  ${status} [${layerName}:${seg.priority}] ${seg.id} (${seg.source})`,
		);
	}
	lines.push("");

	// Runtime state
	lines.push("── Runtime State ──");
	lines.push(`  Turn count: ${state.turnCount}`);
	lines.push(`  CWD: ${state.cwd}`);
	lines.push(`  Model: ${state.modelName}`);
	lines.push(`  Capabilities: ${Array.from(state.modelCapabilities).join(", ") || "none"}`);
	lines.push(`  Token usage: ${state.tokenUsagePercent !== null ? Math.round(state.tokenUsagePercent) + "%" : "unknown"}`);
	lines.push(`  Active tools: ${Array.from(state.activeTools).join(", ")}`);
	lines.push("");

	// Tool usage
	if (state.toolUsageCount.size > 0) {
		lines.push("── Tool Usage ──");
		for (const [tool, count] of state.toolUsageCount) {
			const lastUsed = state.toolLastUsedAtTurn.get(tool);
			lines.push(
				`  ${tool}: ${count}x (last at turn ${lastUsed ?? "??"})`,
			);
		}
		lines.push("");
	}

	// Reminder state
	if (state.reminderTriggerCount.size > 0) {
		lines.push("── Reminder State ──");
		for (const [id, count] of state.reminderTriggerCount) {
			const lastTriggered = state.reminderLastTriggered.get(id);
			lines.push(
				`  ${id}: ${count}x (last at turn ${lastTriggered ?? "??"})`,
			);
		}
		lines.push("");
	}

	// Hint
	lines.push("── Commands ──");
	lines.push("  /dps:log prompt    → Dump full system prompt to file");
	lines.push("  /dps:log segments  → Dump active segment contents to file");
	lines.push("  /dps:reload        → Reload all segments from disk");

	ctx.ui.notify(lines.join("\n"), "info");
}

// ============================================================================
// /dps:reload — Hot-reload segments from disk
// ============================================================================

async function handleReload(
	registry: SegmentRegistry,
	stateManager: StateManager,
	composer: PromptComposer,
	extensionDir: string,
	ctx: ExtensionCommandContext,
) {
	const prevCount = registry.size;

	// Reset composer cache (segments are changing)
	composer.reset();

	// Re-discover and reload all segment directories
	const cwd = stateManager.snapshot().cwd;
	const dirs = discoverSegmentDirs(extensionDir, cwd);
	registry.loadAll(dirs);

	const newCount = registry.size;
	const diff = newCount - prevCount;
	const diffStr = diff > 0 ? ` (+${diff} new)` : diff < 0 ? ` (${diff} removed)` : " (no change)";

	ctx.ui.notify(
		`DPS segments reloaded: ${newCount} segments${diffStr}\nSources: ${dirs.map((d) => d.source).join(", ")}`,
		"info",
	);
}
