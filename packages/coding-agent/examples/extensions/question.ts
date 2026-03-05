/**
 * Question Tool - Single question with options
 *
 * Uses the built-in QuestionDialog component via ctx.ui.question() API.
 * Supports single-select options with an optional "Type something" input.
 */

import type { ExtensionAPI, QuestionDialogConfig, QuestionPage } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			// Build options with "Let me type..." at the end
			const options = [
				...params.options.map((o) => ({
					value: o.label,
					label: o.label,
					description: o.description,
				})),
				{ value: "__type__", label: "Let me type..." },
			];

			const page: QuestionPage = {
				title: "Question",
				prompt: params.question,
				mode: { type: "single-select", options },
			};

			const config: QuestionDialogConfig = {
				pages: [page],
			};

			const result = await ctx.ui.question(config);

			const simpleOptions = params.options.map((o) => o.label);

			if (!result.completed) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			const answer = result.answers[0];
			if (!answer || answer.type !== "single-select") {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			// If user selected "Let me type...", the value will be "__type__"
			// In that case, we'd need a follow-up input — but for simplicity,
			// we treat it as a regular selection. For full input support,
			// use the questionnaire tool with type: "input".
			if (answer.value === "__type__") {
				// Fall back to input dialog
				const typed = await ctx.ui.input("Your answer", "Type your response...");
				if (!typed) {
					return {
						content: [{ type: "text", text: "User cancelled the input" }],
						details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
					};
				}
				return {
					content: [{ type: "text", text: `User wrote: ${typed}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: typed,
						wasCustom: true,
					} as QuestionDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User selected: ${answer.index + 1}. ${answer.label}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: answer.label,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, _options, theme) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: { label: string }) => o.label);
				const numbered = [...labels, "Let me type..."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
