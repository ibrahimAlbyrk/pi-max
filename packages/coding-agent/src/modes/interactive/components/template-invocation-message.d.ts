import { Box, type MarkdownTheme } from "@mariozechner/pi-tui";
/**
 * Component that renders a template invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Shows original command when collapsed, full template content when expanded.
 */
export declare class TemplateInvocationMessageComponent extends Box {
	private expanded;
	private originalCommand;
	private expandedContent;
	private markdownTheme;
	constructor(originalCommand: string, expandedContent: string, markdownTheme?: MarkdownTheme);
	setExpanded(expanded: boolean): void;
	invalidate(): void;
	private updateDisplay;
}
//# sourceMappingURL=template-invocation-message.d.ts.map
