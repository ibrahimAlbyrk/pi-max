/**
 * Test Execution Detector — Detect test pass/fail from bash output
 */

export interface TestResult {
	isTestRun: boolean;
	allPassed: boolean;
	hasFailed: boolean;
}

const TEST_COMMANDS = /(?:jest|vitest|mocha|pytest|cargo\s+test|go\s+test|npm\s+test|npx\s+test|pnpm\s+test|yarn\s+test|bun\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)/i;
const PASS_PATTERNS = /(?:all\s+tests?\s+passed|tests?\s+passed|✓.*passing|0\s+failed|passed!|tests?\s+successful|test\s+result:\s+ok)/i;
const FAIL_PATTERNS = /(?:\d+\s+failed|FAIL(?:ED)?|Error:|test\s+result:\s+FAILED|failures?:?\s*[1-9])/i;

export function detectTestResult(command: string, output: string): TestResult {
	const isTestRun = TEST_COMMANDS.test(command) || TEST_COMMANDS.test(output);

	if (!isTestRun) {
		return { isTestRun: false, allPassed: false, hasFailed: false };
	}

	const allPassed = PASS_PATTERNS.test(output);
	const hasFailed = FAIL_PATTERNS.test(output);

	return { isTestRun, allPassed: allPassed && !hasFailed, hasFailed };
}
