/**
 * DPS Hook: turn_end
 *
 * Increments turn counter in state.
 */

import type { TurnEndEvent } from "@mariozechner/pi-coding-agent";
import type { StateManager } from "../core/state-manager.js";

export function handleTurnEnd(stateManager: StateManager) {
	return async (_event: TurnEndEvent) => {
		stateManager.incrementTurn();
	};
}
