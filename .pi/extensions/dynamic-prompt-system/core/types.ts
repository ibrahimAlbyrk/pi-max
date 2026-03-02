/**
 * DPS (Dynamic Prompt System) — Type Definitions
 *
 * All interfaces and types used across the DPS extension.
 */

// ============================================================================
// Layer Constants
// ============================================================================

/** Layer levels for segments */
export type Layer = 0 | 1 | 2 | 3 | 4;

export const LAYER_NAMES: Record<Layer, string> = {
	0: "CORE",
	1: "ENVIRONMENT",
	2: "TOOL",
	3: "CUSTOM",
	4: "REMINDER",
};

/** Segment source priority (higher overrides lower) */
export type SegmentSource = "builtin" | "global" | "project";

export const SOURCE_PRIORITY: Record<SegmentSource, number> = {
	builtin: 0,
	global: 1,
	project: 2,
};

// ============================================================================
// Condition Types
// ============================================================================

export interface ToolActiveCondition {
	type: "tool_active";
	tool: string;
}

export interface ToolInactiveCondition {
	type: "tool_inactive";
	tool: string;
}

export interface FileExistsCondition {
	type: "file_exists";
	path: string;
}

export interface DirExistsCondition {
	type: "dir_exists";
	path: string;
}

export interface TurnsSinceToolUseCondition {
	type: "turns_since_tool_use";
	tool: string;
	min: number;
}

export interface TokenUsageAboveCondition {
	type: "token_usage_above";
	percent: number;
}

export interface TokenUsageBelowCondition {
	type: "token_usage_below";
	percent: number;
}

export interface TurnCountAboveCondition {
	type: "turn_count_above";
	count: number;
}

export interface TurnCountBelowCondition {
	type: "turn_count_below";
	count: number;
}

export interface ModelSupportsCondition {
	type: "model_supports";
	capability: string;
}

export interface AllCondition {
	type: "all";
	conditions: Condition[];
}

export interface AnyCondition {
	type: "any";
	conditions: Condition[];
}

export interface NotCondition {
	type: "not";
	condition: Condition;
}

export type Condition =
	| ToolActiveCondition
	| ToolInactiveCondition
	| FileExistsCondition
	| DirExistsCondition
	| TurnsSinceToolUseCondition
	| TokenUsageAboveCondition
	| TokenUsageBelowCondition
	| TurnCountAboveCondition
	| TurnCountBelowCondition
	| ModelSupportsCondition
	| AllCondition
	| AnyCondition
	| NotCondition;

// ============================================================================
// Segment Types
// ============================================================================

/** Compiled evaluator function — created once from conditions, called per prompt */
export type ConditionEvaluator = (state: RuntimeState) => boolean;

/** Raw parsed segment from .md file */
export interface Segment {
	/** Unique identifier */
	id: string;

	/** Layer: 0=Core, 1=Environment, 2=Tool, 3=Custom, 4=Reminder */
	layer: Layer;

	/** Sort priority within same layer (lower = first). Default: 50 */
	priority: number;

	/** Raw markdown content (after frontmatter) */
	content: string;

	/** Parsed conditions */
	conditions: Condition[];

	/** Compiled evaluator (closure). Created from conditions at parse time */
	evaluator: ConditionEvaluator;

	/** Segment IDs that must also be active */
	dependsOn: string[];

	/** Segment IDs that conflict — if they're active, this is inactive */
	conflictsWith: string[];

	// --- Reminder-only (L4) ---

	/** Turns to wait after trigger before re-triggering */
	cooldown?: number;

	/** Maximum triggers per session */
	maxTriggers?: number;

	// --- Metadata ---

	/** Source file path */
	filePath: string;

	/** Where this segment came from */
	source: SegmentSource;
}

/** Segment with variables resolved — ready for composition */
export interface ResolvedSegment {
	id: string;
	layer: Layer;
	priority: number;
	resolvedContent: string;
	source: SegmentSource;
}

// ============================================================================
// Runtime State
// ============================================================================

export interface RuntimeState {
	/** Current turn count */
	turnCount: number;

	/** Currently active tool names */
	activeTools: Set<string>;

	/** All registered tool names (active + inactive) */
	allTools: Set<string>;

	/** Tool → last turn it was used */
	toolLastUsedAtTurn: Map<string, number>;

	/** Tool → total usage count in session */
	toolUsageCount: Map<string, number>;

	/** Current working directory */
	cwd: string;

	/** Active model name/id */
	modelName: string;

	/** Model capabilities: "reasoning", "image", etc. */
	modelCapabilities: Set<string>;

	/** Token usage percentage (0-100), null if unknown */
	tokenUsagePercent: number | null;

	// --- Reminder state ---

	/** Segment ID → turn when last triggered */
	reminderLastTriggered: Map<string, number>;

	/** Segment ID → total trigger count */
	reminderTriggerCount: Map<string, number>;
}

// ============================================================================
// Variable Resolution
// ============================================================================

/** Built-in variable names */
export type BuiltinVariable =
	| "CWD"
	| "DATE_TIME"
	| "MODEL_NAME"
	| "ACTIVE_TOOLS"
	| "GIT_BRANCH"
	| "TOKEN_USAGE"
	| "TURN_COUNT";

/** Custom variables from config */
export type CustomVariables = Record<string, string>;

/** All variables available for resolution */
export interface VariableContext {
	state: RuntimeState;
	customVariables: CustomVariables;
	gitBranch: string | null;
}

// ============================================================================
// Configuration
// ============================================================================

export interface DPSConfig {
	/** Custom variables for segment content */
	variables: CustomVariables;

	/** Whether DPS is enabled. Default: true */
	enabled: boolean;

	/** Maximum total token budget for DPS segments (chars as proxy). 0 = unlimited */
	maxSegmentChars: number;
}

export const DEFAULT_CONFIG: DPSConfig = {
	variables: {},
	enabled: true,
	maxSegmentChars: 0,
};

// ============================================================================
// Segment Parse Result
// ============================================================================

/** Raw parse result from frontmatter parser */
export interface ParseResult {
	metadata: Record<string, any>;
	content: string;
}

// ============================================================================
// Compose Result (for fingerprint caching)
// ============================================================================

export interface ComposeResult {
	/** The final composed string */
	text: string;
	/** Fingerprint for change detection */
	fingerprint: string;
	/** IDs of active segments in order */
	activeSegmentIds: string[];
}
