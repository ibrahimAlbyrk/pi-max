/**
 * Plan Converter — Extract numbered plan steps from LLM output
 *
 * Parses numbered lists from free-form LLM text into structured
 * step strings suitable for task creation via bulk_create.
 */

/**
 * Extract numbered plan steps from LLM output text.
 *
 * Looks for a labelled section ("Plan:", "Steps:", "Todo:", "Tasks:")
 * first; if none is found, scans the entire input for numbered lines.
 *
 * Returns an array of step strings (e.g. ["Set up project", "Write tests"]).
 * Lines shorter than 6 characters are filtered out as noise.
 */
export function extractPlanSteps(text: string): string[] {
	// Try to find a "Plan:" section first
	const planSection = text.match(/(?:Plan|Steps|Todo|Tasks?):\s*\n([\s\S]*?)(?:\n\n|\n---|\n##|$)/i);

	const source = planSection ? planSection[1] : text;
	const lines = source.split("\n");

	return lines
		.map((line) => line.match(/^\s*\d+[.)]\s*(.+)/)?.[1]?.trim())
		.filter((s): s is string => !!s && s.length > 5);
}
