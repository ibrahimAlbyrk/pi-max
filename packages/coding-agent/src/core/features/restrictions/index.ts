/**
 * Built-in restrictions feature.
 *
 * Configurable sandbox for agent tool access. Restricts filesystem access,
 * bash commands, and tool usage via config files.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/restrictions.json (global)
 * - <cwd>/.pi/restrictions.json (project-local)
 *
 * Wire lifecycle hooks into an agent session:
 * 1. session_start → load config, create checker, register on session
 * 2. session_shutdown → cleanup
 *
 * Called from AgentSession initialization after the runtime is built.
 */

import { createRestrictionChecker } from "./checker.js";
import { loadRestrictionsConfig } from "./config.js";
import type { RestrictionChecker, RestrictionUIContext } from "./types.js";

export type { RestrictionChecker, RestrictionCheckResult, RestrictionConfig } from "./types.js";
export { wrapToolWithRestrictions } from "./wrapper.js";

/**
 * Minimal interface describing the session hooks required by setupRestrictionsFeature.
 * AgentSession will implement these when the restrictions feature is integrated.
 */
export interface RestrictionsFeatureSession {
	/** Register a handler called when a new agent session starts. */
	onSessionStart(handler: (ctx: { cwd: string }) => Promise<void>): void;
	/** Register a handler called when the session shuts down. */
	onSessionShutdown(handler: () => Promise<void>): void;
	/** Set the restriction checker on the session for tool wrapping. */
	setRestrictionChecker(checker: RestrictionChecker | null): void;
	/** Get the UI context for confirmations and notifications. May be undefined before binding. */
	getRestrictionUIContext(): RestrictionUIContext | undefined;
	/** Check if --no-restrictions flag is set. */
	isNoRestrictions(): boolean;
}

/**
 * Wire restrictions lifecycle hooks into an agent session.
 *
 * 1. session_start → load config, create checker, register on session.
 * 2. session_shutdown → clear checker.
 *
 * Called from AgentSession initialization after the runtime is built.
 */
export function setupRestrictionsFeature(session: RestrictionsFeatureSession): void {
	// Session start → load config, create checker
	session.onSessionStart(async (ctx) => {
		if (session.isNoRestrictions()) {
			session.setRestrictionChecker(null);
			const ui = session.getRestrictionUIContext();
			if (ui?.hasUI) {
				ui.notify("Restrictions disabled via --no-restrictions", "warning");
			}
			return;
		}

		const config = loadRestrictionsConfig(ctx.cwd);

		if (!config.enabled) {
			session.setRestrictionChecker(null);
			return;
		}

		const ui = session.getRestrictionUIContext();
		const checker = createRestrictionChecker(config, ctx.cwd, ui);
		session.setRestrictionChecker(checker);

		// Notify user about active restrictions
		if (ui?.hasUI) {
			const deniedPathCount = config.filesystem?.deniedPaths?.length ?? 0;
			const deniedPatternCount =
				(config.bash?.deniedPatterns?.length ?? 0) + (config.bash?.deniedCommands?.length ?? 0);
			const disabledToolCount = config.tools?.disabled?.length ?? 0;

			const parts: string[] = [];
			if (config.filesystem?.readOnly || config.tools?.readOnlyMode) parts.push("read-only");
			if (deniedPathCount > 0) parts.push(`${deniedPathCount} denied paths`);
			if (deniedPatternCount > 0) parts.push(`${deniedPatternCount} bash rules`);
			if (disabledToolCount > 0) parts.push(`${disabledToolCount} disabled tools`);

			const summary = parts.length > 0 ? parts.join(", ") : "default rules";
			ui.notify(`Restrictions active: ${summary}`, "info");
		}
	});

	// Session shutdown → clear checker
	session.onSessionShutdown(async () => {
		session.setRestrictionChecker(null);
	});
}
