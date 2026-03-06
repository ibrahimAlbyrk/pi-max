/**
 * ask_user_question tool — built-in tool for structured user interaction.
 *
 * Allows the agent to ask the user one or more structured questions.
 * Supports single-select, multi-select, text input, and confirm modes.
 * Uses the QuestionDialog component via ctx.ui.question().
 */

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { QuestionDialogConfig, QuestionPage, ToolDefinition } from "../extensions/types.js";

// ============================================================================
// Schema
// ============================================================================

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Description shown below the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question identifier" }),
	label: Type.Optional(Type.String({ description: "Short label for tab bar (e.g. 'Scope'). Defaults to Q1, Q2..." })),
	prompt: Type.String({ description: "The question text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Additional context below the question" })),
	type: Type.Optional(
		Type.Union(
			[Type.Literal("single-select"), Type.Literal("multi-select"), Type.Literal("input"), Type.Literal("confirm")],
			{
				description:
					"Answer mode. single-select: pick one option. multi-select: toggle multiple. input: free text. confirm: yes/no. Default: single-select",
			},
		),
	),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description: "Options for single-select and multi-select modes",
		}),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder text for input mode" })),
	message: Type.Optional(Type.String({ description: "Additional message for confirm mode" })),
});

const AskQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Dialog title shown at the top" })),
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions to ask. Multiple questions show a tabbed interface.",
	}),
});

// ============================================================================
// Types
// ============================================================================

interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	description?: string;
	type?: "single-select" | "multi-select" | "input" | "confirm";
	options?: { value: string; label: string; description?: string }[];
	placeholder?: string;
	message?: string;
}

interface AskQuestionDetails {
	title?: string;
	questions: QuestionInput[];
	answers: { id: string; type: string; value: string; display: string }[];
	cancelled: boolean;
}

// ============================================================================
// Tool definition
// ============================================================================

export const askQuestionTool: ToolDefinition<typeof AskQuestionParams, AskQuestionDetails> = {
	name: "ask_user_question",
	label: "Ask User",
	description:
		"Ask the user one or more structured questions when you need their input to proceed. " +
		"Supports single-select (pick one), multi-select (toggle multiple), text input, and yes/no confirm modes. " +
		"Use for: clarifying requirements, choosing between options, getting preferences, confirming decisions. " +
		"Do NOT use for trivial yes/no questions that can be asked in regular conversation text.",
	parameters: AskQuestionParams,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!ctx.hasUI) {
			return {
				content: [
					{
						type: "text",
						text: "Error: UI not available. Cannot ask questions in non-interactive mode. Ask the question in your response text instead.",
					},
				],
				details: {
					title: params.title,
					questions: params.questions,
					answers: [],
					cancelled: true,
				},
			};
		}

		if (params.questions.length === 0) {
			return {
				content: [{ type: "text", text: "Error: No questions provided." }],
				details: { title: params.title, questions: [], answers: [], cancelled: true },
			};
		}

		// Build QuestionDialogConfig
		const pages: QuestionPage[] = params.questions.map((q, i) => {
			const title = q.label || `Q${i + 1}`;
			const prompt = q.prompt;
			const description = q.description;
			const type = q.type || "single-select";

			const options = (q.options || []).map((o) => ({
				value: o.value,
				label: o.label,
				description: o.description,
			}));

			switch (type) {
				case "multi-select":
					return { title, prompt, description, mode: { type: "multi-select" as const, options } };
				case "input":
					return { title, prompt, description, mode: { type: "input" as const, placeholder: q.placeholder } };
				case "confirm":
					return { title, prompt, description, mode: { type: "confirm" as const, message: q.message } };
				default:
					return { title, prompt, description, mode: { type: "single-select" as const, options } };
			}
		});

		const config: QuestionDialogConfig = {
			title: params.title,
			pages,
		};

		const result = await ctx.ui.question(config);

		if (!result.completed) {
			return {
				content: [{ type: "text", text: "User cancelled the question dialog." }],
				details: {
					title: params.title,
					questions: params.questions,
					answers: [],
					cancelled: true,
				},
			};
		}

		// Format answers
		const answers: AskQuestionDetails["answers"] = [];
		const lines: string[] = [];

		for (let i = 0; i < params.questions.length; i++) {
			const q = params.questions[i];
			const answer = result.answers[i];
			if (!answer) continue;

			let value: string;
			let display: string;

			switch (answer.type) {
				case "single-select":
					value = answer.value;
					display = answer.label;
					break;
				case "multi-select":
					value = answer.values.map((v) => v.value).join(", ");
					display = answer.values.length > 0 ? answer.values.map((v) => v.label).join(", ") : "(none selected)";
					break;
				case "input":
					value = answer.value;
					display = answer.value;
					break;
				case "confirm":
					value = answer.value ? "yes" : "no";
					display = answer.value ? "Yes" : "No";
					break;
			}

			answers.push({ id: q.id, type: answer.type, value, display });
			lines.push(`Question: ${q.prompt}`);
			lines.push(`Answer: ${display}`);
			lines.push("");
		}

		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details: {
				title: params.title,
				questions: params.questions,
				answers,
				cancelled: false,
			},
		};
	},

	renderCall(args, _options, theme) {
		const qs = (args.questions as QuestionInput[]) || [];
		const count = qs.length;
		const labels = qs.map((q) => q.label || q.id).join(", ");

		let text = theme.fg("toolTitle", theme.bold("Ask User "));
		if (count === 1) {
			text += theme.fg("muted", qs[0].prompt);
		} else {
			text += theme.fg("muted", `${count} questions`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
		}
		return new Text(text, 0, 0);
	},

	renderResult(result, _options, theme) {
		const details = result.details;
		if (!details) {
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "", 0, 0);
		}

		if (details.cancelled) {
			return new Text(theme.fg("warning", "Cancelled"), 0, 0);
		}

		const lines = details.answers.map((a) => {
			const label = details.questions.find((q) => q.id === a.id)?.label || a.id;
			return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${a.display}`;
		});

		return new Text(lines.join("\n"), 0, 0);
	},
};
