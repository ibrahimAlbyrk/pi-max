/**
 * Dynamic Prompt System (DPS) — Type Definitions
 *
 * All interfaces, types, and constants for the built-in DPS feature.
 * DPS is an orchestration layer over the existing prompt template system:
 * it composes the system prompt from multiple .prompt.md templates that
 * declare activation conditions, layer placement, and priority via a
 * `dps:` block in their YAML frontmatter.
 */

import type { SystemPromptBlock } from "@mariozechner/pi-ai";
import type { Skill } from "../../skills.js";

// ─── Layer ───────────────────────────────────────────────────────

/**
 * Composition layer. Determines where in the final system prompt
 * a template or programmatic segment is placed.
 *
 * L0 (Core)        — Foundational tone, behavior, tool guidelines. Always first.
 * L1 (Environment) — Context-dependent knowledge (git, .pi/, project type).
 * L2 (Tool)        — Tool-specific guidance, active when tool is available.
 * L3 (Custom)      — User/project-specific overrides and appends.
 * L4 (Reminder)    — Turn-based nudges with cooldown, injected as messages not system prompt.
 */
export type Layer = 0 | 1 | 2 | 3 | 4;

export const LAYER_NAMES: Record<Layer, string> = {
	0: "CORE",
	1: "ENVIRONMENT",
	2: "TOOL",
	3: "CUSTOM",
	4: "REMINDER",
};

// ─── Conditions (Discriminated Union) ────────────────────────────

/**
 * Activation conditions evaluated against RuntimeState.
 * Multiple top-level conditions are AND-ed together.
 *
 * Logical operators (all, any, not) allow composing conditions.
 * Unknown condition types evaluate to false (segment skipped).
 */
export type Condition =
	| { type: "tool_active"; tool: string }
	| { type: "tool_inactive"; tool: string }
	| { type: "file_exists"; path: string }
	| { type: "dir_exists"; path: string }
	| { type: "turns_since_tool_use"; tool: string; min: number }
	| { type: "token_usage_above"; percent: number }
	| { type: "token_usage_below"; percent: number }
	| { type: "turn_count_above"; count: number }
	| { type: "turn_count_below"; count: number }
	| { type: "model_supports"; capability: string }
	| { type: "all"; conditions: Condition[] }
	| { type: "any"; conditions: Condition[] }
	| { type: "not"; condition: Condition };

/**
 * A compiled condition evaluator. Produced once from a Condition[]
 * and called on every prompt composition against the current RuntimeState.
 * Follows the compile-once, evaluate-many pattern.
 */
export type ConditionEvaluator = (state: RuntimeState) => boolean;

// ─── DPS Template Entry ──────────────────────────────────────────

/**
 * A DPS-enabled template discovered from the PromptRegistry.
 * Produced by template-scanner.ts from templates with a `dps:` frontmatter block.
 */
export interface DpsEntry {
	/** Template name in the registry (e.g., "dps/core-tone") */
	templateName: string;
	/** Composition layer */
	layer: Layer;
	/** Sort priority within layer (lower = first) */
	priority: number;
	/**
	 * Whether this entry contains per-turn dynamic content (e.g., DATE_TIME, TASK_CONTEXT).
	 * Dynamic entries are placed in a separate cache block so that stable entries
	 * before them remain cached across turns.
	 */
	dynamic: boolean;
	/** Parsed conditions from dps.conditions */
	conditions: Condition[];
	/** Compiled condition evaluator */
	evaluator: ConditionEvaluator;
	/** Template names that must be active for this entry to activate */
	dependsOn: string[];
	/** Template names that must NOT be active for this entry to activate */
	conflictsWith: string[];
	/** L4 only: minimum turns between reminder triggers */
	cooldown?: number;
	/** L4 only: per-session trigger limit */
	maxTriggers?: number;
}

// ─── Variable Provider ───────────────────────────────────────────

/**
 * Provides additional template variables for DPS prompt rendering.
 * Variable providers are called in buildRenderVariables() and their
 * results are merged into the variables object passed to all template
 * renders. Later providers override earlier ones for the same key.
 *
 * Use this to inject dynamic, context-derived values (e.g., TASK_CONTEXT)
 * into template renders without adding a programmatic segment.
 */
export interface VariableProvider {
	provide(context: PromptBuildContext): Record<string, unknown>;
}

// ─── Programmatic Segment ────────────────────────────────────────

