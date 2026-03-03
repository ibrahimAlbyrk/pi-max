/**
 * QuestionDialog - Multi-page question wizard component.
 *
 * Supports four answer modes per page:
 * - single-select: pick one option from a list
 * - multi-select: toggle multiple options with checkboxes
 * - input: free-form text entry
 * - confirm: yes/no confirmation
 *
 * Single-page dialogs hide the tab bar. Multi-page dialogs show
 * a dot-based tab indicator with page counter.
 *
 * Modern aesthetic: ▸ cursor, ○/● tab dots, ◉/○ checkboxes,
 * consistent spacing, themed borders and hints.
 */

import {
	Container,
	type Focusable,
	getEditorKeybindings,
	Input,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import type { Theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";

// ============================================================================
// Types
// ============================================================================

/** A single option in a select list */
export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	/** Initial selected state for multi-select */
	selected?: boolean;
}

/** Answer modes for a question page */
export type QuestionMode =
	| { type: "single-select"; options: QuestionOption[] }
	| { type: "multi-select"; options: QuestionOption[] }
	| { type: "input"; placeholder?: string; validate?: (value: string) => string | null }
	| { type: "confirm"; message?: string };

/** A single page/step in the question dialog */
export interface QuestionPage {
	/** Short label for tab bar (e.g., "Scope", "Priority") */
	title: string;
	/** Full question text displayed on the page */
	prompt: string;
	/** Optional description below the prompt */
	description?: string;
	/** The answer mode for this page */
	mode: QuestionMode;
}

/** Configuration for the question dialog */
export interface QuestionDialogConfig {
	/** Dialog title (shown at top) */
	title?: string;
	/** Pages to display */
	pages: QuestionPage[];
	/** Allow navigating back to previous pages (default: true) */
	allowBack?: boolean;
	/** Timeout in milliseconds */
	timeout?: number;
	/** AbortSignal for programmatic dismissal */
	signal?: AbortSignal;
}

/** Answer for a single page */
export type QuestionAnswer =
	| { type: "single-select"; value: string; label: string; index: number }
	| { type: "multi-select"; values: { value: string; label: string }[] }
	| { type: "input"; value: string }
	| { type: "confirm"; value: boolean };

/** Result returned when dialog completes */
export interface QuestionResult {
	answers: (QuestionAnswer | null)[];
	completed: boolean;
}

// ============================================================================
// Component
// ============================================================================

export class QuestionDialogComponent extends Container implements Focusable {
	private config: QuestionDialogConfig;
	private theme: Theme;
	private tui: TUI;
	private onComplete: (result: QuestionResult) => void;

	// State
	private currentPage = 0;
	private answers: (QuestionAnswer | null)[];
	private focusedIndex = 0;
	private inputComponent: Input;
	private validationError: string | null = null;
	private countdown: CountdownTimer | undefined;

	// Multi-select state per page (keyed by page index)
	private multiSelectState: Map<number, boolean[]> = new Map();

	// Inline custom input for the "Other:" row on select pages
	private customInputComponent: Input;
	// Per-page checked state for the custom input row (multi-select only)
	private customChecked: Map<number, boolean> = new Map();

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.inputComponent.focused = value;
		this.customInputComponent.focused = value && this.isCustomRowFocused;
	}

	/** Whether the "Custom..." row is currently focused in a select page */
	private get isCustomRowFocused(): boolean {
		if (this.isSubmitPage) return false;
		const mode = this.page.mode;
		if (mode.type === "single-select") return this.focusedIndex === mode.options.length;
		if (mode.type === "multi-select") return this.focusedIndex === mode.options.length;
		return false;
	}

	constructor(config: QuestionDialogConfig, theme: Theme, tui: TUI, onComplete: (result: QuestionResult) => void) {
		super();
		this.config = config;
		this.theme = theme;
		this.tui = tui;
		this.onComplete = onComplete;
		this.answers = new Array(config.pages.length).fill(null);

		// Initialize multi-select states
		for (let i = 0; i < config.pages.length; i++) {
			const page = config.pages[i];
			if (page.mode.type === "multi-select") {
				this.multiSelectState.set(
					i,
					page.mode.options.map((o) => o.selected ?? false),
				);
			}
		}

		// Input component for text input mode
		this.inputComponent = new Input();
		this.inputComponent.onSubmit = (value) => this.handleInputSubmit(value);
		this.inputComponent.onEscape = () => this.finish(false);

		// Inline custom input for "Custom..." row on select pages
		this.customInputComponent = new Input();
		this.customInputComponent.onSubmit = (value) => this.handleCustomInputSubmit(value);
		this.customInputComponent.onEscape = () => this.finish(false);

		// Countdown timer
		if (config.timeout && config.timeout > 0) {
			this.countdown = new CountdownTimer(
				config.timeout,
				tui,
				() => tui.requestRender(),
				() => this.finish(false),
			);
		}
	}

	private get page(): QuestionPage {
		return this.config.pages[this.currentPage];
	}

	private get isMultiPage(): boolean {
		return this.config.pages.length > 1;
	}

	private get isSubmitPage(): boolean {
		return this.isMultiPage && this.currentPage === this.config.pages.length;
	}

	private get totalPages(): number {
		return this.config.pages.length + (this.isMultiPage ? 1 : 0); // +1 for submit page
	}

	private get allAnswered(): boolean {
		return this.answers.every((a) => a !== null);
	}

	// ── Rendering ──────────────────────────────────────────────────────────

	override render(width: number): string[] {
		const lines: string[] = [];
		const t = this.theme;
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// Top border
		add(t.fg("border", "─".repeat(width)));
		lines.push("");

		// Title + countdown
		if (this.config.title) {
			let titleText = t.fg("accent", t.bold(` ${this.config.title}`));
			if (this.countdown) {
				titleText += t.fg("dim", ` (${this.countdown})`);
			}
			add(titleText);
			lines.push("");
		}

		// Tab bar (multi-page only)
		if (this.isMultiPage) {
			add(this.renderTabBar(width));
			lines.push("");
		}

		// Page content
		if (this.isSubmitPage) {
			this.renderSubmitPage(lines, width);
		} else {
			this.renderQuestionPage(lines, width);
		}

		// Keybinding hints
		lines.push("");
		add(this.renderHints());

		// Bottom border
		lines.push("");
		add(t.fg("border", "─".repeat(width)));

		return lines;
	}

	private renderTabBar(width: number): string {
		const t = this.theme;
		const parts: string[] = [" "];

		for (let i = 0; i < this.config.pages.length; i++) {
			const isActive = i === this.currentPage;
			const isAnswered = this.answers[i] !== null;
			const label = this.config.pages[i].title;

			const dot = isAnswered ? "●" : "○";
			const dotColor = isAnswered ? "success" : "muted";

			if (isActive) {
				parts.push(t.fg("accent", `${dot} ${t.bold(label)}`));
			} else {
				parts.push(t.fg(dotColor, `${dot} ${label}`));
			}
			parts.push("  ");
		}

		// Submit indicator
		if (this.isMultiPage) {
			const isSubmitActive = this.isSubmitPage;
			const canSubmit = this.allAnswered;
			const submitDot = canSubmit ? "●" : "○";
			if (isSubmitActive) {
				parts.push(t.fg("accent", `${submitDot} ${t.bold("Submit")}`));
			} else {
				parts.push(t.fg(canSubmit ? "success" : "dim", `${submitDot} Submit`));
			}
		}

		// Page counter
		const displayPage = Math.min(this.currentPage + 1, this.config.pages.length);
		const counter = t.fg("dim", `  [${displayPage}/${this.config.pages.length}]`);
		parts.push(counter);

		return truncateToWidth(parts.join(""), width);
	}

	private renderQuestionPage(lines: string[], width: number): void {
		const t = this.theme;
		const page = this.page;
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// Prompt
		add(t.fg("text", ` ${page.prompt}`));

		// Description
		if (page.description) {
			add(t.fg("muted", ` ${page.description}`));
		}

		lines.push("");

		const mode = page.mode;

		switch (mode.type) {
			case "single-select":
				this.renderSingleSelect(mode.options, lines, width);
				break;
			case "multi-select":
				this.renderMultiSelect(mode.options, lines, width);
				break;
			case "input":
				this.renderInput(lines, width);
				break;
			case "confirm":
				if (mode.message) {
					add(t.fg("text", ` ${mode.message}`));
					lines.push("");
				}
				this.renderSingleSelect(
					[
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
					lines,
					width,
				);
				break;
		}

		// Validation error
		if (this.validationError) {
			lines.push("");
			add(t.fg("error", ` ${this.validationError}`));
		}
	}

	private renderSingleSelect(options: QuestionOption[], lines: string[], width: number): void {
		const t = this.theme;
		const customIndex = options.length;
		const isConfirmMode = this.page.mode.type === "confirm";

		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			const isFocused = i === this.focusedIndex;
			const displayLabel = opt.label || opt.value;

			const prefix = isFocused ? t.fg("accent", " ▸ ") : "   ";
			const prefixWidth = 3;
			const maxLabelWidth = width - prefixWidth - 2;

			if (isFocused) {
				lines.push(
					truncateToWidth(prefix + t.fg("accent", truncateToWidth(displayLabel, maxLabelWidth, "")), width),
				);
			} else {
				lines.push(truncateToWidth(prefix + truncateToWidth(displayLabel, maxLabelWidth, ""), width));
			}

			if (opt.description) {
				const descMaxWidth = width - 6;
				if (descMaxWidth > 10) {
					lines.push(
						truncateToWidth(`      ${t.fg("muted", truncateToWidth(opt.description, descMaxWidth, ""))}`, width),
					);
				}
			}
		}

		// "Custom..." inline input row (not shown for confirm mode)
		if (!isConfirmMode) {
			const isFocused = this.focusedIndex === customIndex;
			const prefix = isFocused ? t.fg("accent", " ▸ ") : "   ";
			const label = t.fg("dim", "Other: ");
			const inputLines = this.customInputComponent.render(width - 10);
			const inputText = inputLines[0] ?? "";
			lines.push(truncateToWidth(prefix + label + inputText, width));
		}
	}

	private renderMultiSelect(options: QuestionOption[], lines: string[], width: number): void {
		const t = this.theme;
		const checkStates = this.multiSelectState.get(this.currentPage) ?? [];

		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			const isFocused = i === this.focusedIndex;
			const isChecked = checkStates[i] ?? false;
			const displayLabel = opt.label || opt.value;

			const cursor = isFocused ? t.fg("accent", " ▸ ") : "   ";
			const check = isChecked ? t.fg("success", "◉ ") : t.fg("muted", "○ ");
			const prefixWidth = 5;
			const maxLabelWidth = width - prefixWidth - 2;

			if (isFocused) {
				lines.push(
					truncateToWidth(
						cursor + check + t.fg("accent", truncateToWidth(displayLabel, maxLabelWidth, "")),
						width,
					),
				);
			} else {
				lines.push(truncateToWidth(cursor + check + truncateToWidth(displayLabel, maxLabelWidth, ""), width));
			}

			if (opt.description) {
				const descMaxWidth = width - 8;
				if (descMaxWidth > 10) {
					lines.push(
						truncateToWidth(
							`        ${t.fg("muted", truncateToWidth(opt.description, descMaxWidth, ""))}`,
							width,
						),
					);
				}
			}
		}

		// "Other:" inline input row with checkbox
		const isFocused = this.focusedIndex === options.length;
		const isCustomChecked = this.customChecked.get(this.currentPage) ?? false;
		const cursor = isFocused ? t.fg("accent", " ▸ ") : "   ";
		const check = isCustomChecked ? t.fg("success", "◉ ") : t.fg("muted", "○ ");
		const label = t.fg("dim", "Other: ");
		const inputLines = this.customInputComponent.render(width - 12);
		const inputText = inputLines[0] ?? "";
		lines.push(truncateToWidth(cursor + check + label + inputText, width));
	}

	private renderInput(lines: string[], width: number): void {
		const inputLines = this.inputComponent.render(width - 2);
		for (const line of inputLines) {
			lines.push(` ${line}`);
		}
	}

	private renderSubmitPage(lines: string[], width: number): void {
		const t = this.theme;
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		add(t.fg("text", t.bold(" Review & Submit")));
		lines.push("");

		// Summary of answers
		for (let i = 0; i < this.config.pages.length; i++) {
			const page = this.config.pages[i];
			const answer = this.answers[i];

			const label = t.fg("muted", ` ${page.title}`);
			let value: string;

			if (!answer) {
				value = t.fg("warning", "  (unanswered)");
			} else {
				switch (answer.type) {
					case "single-select":
						value = t.fg("text", `  ${answer.label}`);
						break;
					case "multi-select":
						if (answer.values.length === 0) {
							value = t.fg("dim", "  (none selected)");
						} else {
							value = t.fg("text", `  ${answer.values.map((v) => v.label).join(", ")}`);
						}
						break;
					case "input":
						value = t.fg("text", `  ${answer.value}`);
						break;
					case "confirm":
						value = t.fg("text", `  ${answer.value ? "Yes" : "No"}`);
						break;
				}
			}

			add(label);
			add(value);
		}

		lines.push("");

		if (this.allAnswered) {
			add(t.fg("success", " All questions answered. Press enter to submit."));
		} else {
			const missing = this.config.pages
				.filter((_, i) => this.answers[i] === null)
				.map((p) => p.title)
				.join(", ");
			add(t.fg("warning", ` Unanswered: ${missing}`));
		}
	}

	private renderHints(): string {
		const t = this.theme;
		const parts: string[] = [];

		const hint = (key: string, desc: string) => t.fg("dim", key) + t.fg("muted", ` ${desc}`);

		if (this.isSubmitPage) {
			if (this.allAnswered) {
				parts.push(hint("enter", "submit"));
			}
			parts.push(hint("tab", "back"));
			parts.push(hint("esc", "cancel"));
		} else {
			const mode = this.page.mode.type;

			if (mode === "input") {
				parts.push(hint("enter", "submit"));
			} else {
				parts.push(hint("↑↓", "navigate"));
				if (mode === "multi-select") {
					parts.push(hint("space", "toggle"));
					parts.push(hint("enter", "confirm"));
				} else {
					parts.push(hint("enter", "select"));
				}
			}

			if (this.isMultiPage) {
				parts.push(hint("tab/→", "next"));
				if (this.config.allowBack !== false) {
					parts.push(hint("shift+tab/←", "prev"));
				}
			}

			parts.push(hint("esc", "cancel"));
		}

		return ` ${parts.join("  ")}`;
	}

	// ── Input Handling ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		// Cancel
		if (kb.matches(data, "selectCancel")) {
			this.finish(false);
			return;
		}

		// Tab / arrow navigation (multi-page) — always available
		if (this.isMultiPage) {
			if (kb.matches(data, "selectNextTab") || kb.matches(data, "selectNextPage")) {
				this.goToPage((this.currentPage + 1) % this.totalPages);
				return;
			}
			if (
				(kb.matches(data, "selectPrevTab") || kb.matches(data, "selectPrevPage")) &&
				this.config.allowBack !== false
			) {
				this.goToPage((this.currentPage - 1 + this.totalPages) % this.totalPages);
				return;
			}
		}

		// Submit page
		if (this.isSubmitPage) {
			if (kb.matches(data, "selectConfirm") && this.allAnswered) {
				this.finish(true);
			}
			return;
		}

		// Input mode - delegate to Input component
		if (this.page.mode.type === "input") {
			this.inputComponent.handleInput(data);
			this.tui.requestRender();
			return;
		}

		// List navigation (single-select, multi-select, confirm)
		const itemCount = this.getSelectItemCount();

		if (kb.matches(data, "selectUp")) {
			this.setFocusedIndex(this.focusedIndex === 0 ? itemCount - 1 : this.focusedIndex - 1);
			this.tui.requestRender();
			return;
		}

		if (kb.matches(data, "selectDown")) {
			this.setFocusedIndex(this.focusedIndex === itemCount - 1 ? 0 : this.focusedIndex + 1);
			this.tui.requestRender();
			return;
		}

		// When on "Other:" row, Enter submits; other keys go to input component
		if (this.isCustomRowFocused) {
			if (kb.matches(data, "selectConfirm")) {
				this.handleCustomInputSubmit(this.customInputComponent.getValue());
				return;
			}
			// Delegate typing to custom input
			this.customInputComponent.handleInput(data);
			// Auto-toggle custom checkbox based on whether input has content (multi-select)
			if (this.page.mode.type === "multi-select") {
				this.customChecked.set(this.currentPage, this.customInputComponent.getValue().trim().length > 0);
			}
			this.tui.requestRender();
			return;
		}

		// Toggle (multi-select only)
		if (this.page.mode.type === "multi-select" && kb.matches(data, "selectToggle")) {
			const states = this.multiSelectState.get(this.currentPage);
			if (states && this.focusedIndex < states.length) {
				states[this.focusedIndex] = !states[this.focusedIndex];
				this.tui.requestRender();
			}
			return;
		}

		// Confirm/Select
		if (kb.matches(data, "selectConfirm")) {
			this.handleSelect();
			return;
		}
	}

	/** Update focusedIndex and sync custom input focus state */
	private setFocusedIndex(index: number): void {
		this.focusedIndex = index;
		this.customInputComponent.focused = this.isCustomRowFocused;
		// Clear custom input when navigating away from it
		if (!this.isCustomRowFocused) {
			this.customInputComponent.setValue("");
		}
	}

	private handleSelect(): void {
		const mode = this.page.mode;

		switch (mode.type) {
			case "single-select": {
				const opt = mode.options[this.focusedIndex];
				if (opt) {
					this.answers[this.currentPage] = {
						type: "single-select",
						value: opt.value,
						label: opt.label,
						index: this.focusedIndex,
					};
					this.advanceOrFinish();
				}
				break;
			}
			case "multi-select": {
				const states = this.multiSelectState.get(this.currentPage) ?? [];
				const selected = mode.options.filter((_, i) => states[i]).map((o) => ({ value: o.value, label: o.label }));
				// Include custom value if checked
				const customVal = this.customInputComponent.getValue().trim();
				if ((this.customChecked.get(this.currentPage) ?? false) && customVal) {
					selected.push({ value: customVal, label: customVal });
				}
				this.answers[this.currentPage] = { type: "multi-select", values: selected };
				this.customInputComponent.setValue("");
				this.customChecked.set(this.currentPage, false);
				this.advanceOrFinish();
				break;
			}
			case "confirm": {
				const isYes = this.focusedIndex === 0;
				this.answers[this.currentPage] = { type: "confirm", value: isYes };
				this.advanceOrFinish();
				break;
			}
			default:
				break;
		}
	}

	private handleCustomInputSubmit(value: string): void {
		if (!value.trim()) {
			// Empty input — just advance without custom value
			this.customInputComponent.setValue("");
			this.advanceOrFinish();
			return;
		}

		const mode = this.page.mode;
		this.customInputComponent.setValue("");

		if (mode.type === "single-select") {
			this.answers[this.currentPage] = {
				type: "single-select",
				value: value.trim(),
				label: value.trim(),
				index: -1,
			};
			this.advanceOrFinish();
		} else if (mode.type === "multi-select") {
			// For multi-select, add custom value alongside selected options
			const states = this.multiSelectState.get(this.currentPage) ?? [];
			const selected = mode.options.filter((_, i) => states[i]).map((o) => ({ value: o.value, label: o.label }));
			selected.push({ value: value.trim(), label: value.trim() });
			this.answers[this.currentPage] = { type: "multi-select", values: selected };
			this.advanceOrFinish();
		}
	}

	private handleInputSubmit(value: string): void {
		const mode = this.page.mode;
		if (mode.type !== "input") return;

		// Validate
		if (mode.validate) {
			const error = mode.validate(value);
			if (error) {
				this.validationError = error;
				this.tui.requestRender();
				return;
			}
		}

		this.validationError = null;
		this.answers[this.currentPage] = { type: "input", value };
		this.advanceOrFinish();
	}

	private advanceOrFinish(): void {
		if (!this.isMultiPage) {
			// Single page → done immediately
			this.finish(true);
			return;
		}

		// Find next unanswered page, or go to submit
		for (let i = this.currentPage + 1; i < this.config.pages.length; i++) {
			if (this.answers[i] === null) {
				this.goToPage(i);
				return;
			}
		}

		// All remaining are answered → submit page
		this.goToPage(this.config.pages.length);
	}

	private goToPage(pageIndex: number): void {
		this.currentPage = pageIndex;
		this.focusedIndex = 0;
		this.validationError = null;
		this.customInputComponent.setValue("");
		this.customInputComponent.focused = false;

		// Restore input value if going back to an input page
		if (!this.isSubmitPage && this.page.mode.type === "input") {
			const existing = this.answers[this.currentPage];
			if (existing?.type === "input") {
				this.inputComponent.setValue(existing.value);
			} else {
				this.inputComponent.setValue("");
			}
		}

		this.tui.requestRender();
	}

	/** Total navigable items in current select list (options + "Custom..." for select modes) */
	private getSelectItemCount(): number {
		if (this.isSubmitPage) return 0;
		const mode = this.page.mode;
		switch (mode.type) {
			case "single-select":
				return mode.options.length + 1; // +1 for "Custom..."
			case "multi-select":
				return mode.options.length + 1; // +1 for "Custom..."
			case "confirm":
				return 2; // Yes/No — no custom option
			default:
				return 0;
		}
	}

	private finish(completed: boolean): void {
		this.countdown?.dispose();
		this.onComplete({ answers: this.answers, completed });
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
