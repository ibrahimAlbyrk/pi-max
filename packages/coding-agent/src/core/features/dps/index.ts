/**
 * Dynamic Prompt System (DPS) — Feature Entry Point
 *
 * Sets up the DPS built-in feature: creates the StateManager and PromptComposer,
 * loads configuration, and registers all lifecycle hooks into the agent session.
 *
 * Exports:
 *   DpsFeatureSession   — minimal interface the session must implement
 *   DpsFeature          — public API returned to the caller (registerProgrammaticSegment)
 *   setupDpsFeature()   — wires all hooks; call from AgentSession constructor
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import { parse } from "yaml";
import { getPromptRegistry, invalidatePromptRegistry } from "../../prompt-registry.js";
import type { ResourceLoader } from "../../resource-loader.js";
import {
	composeDpsPrompt,
	getAllProgrammaticSegments,
	getL4Reminders,
	registerProgrammaticSegment as registerSegmentInBuilder,
	registerVariableProvider as registerVariableProviderInBuilder,
} from "./prompt-builder.js";
import { PromptComposer } from "./prompt-composer.js";
import { StateManager } from "./state-manager.js";
import { scanDpsTemplates } from "./template-scanner.js";
import type {
	ComposeResult,
	DPSConfig,
	DpsEntry,
	Layer,
	ProgrammaticSegment,
	ResolvedEntry,
	RuntimeState,
	VariableProvider,
} from "./types.js";

// ─── Session Interface ────────────────────────────────────────────────────────

/**
 * Minimal interface describing the session hooks and accessors required by
 * setupDpsFeature. AgentSession implements all of these.
 *
 * The interface keeps this module decoupled from the concrete AgentSession
 * class — following the same pattern as BgFeatureSession, LspFeatureSession,
 * and TaskFeatureSession.
 */
export interface DpsFeatureSession {
	/** Register a handler called when a new session starts (initial bind, newSession, reload). */
	onSessionStart(handler: (ctx: { cwd: string }) => Promise<void>): void;

	/** Register a handler called when the active session is switched. */
	onSessionSwitch(
		handler: (event: { reason: string; previousSessionFile: string | undefined }) => Promise<void>,
	): void;

	/** Register a handler called when the session is forked. */
	onSessionFork(handler: (event: { previousSessionFile: string | undefined }) => Promise<void>): void;

	/**
	 * Register a handler called before the agent starts processing each prompt.
	 * DPS uses this to compose the L0-L3 system prompt and inject L4 reminder messages.
	 * Returning { systemPrompt } overrides the base system prompt for this turn.
	 */
	onBeforeAgentStart(
		handler: (ctx: { cwd: string }) => Promise<
			| {
					systemPrompt?: string;
					messages?: Array<{
						customType: string;
						content: string | (ImageContent | TextContent)[];
						display: boolean;
						details?: unknown;
						excludeFromContext?: boolean;
					}>;
			  }
			| undefined
		>,
	): void;

	/** Register a handler called when a tool execution starts (before execution). */
	onToolCall(handler: (event: { toolName: string; input: unknown }) => Promise<void>): void;

	/** Register a handler called at the end of each agent turn. */
	onTurnEnd(handler: (event: { turnIndex: number }) => Promise<void>): void;

	/** Get the names of tools currently active for the agent. */
	getActiveToolNames(): string[];

	/** Get all registered tool infos (name and description). */
	getAllTools(): Array<{ name: string; description: string }>;

	/** Get context window info for token usage percentage calculation. */
	getContextInfo(): { contextWindow: number; estimatedTokens: number };

	/** Currently active model (may be undefined before first model selection). */
	readonly model: Model<any> | undefined;

	/** Resource loader for skills, context files, and custom/append prompts. */
	readonly resourceLoader: ResourceLoader;
}

// ─── Feature Public API ───────────────────────────────────────────────────────

/**
 * Public API returned by setupDpsFeature().
 * Allows other built-in features to inject runtime-generated content
 * into the DPS composition pipeline alongside file-based templates.
 */
