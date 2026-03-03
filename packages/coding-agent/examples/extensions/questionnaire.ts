/**
 * Questionnaire Tool - Structured questions using ctx.ui.question()
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 *
 * Uses the built-in QuestionDialog component via ctx.ui.question() API.
 */

import type { ExtensionAPI, QuestionDialogConfig, QuestionPage, QuestionResult } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	type: Type.Optional(
		Type.Union(
			[Type.Literal("single-select"), Type.Literal("multi-select"), Type.Literal("input"), Type.Literal("confirm")],
			{ description: "Answer mode (default: single-select)" },
		),
	),
	options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available options (for select modes)" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: false)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder text for input mode" })),
	message: Type.Optional(Type.String({ description: "Confirmation message for confirm mode" })),
});

const QuestionnaireParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Dialog title shown at the top" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	type?: "single-select" | "multi-select" | "input" | "confirm";
	options?: { value: string; label: string; description?: string }[];
	allowOther?: boolean;
	placeholder?: string;
	message?: string;
}

interface QuestionnaireDetails {
	title?: string;
	questions: QuestionInput[];
	answers: { id: string; value: string; label: string; wasCustom?: boolean; index?: number }[];
	cancelled: boolean;
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more structured questions. Supports single-select, multi-select, text input, and confirm modes. For single questions, shows a simple list. For multiple, shows tab navigation.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						questions: params.questions,
						answers: [],
						cancelled: true,
					} as QuestionnaireDetails,
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { questions: [], answers: [], cancelled: true } as QuestionnaireDetails,
				};
			}

			// Build QuestionDialogConfig from params
			const pages: QuestionPage[] = params.questions.map((q, i) => {
				const title = q.label || `Q${i + 1}`;
				const prompt = q.prompt;
				const type = q.type || "single-select";

				let options = (q.options || []).map((o) => ({
					value: o.value,
					label: o.label,
					description: o.description,
				}));

				// Add "Type something" option for single-select with allowOther
				if (type === "single-select" && q.allowOther) {
					options = [...options, { value: "__other__", label: "Let me type...", description: undefined }];
				}

				switch (type) {
					case "multi-select":
						return { title, prompt, mode: { type: "multi-select" as const, options } };
					case "input":
						return { title, prompt, mode: { type: "input" as const, placeholder: q.placeholder } };
					case "confirm":
						return { title, prompt, mode: { type: "confirm" as const, message: q.message } };
					default:
						return { title, prompt, mode: { type: "single-select" as const, options } };
				}
			});

			const config: QuestionDialogConfig = {
				title: params.title,
				pages,
			};

			const result: QuestionResult = await ctx.ui.question(config);

			if (!result.completed) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: {
						title: params.title,
						questions: params.questions,
						answers: [],
						cancelled: true,
					} as QuestionnaireDetails,
				};
			}

			// Build answer list
			const answers: QuestionnaireDetails["answers"] = [];
			for (let i = 0; i < params.questions.length; i++) {
				const q = params.questions[i];
				const answer = result.answers[i];
				if (!answer) continue;

				switch (answer.type) {
					case "single-select":
						answers.push({
							id: q.id,
							value: answer.value,
							label: answer.label,
							index: answer.index,
						});
						break;
					case "multi-select":
						answers.push({
							id: q.id,
							value: answer.values.map((v) => v.value).join(", "),
							label: answer.values.map((v) => v.label).join(", "),
						});
						break;
					case "input":
						answers.push({
							id: q.id,
							value: answer.value,
							label: answer.value,
							wasCustom: true,
						});
						break;
					case "confirm":
						answers.push({
							id: q.id,
							value: answer.value ? "yes" : "no",
							label: answer.value ? "Yes" : "No",
						});
						break;
				}
			}

			const answerLines = answers.map((a) => {
				const qLabel = params.questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: {
					title: params.title,
					questions: params.questions,
					answers,
					cancelled: false,
				} as QuestionnaireDetails,
			};
		},

		renderCall(args, theme) {
			const qs = (args.questions as QuestionInput[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${a.label}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
