/**
 * Dynamic Prompt System (DPS) — Prompt Builder
 *
 * Core orchestration module. Implements:
 * - DEFAULT_PROGRAMMATIC_SEGMENTS: the 2 remaining built-in programmatic segments
 *   (__custom-prompt, __append-prompt). The other 4 (__cwd-datetime, __tools,
 *   __skills, __context-files) have been migrated to template variables in
 *   buildRenderVariables(). __task-context is provided via registerVariableProvider().
 * - buildRenderVariables(): template variable context for all DPS renders,
 *   including TOOLS_LIST, SKILLS_SECTION, CONTEXT_FILES_SECTION, TASK_CONTEXT
 * - composeDpsPrompt(): the full 11-step composition pipeline (L0-L3 system prompt)
 * - getL4Reminders(): L4 reminder evaluation and rendering for the context hook
 * - registerProgrammaticSegment(): external segment registration API
 * - registerVariableProvider(): variable provider registration API
 */

import type { PromptRegistry } from "@mariozechner/pi-prompt";
import { getDocsPath, getExamplesPath, getReadmePath } from "../../../config.js";
import { getPromptRegistry } from "../../prompt-registry.js";
import { formatSkillsForPrompt } from "../../skills.js";
import { clearFileCheckCache, evaluateEntries } from "./condition-engine.js";
import { resolveDependencies } from "./dependency-resolver.js";
import type { PromptComposer } from "./prompt-composer.js";
import type { StateManager } from "./state-manager.js";
import { scanDpsTemplates } from "./template-scanner.js";
import type {
	ComposeResult,
	DPSConfig,
	DpsEntry,
	ProgrammaticSegment,
	PromptBuildContext,
	ResolvedEntry,
	RuntimeState,
	VariableProvider,
} from "./types.js";

// ─── Tool Short Description ──────────────────────────────────────────────────

/**
 * Get the short description for a tool.
 * Renders the `tools/{name}-short` template from the registry.
 * Falls back to the first line of the tool's own description if no template exists.
 * Mirrors the existing getToolShortDescription() in system-prompt.ts.
 */
function getToolShortDescription(tool: { name: string; description: string }, registry: PromptRegistry): string {
	try {
		return registry.render(`tools/${tool.name}-short`).trim();
	} catch {
		// No short-description template — use first line of tool description
		const firstLine = tool.description.split("\n")[0].trim();
		return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
	}
}

// ─── Built-in Programmatic Segments ─────────────────────────────────────────

/**
 * The 2 remaining built-in programmatic segments.
 * __cwd-datetime, __tools, __skills, __context-files have been migrated to
 * template variables (TOOLS_LIST, SKILLS_SECTION, CONTEXT_FILES_SECTION) in
 * buildRenderVariables(). __task-context is provided by the task feature via
 * registerVariableProvider() (TASK_CONTEXT variable).
 *
 * These are exported as a constant; index.ts copies them into a mutable array
 * and appends any externally registered segments.
 */
export const DEFAULT_PROGRAMMATIC_SEGMENTS: ProgrammaticSegment[] = [
	// ── __custom-prompt — L0, priority 0 ──────────────────────────────────
	// When the user has a custom system prompt, this carries it at the highest
	// L0 priority. Its presence causes other file-based L0 templates to be
	// excluded (see composeDpsPrompt step 6).
	{
		id: "__custom-prompt",
		layer: 0,
		priority: 0,
		generate(context: PromptBuildContext): string | null {
			return context.customPrompt ?? null;
		},
	},

	// ── __append-prompt — L3, priority 99 ──────────────────────────────
	// User's appendSystemPrompt content. Always last in L3 (highest priority
	// number = lowest importance for token budget, but still appended).
	// Mirrors APPEND_SECTION in the monolithic template.
	{
		id: "__append-prompt",
		layer: 3,
		priority: 99,
		generate(context: PromptBuildContext): string | null {
			return context.appendSystemPrompt ?? null;
		},
	},
];

// ─── External Segment Registration ──────────────────────────────────────────

/**
 * Mutable list of segments added by external features (e.g., task, bg).
 * Combined with DEFAULT_PROGRAMMATIC_SEGMENTS during composition.
 */
const _extraSegments: ProgrammaticSegment[] = [];

