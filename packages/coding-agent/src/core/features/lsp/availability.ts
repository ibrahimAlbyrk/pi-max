/**
 * Checks whether the `vscode-languageserver-protocol` package is installed.
 * Uses require.resolve (sync, no module loading) so it can be called before
 * any LSP module is imported — preventing the app from crashing when the
 * package is missing.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let _available: boolean | undefined;

/**
 * Synchronously check if `vscode-languageserver-protocol` is resolvable.
 * Result is cached after the first call; use `resetLspAvailability()` to clear.
 */
export function isLspPackageAvailable(): boolean {
	if (_available === undefined) {
		try {
			require.resolve("vscode-languageserver-protocol");
			_available = true;
		} catch {
			_available = false;
		}
	}
	return _available;
}

/** Clear the cached availability result (e.g. after installing the package). */
export function resetLspAvailability(): void {
	_available = undefined;
}

/**
 * Install `vscode-languageserver-protocol` via npm.
 * Returns true on success, false on failure.
 */
export function installLspPackage(cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("npm", ["install", "vscode-languageserver-protocol"], { cwd }, (error) => {
			if (error) {
				resolve(false);
			} else {
				resetLspAvailability();
				resolve(true);
			}
		});
	});
}
