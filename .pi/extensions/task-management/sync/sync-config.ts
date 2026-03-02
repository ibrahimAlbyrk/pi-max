/**
 * Sync Configuration — Settings for TASKS.md auto-sync
 */

export interface SyncConfig {
	enabled: boolean;
	path: string;
	format: "summary" | "full";
	autoSync: boolean;
	syncOnExit: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
	enabled: false,       // Disabled by default — must be explicitly enabled
	path: "TASKS.md",
	format: "summary",
	autoSync: false,      // Don't write on every task change
	syncOnExit: false,    // Don't write on session shutdown
};

export function mergeSyncConfig(partial: Partial<SyncConfig>): SyncConfig {
	return { ...DEFAULT_SYNC_CONFIG, ...partial };
}