/**
 * Register an additional programmatic segment.
 * Called by other built-in features (e.g., task registers __task-context).
 * The segment participates in the same pipeline as the built-in segments.
 */
export function registerProgrammaticSegment(segment: ProgrammaticSegment): void {
	_extraSegments.push(segment);
}

/**
 * Return all registered programmatic segments (built-in + externally registered).
 * Used by debug commands to list active segments.
 */
export function getAllProgrammaticSegments(): ProgrammaticSegment[] {
	return [...DEFAULT_PROGRAMMATIC_SEGMENTS, ..._extraSegments];
}

// ─── Variable Provider Registration ─────────────────────────────────────────

/**
 * Mutable list of variable providers registered by external features (e.g., task).
 * Providers are called in buildRenderVariables() and their results are merged
 * into the variables object. Later providers override earlier ones for the same key.
 */
const _variableProviders: VariableProvider[] = [];

/**
 * Register a variable provider.
 * Called by other built-in features (e.g., task registers a TASK_CONTEXT provider).
 * The provider's provide() function is called on every buildRenderVariables() invocation.
 */
export function registerVariableProvider(provider: VariableProvider): void {
	_variableProviders.push(provider);
}

/**
 * Return all registered variable providers.
 * Used by debug commands to list active providers.
 */
export function getAllVariableProviders(): VariableProvider[] {
	return [..._variableProviders];
}

// ─── Variable Resolution ─────────────────────────────────────────────────────

/**
 * Build the template variable context for all DPS template renders.
 * Includes:
 * - Runtime state variables (CWD, DATE_TIME, MODEL_NAME, etc.)
 * - Content variables derived from buildContext (TOOLS_LIST, SKILLS_SECTION,
 *   CONTEXT_FILES_SECTION, TASK_CONTEXT) — these were formerly generated by
 *   dedicated programmatic segments; they are now template variables so that
 *   file-based templates can reference them via {{VAR}} syntax.
 * - Backward-compat path variables (README_PATH, DOCS_PATH, EXAMPLES_PATH)
 * - User-defined variables from DPSConfig (may override any of the above)
 * - Values from all registered variable providers (merged last; later providers
 *   override earlier ones for the same key, but cannot override config.variables)
 */
export function buildRenderVariables(
	state: Readonly<RuntimeState>,
	config: DPSConfig,
	buildContext: PromptBuildContext,
	_stateManager: StateManager,
): Record<string, unknown> {
	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	// ── TOOLS_LIST ────────────────────────────────────────────────────────
	// Formatted active tool list with short descriptions. Renders
	// tools/{name}-short templates via the registry; falls back to the first
	// line of the tool's own description when no template exists.
	let toolsList = "";
	if (buildContext.activeTools.length > 0) {
		const registry = getPromptRegistry(buildContext.cwd);
		const lines = buildContext.activeTools.map((t) => `- ${t.name}: ${getToolShortDescription(t, registry)}`);
		toolsList = lines.join("\n");
	}

	// ── SKILLS_SECTION ────────────────────────────────────────────────────
	// Available skills listing. Only populated when the `read` tool is active
	// (skills require read access to load skill files).
	let skillsSection = "";
	const hasRead = buildContext.activeTools.some((t) => t.name === "read");
	if (hasRead && buildContext.skills.length > 0) {
		skillsSection = formatSkillsForPrompt(buildContext.skills).trim();
	}

	// ── CONTEXT_FILES_SECTION ─────────────────────────────────────────────
	// .pi/ context files (AGENTS.md, etc.) formatted as a single block.
	let contextFilesSection = "";
	if (buildContext.contextFiles.length > 0) {
		const lines = ["# Project Context", "", "Project-specific instructions and guidelines:"];
		for (const { path: filePath, content } of buildContext.contextFiles) {
			lines.push("", `## ${filePath}`, "", content);
		}
		contextFilesSection = lines.join("\n");
	}

	// ── Base variables ────────────────────────────────────────────────────

	const vars: Record<string, unknown> = {
		// Runtime variables
		CWD: state.cwd,
		DATE_TIME: dateTime,
		MODEL_NAME: state.modelName,
		ACTIVE_TOOLS: [...state.activeTools].join(", "),
		TOKEN_USAGE: state.tokenUsagePercent?.toString() ?? "unknown",
		TURN_COUNT: state.turnCount.toString(),

		// Content variables (migrated from programmatic segments)
		TOOLS_LIST: toolsList,
		SKILLS_SECTION: skillsSection,
		CONTEXT_FILES_SECTION: contextFilesSection,
		// Backward-compat path variables
		README_PATH: getReadmePath(),
		DOCS_PATH: getDocsPath(),
		EXAMPLES_PATH: getExamplesPath(),
	};

	// ── Variable providers ────────────────────────────────────────────────
	// Merge provider-supplied variables before config overrides so that
	// user-defined config.variables always take highest precedence.
	for (const provider of _variableProviders) {
		try {
			const provided = provider.provide(buildContext);
			Object.assign(vars, provided);
		} catch (err) {
			console.warn(`DPS: Variable provider failed: ${err}`);
		}
	}

	// ── User-defined config variables (highest precedence) ────────────────
	Object.assign(vars, config.variables);

	return vars;
}

