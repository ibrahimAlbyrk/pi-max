/**
 * ask_user tool — lets the agent ask the user structured questions.
 *
 * Registered as an internal ToolDefinition (not a base AgentTool) because it
 * needs ctx.ui access for the QuestionDialog UI. It's always active and does
 * not have side effects.
 *
 * The agent sends question parameters (title, pages with different modes),
 * the UI presents them to the user, and the formatted answers are returned
 * as readable text in the tool result.
 */

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { QuestionPage } from "../../modes/interactive/components/question-dialog.js";
import type { ToolDefinition } from "../extensions/types.js";

// ── Schema ─────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Description shown below the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question identifier" }),
	label: Type.Optional(
		Type.String({ description: "Short label for tab bar (e.g. 'Scope', 'Priority'). Defaults to Q1, Q2, ..." }),
	),
	prompt: Type.String({ description: "The full question text" }),
	type: Type.Optional(
		Type.Union(
			[Type.Literal("single-select"), Type.Literal("multi-select"), Type.Literal("input"), Type.Literal("confirm")],
			{
				description:
					"Answer mode. single-select: pick one option. multi-select: toggle multiple options. input: free text. confirm: yes/no. Default: single-select",
			},
		),
	),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for single-select or multi-select" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder text for input mode" })),
	message: Type.Optional(Type.String({ description: "Message for confirm mode" })),
});

const AskUserSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Dialog title" })),
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask. One question shows a simple list, multiple shows tabbed navigation.",
	}),
});

// ── Types ──────────────────────────────────────────────────────────────────

interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	type?: "single-select" | "multi-select" | "input" | "confirm";
	options?: { value: string; label: string; description?: string }[];
	placeholder?: string;
	message?: string;
}

interface AskUserDetails {
	title?: string;
	questions: QuestionInput[];
	answers: { id: string; question: string; answer: string }[];
	cancelled: boolean;
}

// ── Tool Definition ────────────────────────────────────────────────────────

export const askUserTool: ToolDefinition<typeof AskUserSchema, AskUserDetails> = {
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the user one or more structured questions when you need clarification, preferences, or decisions before proceeding. Supports single-select, multi-select, text input, and yes/no confirm modes. For a single question, shows a simple list. For multiple, shows tabbed navigation. Use this instead of asking questions in plain text when you need specific, structured answers.",
	parameters: AskUserSchema,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!ctx.hasUI) {
			return {
				content: [{ type: "text", text: "Error: UI not available (non-interactive mode)" }],
				details: { questions: params.questions, answers: [], cancelled: true },
			};
		}

		if (params.questions.length === 0) {
			return {
				content: [{ type: "text", text: "Error: No questions provided" }],
				details: { questions: [], answers: [], cancelled: true },
			};
		}

		// Build QuestionDialog pages
		const pages: QuestionPage[] = params.questions.map((q, i) => {
			const title = q.label || `Q${i + 1}`;
			const prompt = q.prompt;
			const type = q.type || "single-select";
			const options = (q.options || []).map((o) => ({
				value: o.value,
				label: o.label,
				description: o.description,
			}));

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

		const result = await ctx.ui.question({ title: params.title, pages });

		if (!result.completed) {
			return {
				content: [{ type: "text", text: "User cancelled." }],
				details: { title: params.title, questions: params.questions, answers: [], cancelled: true },
			};
		}

		// Format answers as readable Q&A text
		const answers: AskUserDetails["answers"] = [];
		const lines: string[] = [];

		for (let i = 0; i < params.questions.length; i++) {
			const q = params.questions[i];
			const answer = result.answers[i];
			if (!answer) continue;

			let answerText: string;
			switch (answer.type) {
				case "single-select":
					answerText = answer.label;
					break;
				case "multi-select":
					answerText = answer.values.length > 0 ? answer.values.map((v) => v.label).join(", ") : "(none selected)";
					break;
				case "input":
					answerText = answer.value;
					break;
				case "confirm":
					answerText = answer.value ? "Yes" : "No";
					break;
			}

			answers.push({ id: q.id, question: q.prompt, answer: answerText });
			lines.push(`Q: ${q.prompt}\nA: ${answerText}`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n\n") }],
			details: { title: params.title, questions: params.questions, answers, cancelled: false },
		};
	},

	renderCall(args, theme) {
		const qs = (args.questions as QuestionInput[]) || [];
		if (qs.length === 0) return undefined;

		let text = theme.fg("toolTitle", theme.bold("ask_user "));
		if (qs.length === 1) {
			text += theme.fg("muted", qs[0].prompt);
		} else {
			const labels = qs.map((q) => q.label || q.id).join(", ");
			text += theme.fg("muted", `${qs.length} questions`) + theme.fg("dim", ` (${labels})`);
		}
		return new Text(text, 0, 0);
	},

	renderResult(result, _options, theme) {
		const details = result.details;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		if (details.cancelled) {
			return new Text(theme.fg("warning", "Cancelled"), 0, 0);
		}

		const lines = details.answers.map(
			(a) => `${theme.fg("success", "✓ ")}${theme.fg("muted", `${a.id}: `)}${theme.fg("text", a.answer)}`,
		);
		return new Text(lines.join("\n"), 0, 0);
	},
};