export interface DpsFeature {
	/**
	 * Register a programmatic segment that participates in the DPS composition
	 * pipeline. The segment's generate() function is called on every
	 * before_agent_start invocation alongside all file-based DPS templates.
	 *
	 * Called during feature setup (before any agent turn) so segments are
	 * available from the first composition cycle.
	 *
	 * @example
	 * // Task feature registers a __task-context segment at L2:
	 * dpsFeature.registerProgrammaticSegment({
	 *   id: "__task-context",
	 *   layer: 2,
	 *   priority: 1,
	 *   generate(context) { return buildTaskContextText(context); },
	 * });
	 */
	registerProgrammaticSegment(segment: ProgrammaticSegment): void;

	/**
	 * Register a variable provider that contributes additional template variables
	 * to every DPS prompt render. The provider's provide() function is called in
	 * buildRenderVariables() on every before_agent_start invocation.
	 *
	 * Provider-supplied variables are merged after the built-in variables but
	 * before user-defined config.variables, so config always wins.
	 *
	 * @example
	 * // Task feature provides TASK_CONTEXT so templates can use {{TASK_CONTEXT}}:
	 * dpsFeature.registerVariableProvider({
	 *   provide(context) { return { TASK_CONTEXT: buildTaskContextText() }; },
	 * });
	 */
	registerVariableProvider(provider: VariableProvider): void;
}

// ─── Debug Handle ─────────────────────────────────────────────────────────────

/**
 * Internal debug interface exposed to /dps:log and /dps:reload commands.
 * Provides read-only access to DPS runtime state and the last composition result.
 *
 * Obtained via getDpsDebugHandle() — set when setupDpsFeature() runs.
 * Returns null before DPS is initialised (no agent session active).
 */
export interface DpsDebugHandle {
	/** Current DPS configuration (enabled, maxSegmentChars, variables). */
	getConfig(): DPSConfig;
	/** All DPS-enabled template entries scanned from the registry. */
	getAllTemplateEntries(): DpsEntry[];
	/** Immutable snapshot of the current runtime state. */
	getRuntimeState(): Readonly<RuntimeState>;
	/**
	 * Resolved entries from the last composition cycle (L0-L3 only,
	 * after token budget is applied). Empty if no composition has run yet.
	 */
	getLastResolvedEntries(): ResolvedEntry[];
	/** Last ComposeResult (text + activeIds + fingerprint), or null before first composition. */
	getLastComposeResult(): ComposeResult | null;
	/**
	 * All programmatic segments (built-in DEFAULT_PROGRAMMATIC_SEGMENTS + any
	 * externally registered via registerProgrammaticSegment()).
	 */
	getAllProgrammaticSegments(): Array<{ id: string; layer: Layer; priority: number }>;
	/**
	 * Hot-reload: clears the entry cache (forces re-scan on next composition)
	 * and invalidates the PromptRegistry (picks up new/modified template files).
	 */
	reload(): void;
}

/** Module-level handle set by setupDpsFeature(). Null before first setup. */
let _debugHandle: DpsDebugHandle | null = null;

/**
 * Return the current DPS debug handle, or null if DPS has not been set up.
 * Used by registerDpsCommands() in commands.ts.
 */
export function getDpsDebugHandle(): DpsDebugHandle | null {
	return _debugHandle;
}

// ─── Configuration Loading ─────────────────────────────────────────────────────

const DEFAULT_DPS_CONFIG: DPSConfig = {
	enabled: true,
	maxSegmentChars: 0,
	variables: {},
};

/**
 * Load DPS configuration from `<cwd>/.pi/pi.yml` (the `dps:` section).
 * Falls back to defaults if the file is absent, unreadable, or has no `dps:` key.
 */
