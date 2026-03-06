/**
 * Test Execution Detector — Detect test pass/fail from bash output
 *
 * Recognizes common test runners (jest, vitest, mocha, pytest, cargo test,
 * go test, npm/pnpm/yarn/bun test, dotnet test, mvn test, gradle test)
 * and classifies output as passing, failing, or non-test output.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface TestResult {
	/** True if the command or output looks like a test run */
	isTestRun: boolean;
	/** True if all tests passed (and none failed) */
	allPassed: boolean;
	/** True if at least one test failed */
	hasFailed: boolean;
}

// ─── Detection Patterns ───────────────────────────────────────────

const TEST_COMMANDS =
	/(?:jest|vitest|mocha|pytest|cargo\s+test|go\s+test|npm\s+test|npx\s+test|pnpm\s+test|yarn\s+test|bun\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)/i;

const PASS_PATTERNS =
	/(?:all\s+tests?\s+passed|tests?\s+passed|✓.*passing|0\s+failed|passed!|tests?\s+successful|test\s+result:\s+ok)/i;

const FAIL_PATTERNS = /(?:\d+\s+failed|FAIL(?:ED)?|Error:|test\s+result:\s+FAILED|failures?:?\s*[1-9])/i;

// ─── Public API ──────────────────────────────────────────────────

/**
 * Analyse a bash command + its output to determine if it was a test run
 * and whether the tests passed or failed.
 *
 * @param command - The bash command that was executed
 * @param output  - The combined stdout/stderr output of the command
 */
export function detectTestResult(command: string, output: string): TestResult {
	const isTestRun = TEST_COMMANDS.test(command) || TEST_COMMANDS.test(output);

	if (!isTestRun) {
		return { isTestRun: false, allPassed: false, hasFailed: false };
	}

	const allPassed = PASS_PATTERNS.test(output);
	const hasFailed = FAIL_PATTERNS.test(output);

	return {
		isTestRun,
		allPassed: allPassed && !hasFailed,
		hasFailed,
	};
}