/**
 * Runtime-generated content that participates in the DPS composition
 * pipeline alongside file-based templates. Used for content that
 * requires dynamic data (tool lists, skills, context files, etc.)
 * that cannot be expressed as a static template.
 */
export interface ProgrammaticSegment {
	/** Unique identifier (e.g., "__tools") */
	id: string;
	/** Composition layer */
	layer: Layer;
	/** Sort priority within layer (lower = first) */
	priority: number;
	/** Generate content. Return null to skip this segment. */
	generate(context: PromptBuildContext): string | null;
}

// ─── Prompt Build Context ────────────────────────────────────────

/**
 * Context passed to programmatic segment generators.
 * Provides the runtime data needed to produce dynamic content.
 */
export interface PromptBuildContext {
	/** Active tools with their descriptions */
	activeTools: { name: string; description: string }[];
	/** Available skills */
	skills: Skill[];
	/** .pi/ context files (e.g., AGENTS.md) */
	contextFiles: { path: string; content: string }[];
	/** Current working directory */
	cwd: string;
	/** User-defined custom system prompt, if set */
	customPrompt: string | undefined;
	/** Content to append to the system prompt, if set */
	appendSystemPrompt: string | undefined;
}

// ─── Resolved Entry ──────────────────────────────────────────────

/**
 * A template or programmatic segment after condition evaluation
 * and content rendering. Input to the PromptComposer.
 */
export interface ResolvedEntry {
	/** Template name or programmatic segment ID */
	id: string;
	/** Composition layer */
	layer: Layer;
	/** Sort priority within layer (lower = first) */
	priority: number;
	/** Rendered content (variables resolved) */
	content: string;
	/** Whether this entry came from a programmatic segment (vs. a template) */
	programmatic: boolean;
	/** Whether this entry contains per-turn dynamic content */
	dynamic: boolean;
}

// ─── Runtime State ───────────────────────────────────────────────

/**
 * Runtime state tracked by StateManager and used to evaluate conditions.
 * Snapshot taken at the start of each prompt composition cycle.
 */
export interface RuntimeState {
	/** Current conversation turn counter */
	turnCount: number;
	/** Tool names currently available to the agent */
	activeTools: Set<string>;
	/** All known tool names (including inactive) */
	allTools: Set<string>;
	/** Turn number when each tool was last called */
	toolLastUsedAtTurn: Map<string, number>;
	/** Total invocation count per tool this session */
	toolUsageCount: Map<string, number>;
	/** Current working directory */
	cwd: string;
	/** Active model identifier */
	modelName: string;
	/** Model capability tags (e.g., "reasoning", "image") */
	modelCapabilities: Set<string>;
	/** Context window usage as a percentage (0–100), or null if unknown */
	tokenUsagePercent: number | null;
	/** Turn number when each L4 reminder was last triggered */
	reminderLastTriggered: Map<string, number>;
	/** Total trigger count per L4 reminder this session */
	reminderTriggerCount: Map<string, number>;
}

// ─── DPS Configuration ───────────────────────────────────────────

/**
 * DPS feature configuration, read from the `dps:` section of pi.yml.
 *
 * Example pi.yml:
 * ```yaml
 * dps:
 *   enabled: true
 *   maxSegmentChars: 0
 *   variables:
 *     PROJECT_TYPE: "monorepo"
 *     TEAM: "backend"
 * ```
 */
export interface DPSConfig {
	/** Enable or disable DPS entirely. Default: true */
	enabled: boolean;
	/**
	 * Maximum total character count for the composed system prompt.
	 * When exceeded, low-priority entries are trimmed from the end.
	 * L0 entries are never removed. 0 = unlimited.
	 */
	maxSegmentChars: number;
	/** Additional variables passed to all template renders */
	variables: Record<string, string>;
}

// ─── Compose Result ──────────────────────────────────────────────

/**
 * Output of PromptComposer.compose(). Returned by the DPS pipeline
 * on every before_agent_start invocation.
 */
export interface ComposeResult {
	/** Final composed system prompt text (L0-L3 joined with \n\n) */
	text: string;
	/**
	 * Cache-aware system prompt blocks. Stable (non-dynamic) entries form the first block,
	 * dynamic entries form the second block. Providers that support per-block caching
	 * (Anthropic, Bedrock) can cache the stable prefix independently.
	 */
	blocks: SystemPromptBlock[];
	/** DJB2 fingerprint of the composed content for change detection */
	fingerprint: string;
	/** Template names and segment IDs that were active in this composition */
	activeIds: string[];
}
