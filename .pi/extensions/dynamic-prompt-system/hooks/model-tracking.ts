/**
 * DPS Hook: model_select
 *
 * Updates model info and capabilities in state.
 */

import type { ModelSelectEvent } from "@mariozechner/pi-coding-agent";
import type { StateManager } from "../core/state-manager.js";

export function handleModelSelect(stateManager: StateManager) {
	return async (event: ModelSelectEvent) => {
		const model = event.model;
		const capabilities: string[] = [];

		if (model.reasoning) capabilities.push("reasoning");
		if (model.input?.includes("image")) capabilities.push("image");

		stateManager.setModel(model.id || model.name || "", capabilities);
	};
}
