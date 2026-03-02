/**
 * Plan Converter — Extract numbered plan steps from LLM output
 */

export function extractPlanSteps(text: string): string[] {
	// Try to find a "Plan:" section first
	const planSection = text.match(/(?:Plan|Steps|Todo|Tasks?):\s*\n([\s\S]*?)(?:\n\n|\n---|\n##|$)/i);

	const source = planSection ? planSection[1] : text;
	const lines = source.split("\n");

	return lines
		.map((line) => line.match(/^\s*\d+[\.\)]\s*(.+)/)?.[1]?.trim())
		.filter((s): s is string => !!s && s.length > 5);
}
