/**
 * Intelligence Hooks — context injection, compaction safety
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SharedContext } from "./shared-context.js";
import { buildTaskContext, determineBudgetLevel } from "../intelligence/context-injector.js";
import { generateTaskStateSummary } from "../intelligence/compaction-handler.js";
import { cloneStore } from "../store.js";

export function registerIntelligenceHooks(pi: ExtensionAPI, sc: SharedContext): void {

	// ─── Context Injection ───────────────────────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		if (sc.store.tasks.length === 0) return;

		const usage = ctx.getContextUsage();
		const level = determineBudgetLevel(usage.contextWindow, usage.currentTokens);
		const context = buildTaskContext(sc.store, level);

		if (!context) return;

		return {
			message: {
				customType: "task-context",
				content: context,
				display: false,
			},
		};
	});

	// ─── Compaction Safety ───────────────────────────────────────

	pi.on("session_before_compact", async (event, _ctx) => {
		if (sc.store.tasks.length === 0) return;

		const { preparation } = event as any;
		if (!preparation) return;

		const taskSummary = generateTaskStateSummary(sc.store);
		const enhancedSummary = preparation.summary
			? `${preparation.summary}\n\n## Task Management State\n${taskSummary}`
			: `## Task Management State\n${taskSummary}`;

		return {
			compaction: {
				...preparation,
				summary: enhancedSummary,
			},
		};
	});

	pi.on("session_compact", async (_event, _ctx) => {
		pi.appendEntry("task-store-snapshot", { store: cloneStore(sc.store) });
	});
}
