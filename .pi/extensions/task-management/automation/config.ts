/**
 * Automation Configuration
 */

export interface TaskAutomationConfig {
	autoStartOnFileEdit: boolean;
	autoCompleteOnTestPass: boolean;
	autoNoteOnAgentEnd: boolean;
}

export const DEFAULT_CONFIG: TaskAutomationConfig = {
	autoStartOnFileEdit: true,
	autoCompleteOnTestPass: true,
	autoNoteOnAgentEnd: true,
};

export function mergeConfig(partial: Partial<TaskAutomationConfig>): TaskAutomationConfig {
	return { ...DEFAULT_CONFIG, ...partial };
}