function loadDpsConfig(cwd: string): DPSConfig {
	const configPath = join(cwd, ".pi", "pi.yml");
	if (!existsSync(configPath)) return { ...DEFAULT_DPS_CONFIG };

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = parse(raw) as Record<string, unknown> | null | undefined;
		const dpsBlock = parsed?.dps as Record<string, unknown> | null | undefined;
		if (!dpsBlock) return { ...DEFAULT_DPS_CONFIG };

		return {
			enabled: typeof dpsBlock.enabled === "boolean" ? dpsBlock.enabled : DEFAULT_DPS_CONFIG.enabled,
			maxSegmentChars:
				typeof dpsBlock.maxSegmentChars === "number"
					? dpsBlock.maxSegmentChars
					: DEFAULT_DPS_CONFIG.maxSegmentChars,
			variables:
				typeof dpsBlock.variables === "object" && dpsBlock.variables !== null
					? (dpsBlock.variables as Record<string, string>)
					: {},
		};
	} catch {
		return { ...DEFAULT_DPS_CONFIG };
	}
}

// ─── Feature Setup ─────────────────────────────────────────────────────────────

/**
 * Wire all DPS lifecycle hooks into an agent session.
 *
 * Creates a StateManager (runtime state tracking) and PromptComposer
 * (fingerprint cache + token budget), loads DPS configuration, and registers:
 *
 *   session_start / session_switch / session_fork
 *     → reset state, clear entry cache, invalidate registry
 *
 *   before_agent_start
 *     → compose L0-L3 system prompt via composeDpsPrompt()
 *     → inject L4 reminder messages via getL4Reminders()
 *     → returns { systemPrompt, messages } to override the base prompt
 *
 *   tool_call
 *     → recordToolCall() for condition evaluation (turns_since_tool_use)
 *
 *   turn_end
 *     → incrementTurn() for turn-based conditions and L4 cooldown tracking
 *
 * Called from AgentSession constructor after other feature setups.
 */