// ─── Composition Pipeline Options ───────────────────────────────────────────

/** Options for the full DPS composition pipeline (L0-L3 system prompt). */
export interface ComposeDpsPromptOptions {
	/**
	 * Pre-scanned DPS entries from the registry.
	 * If omitted, the registry is scanned on each call (no caching).
	 * index.ts passes pre-scanned entries to leverage its session-level cache.
	 */
	entries?: DpsEntry[];
	/** Current runtime state snapshot */
	state: Readonly<RuntimeState>;
	/** DPS feature configuration */
	config: DPSConfig;
	/** Runtime data for programmatic segment generators */
	buildContext: PromptBuildContext;
	/** Prompt registry for template rendering */
	registry: PromptRegistry;
	/** PromptComposer instance (session-scoped, holds fingerprint cache) */
	composer: PromptComposer;
	/** StateManager instance (for getGitBranch() during variable resolution) */
	stateManager: StateManager;
}

/** Options for L4 reminder evaluation and rendering (context hook). */
export interface GetL4RemindersOptions {
	/**
	 * Pre-scanned DPS entries from the registry.
	 * If omitted, the registry is scanned on each call.
	 */
	entries?: DpsEntry[];
	/** Current runtime state snapshot */
	state: Readonly<RuntimeState>;
	/** DPS feature configuration */
	config: DPSConfig;
	/** Runtime data (used for variable building) */
	buildContext: PromptBuildContext;
	/** Prompt registry for template rendering */
	registry: PromptRegistry;
	/** StateManager instance (for cooldown/maxTriggers checks and recording) */
	stateManager: StateManager;
}

