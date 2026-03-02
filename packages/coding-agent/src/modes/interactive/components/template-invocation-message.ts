import { Box, Markdown, type MarkdownTheme, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * Component that renders a template invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Shows original command when collapsed, full template content when expanded.
 */
export class TemplateInvocationMessageComponent extends Box {
	private expanded = false;
	private originalCommand: string;
	private expandedContent: string;
	private markdownTheme: MarkdownTheme;

	constructor(originalCommand: string, expandedContent: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.originalCommand = originalCommand;
		this.expandedContent = expandedContent;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		if (this.expanded) {
			// Expanded: label + full template content
			const label = theme.fg("customMessageLabel", `\x1b[1m[template]\x1b[22m`);
			this.addChild(new Text(label, 0, 0));
			this.addChild(
				new Markdown(this.expandedContent, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [template] original command (hint to expand)
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[template]\x1b[22m `) +
				theme.fg("customMessageText", this.originalCommand) +
				theme.fg("dim", ` (${editorKey("expandTools")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