export function setupDpsFeature(session: DpsFeatureSession): DpsFeature {
	const stateManager = new StateManager();
	const composer = new PromptComposer();

	// Initial config — re-loaded on session_start when cwd is known
	let config: DPSConfig = { ...DEFAULT_DPS_CONFIG };

	// Cache of scanned DPS entries — null means "needs re-scan".
	// Invalidated on session start/switch/fork and by /dps:reload.
	let cachedEntries: DpsEntry[] | null = null;

	/** Get DPS-enabled template entries, using the session-level cache. */
	function getEntries(): DpsEntry[] {
		if (!cachedEntries) {
			cachedEntries = scanDpsTemplates(getPromptRegistry(stateManager.snapshot().cwd));
		}
		return cachedEntries;
	}

	// ── Session lifecycle ──────────────────────────────────────────────────

	async function handleSessionReset(cwd?: string): Promise<void> {
		stateManager.reset();
		composer.reset();
		cachedEntries = null; // Force re-scan on next before_agent_start
		if (cwd) {
			stateManager.setCwd(cwd);
			config = loadDpsConfig(cwd);
		}
		// Invalidate the registry so the new cwd's project prompts are loaded
		invalidatePromptRegistry();
	}

	session.onSessionStart(async (ctx) => {
		await handleSessionReset(ctx.cwd);
	});

	session.onSessionSwitch(async (_event) => {
		// session_switch does not provide a new cwd — keep the existing one but reset state
		await handleSessionReset();
	});

	session.onSessionFork(async (_event) => {
		await handleSessionReset();
	});

	// ── Before agent start — core DPS hook ────────────────────────────────

	session.onBeforeAgentStart(async (ctx) => {
		if (!config.enabled) return undefined;

		// Step 1: Invalidate per-prompt caches (file existence, git branch)
		stateManager.invalidatePerPromptCaches();

		// Step 2: Update runtime state from session

		stateManager.setCwd(ctx.cwd);

		const activeToolNames = new Set(session.getActiveToolNames());
		stateManager.setActiveTools(activeToolNames);

		const allToolNames = new Set(session.getAllTools().map((t) => t.name));
		stateManager.setAllTools(allToolNames);

		// Token usage percentage (null if context window is unknown)
		const contextInfo = session.getContextInfo();
		const tokenUsagePercent =
			contextInfo.contextWindow > 0 ? (contextInfo.estimatedTokens / contextInfo.contextWindow) * 100 : null;
		stateManager.setTokenUsage(tokenUsagePercent);

		// Model name and capability tags
		const currentModel = session.model;
		if (currentModel) {
			const capabilities: string[] = [];
			if (currentModel.reasoning) capabilities.push("reasoning");
			if (currentModel.input.includes("image")) capabilities.push("image");
			stateManager.setModel(currentModel.id, capabilities);
		}

		// Step 3: Build PromptBuildContext from resource loader
		const resourceLoader = session.resourceLoader;
		const loadedSkills = resourceLoader.getSkills().skills;
		const loadedContextFiles = resourceLoader.getAgentsFiles().agentsFiles;
		const customPrompt = resourceLoader.getSystemPrompt();
		const appendParts = resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

		// Build active tools with descriptions for programmatic segments
		const allToolsMap = new Map(session.getAllTools().map((t) => [t.name, t]));
		const activeTools = session.getActiveToolNames().map((name) => {
			const info = allToolsMap.get(name);
			return { name, description: info?.description ?? "" };
		});

		const buildContext = {
			activeTools,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			cwd: ctx.cwd,
			customPrompt,
			appendSystemPrompt,
		};

		// Step 4: Get prompt registry and current state snapshot
		const registry = getPromptRegistry(ctx.cwd);
		const state = stateManager.snapshot();
		const entries = getEntries();

		// Step 5: Compose L0-L3 system prompt
		const composeResult = composeDpsPrompt({
			entries,
			state,
			config,
			buildContext,
			registry,
			composer,
			stateManager,
		});

		// Step 6: Evaluate L4 reminders for injection as conversation messages
		const reminderMessages = getL4Reminders({
			entries,
			state,
			config,
			buildContext,
			registry,
			stateManager,
		});

		// Build messages array from L4 reminders
		const messages: Array<{
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
			excludeFromContext?: boolean;
		}> = reminderMessages.map((m) => ({
			customType: m.customType,
			content: m.content,
			display: m.display,
		}));

		return {
			systemPrompt: composeResult.text || undefined,
			messages: messages.length > 0 ? messages : undefined,
		};
	});

	// ── Tool call tracking ───────────────────────────────────────────────

	session.onToolCall(async (event) => {
		stateManager.recordToolCall(event.toolName);
	});

	// ── Turn end tracking ────────────────────────────────────────────────

	session.onTurnEnd(async (_event) => {
		stateManager.incrementTurn();
	});

	// ── Debug Handle ─────────────────────────────────────────────────────

	_debugHandle = {
		getConfig: () => config,

		getAllTemplateEntries: () => getEntries(),

		getRuntimeState: () => stateManager.snapshot(),

		getLastResolvedEntries: () => composer.getLastResolvedEntries(),

		getLastComposeResult: () => composer.getLastResult(),

		getAllProgrammaticSegments: () =>
			getAllProgrammaticSegments().map((s) => ({ id: s.id, layer: s.layer, priority: s.priority })),

		reload: () => {
			cachedEntries = null;
			composer.reset();
			invalidatePromptRegistry();
		},
	};

	// ── Public API ───────────────────────────────────────────────────────

	return {
		registerProgrammaticSegment(segment: ProgrammaticSegment): void {
			// Delegates to the module-level registry in prompt-builder.ts,
			// which is used by composeDpsPrompt() on every composition cycle.
			registerSegmentInBuilder(segment);
		},
		registerVariableProvider(provider: VariableProvider): void {
			// Delegates to the module-level registry in prompt-builder.ts,
			// which is called by buildRenderVariables() on every composition cycle.
			registerVariableProviderInBuilder(provider);
		},
	};
}