/** A rendered L4 reminder message ready for injection into the conversation. */
export interface ReminderMessage {
	role: string;
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

// ─── Composition Pipeline ────────────────────────────────────────────────────

/**
 * Full DPS composition pipeline — spec Section 7.3, steps 1-11.
 *
 * Produces the L0-L3 system prompt from:
 * - File-based DPS templates (conditions evaluated, dependencies resolved)
 * - Programmatic segments (runtime-generated content)
 *
 * Steps:
 *  1. Clear file check cache (condition-engine)
 *  2. Get DPS-enabled templates (pre-scanned entries passed in)
 *  3. Evaluate conditions against RuntimeState
 *  4. Resolve dependencies (depends_on / conflicts_with)
 *  5. Filter L0-L3 for system prompt
 *  6. Check custom prompt — if set, exclude file-based L0 templates
 *  7. Render each template via registry.render(name, vars)
 *  8. Generate programmatic segments
 *  9. Merge file-based + programmatic entries into ResolvedEntry[]
 * 10. Compose via PromptComposer (sort, token budget, fingerprint)
 * 11. Return ComposeResult { text, fingerprint, activeIds }
 */
export function composeDpsPrompt(options: ComposeDpsPromptOptions): ComposeResult {
	const { state, config, buildContext, registry, composer, stateManager } = options;

	// Step 1: Clear file check cache (turn-scoped, invalidated per composition)
	clearFileCheckCache();

	// Step 2: Get DPS-enabled templates — use caller-provided cache or scan the registry
	const entries = options.entries ?? scanDpsTemplates(registry);

	// Step 3: Evaluate conditions against current RuntimeState
	const conditionActive = evaluateEntries(entries, state);

	// Step 4: Resolve depends_on and conflicts_with constraints
	const active = resolveDependencies(conditionActive);

	// Step 5: Filter to L0-L3 only (L4 reminders go through getL4Reminders)
	const promptEntries = active.filter((e) => e.layer <= 3);

	// Step 6: Build render variables (shared across all template renders)
	const vars = buildRenderVariables(state, config, buildContext, stateManager);

	// Step 7 & 8: Render templates and generate programmatic segments
	// Check if custom prompt is active — when set, exclude file-based L0 templates
	const hasCustomPrompt = Boolean(buildContext.customPrompt);

	const resolved: ResolvedEntry[] = [];

	// Step 7: Render file-based templates
	for (const entry of promptEntries) {
		// Custom prompt override: skip file-based L0 templates (core-tone, core-guidelines, etc.)
		// The __custom-prompt programmatic segment carries the custom content at L0 priority 0
		if (hasCustomPrompt && entry.layer === 0) continue;

		try {
			const content = registry.render(entry.templateName, vars);
			if (!content.trim()) continue; // Skip empty renders
			resolved.push({
				id: entry.templateName,
				layer: entry.layer,
				priority: entry.priority,
				content,
				programmatic: false,
				dynamic: entry.dynamic,
			});
		} catch (err) {
			console.warn(`DPS: Failed to render "${entry.templateName}": ${err}`);
		}
	}

	// Step 8: Generate programmatic segments
	const allSegments = [...DEFAULT_PROGRAMMATIC_SEGMENTS, ..._extraSegments];
	for (const seg of allSegments) {
		const content = seg.generate(buildContext);
		if (content?.trim()) {
			resolved.push({
				id: seg.id,
				layer: seg.layer,
				priority: seg.priority,
				content,
				programmatic: true,
				dynamic: false,
			});
		}
	}

	// Step 9: Merge is already done above (resolved array holds both)

	// Step 10: Compose (sort by layer+priority, token budget, fingerprint cache)
	const result = composer.compose(resolved, config.maxSegmentChars);

	// Step 11: Return ComposeResult
	return result;
}

// ─── L4 Reminder Pipeline ────────────────────────────────────────────────────

/**
 * Evaluate L4 reminder entries and return rendered messages for eligible ones.
 * Used in the `context` hook to inject reminder messages into the conversation.
 *
 * Eligibility criteria:
 * - Conditions pass against current RuntimeState
 * - Dependencies resolved (depends_on / conflicts_with)
 * - Cooldown period elapsed (or not set)
 * - Max triggers not reached (or not set)
 *
 * Side effect: records each triggered reminder via stateManager.
 */
export function getL4Reminders(options: GetL4RemindersOptions): ReminderMessage[] {
	const { state, config, buildContext, registry, stateManager } = options;

	// Get entries — use caller-provided cache or scan the registry
	const allEntries = options.entries ?? scanDpsTemplates(registry);

	// Filter to L4 only
	const l4Entries = allEntries.filter((e) => e.layer === 4);
	if (l4Entries.length === 0) return [];

	// Evaluate conditions
	const conditionActive = evaluateEntries(l4Entries, state);

	// Resolve dependencies
	const active = resolveDependencies(conditionActive);

	// Apply cooldown and maxTriggers filters
	const eligible = active.filter((e) => {
		if (e.cooldown !== undefined && !stateManager.isReminderCooledDown(e.templateName, e.cooldown)) {
			return false;
		}
		if (e.maxTriggers !== undefined && stateManager.isReminderMaxed(e.templateName, e.maxTriggers)) {
			return false;
		}
		return true;
	});

	if (eligible.length === 0) return [];

	// Build render variables
	const vars = buildRenderVariables(state, config, buildContext, stateManager);

	// Render each eligible reminder and record the trigger
	const messages: ReminderMessage[] = [];

	for (const entry of eligible) {
		try {
			const content = registry.render(entry.templateName, vars);
			if (!content.trim()) continue;

			stateManager.recordReminderTriggered(entry.templateName);

			messages.push({
				role: "custom",
				customType: "dps-reminder",
				content,
				display: false,
				timestamp: Date.now(),
			});
		} catch (err) {
			console.warn(`DPS: Failed to render L4 reminder "${entry.templateName}": ${err}`);
		}
	}

	return messages;
}
