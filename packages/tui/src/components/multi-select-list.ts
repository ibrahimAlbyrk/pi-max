import { getEditorKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

export interface MultiSelectItem {
	value: string;
	label: string;
	description?: string;
	selected?: boolean;
}

export interface MultiSelectListTheme {
	/** Style for the cursor indicator on the focused item */
	cursor: (text: string) => string;
	/** Style for checked icon ◉ */
	checked: (text: string) => string;
	/** Style for unchecked icon ○ */
	unchecked: (text: string) => string;
	/** Style for the label of the focused item */
	focusedText: (text: string) => string;
	/** Style for description text */
	description: (text: string) => string;
	/** Style for scroll info */
	scrollInfo: (text: string) => string;
	/** Style for empty list message */
	noItems: (text: string) => string;
}

export class MultiSelectList implements Component {
	private items: MultiSelectItem[] = [];
	private focusedIndex: number = 0;
	private maxVisible: number = 8;
	private theme: MultiSelectListTheme;

	public onConfirm?: (selectedItems: MultiSelectItem[]) => void;
	public onCancel?: () => void;
	public onChange?: (item: MultiSelectItem, selected: boolean) => void;

	constructor(items: MultiSelectItem[], maxVisible: number, theme: MultiSelectListTheme) {
		this.items = items.map((item) => ({ ...item, selected: item.selected ?? false }));
		this.maxVisible = maxVisible;
		this.theme = theme;
	}

	/** Get all currently selected items */
	getSelectedItems(): MultiSelectItem[] {
		return this.items.filter((item) => item.selected);
	}

	/** Get all items with their current selection state */
	getItems(): readonly MultiSelectItem[] {
		return this.items;
	}

	/** Set items (replaces all) */
	setItems(items: MultiSelectItem[]): void {
		this.items = items.map((item) => ({ ...item, selected: item.selected ?? false }));
		this.focusedIndex = Math.min(this.focusedIndex, Math.max(0, this.items.length - 1));
	}

	invalidate(): void {
		// No cached state
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.items.length === 0) {
			lines.push(this.theme.noItems("  No items available"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.focusedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;

			const isFocused = i === this.focusedIndex;
			const isChecked = item.selected;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;

			// Build: "▸ ◉ Label" or "  ○ Label"
			const cursorPrefix = isFocused ? this.theme.cursor("▸ ") : "  ";
			const checkIcon = isChecked ? this.theme.checked("◉ ") : this.theme.unchecked("○ ");
			const displayValue = item.label || item.value;

			// Prefix widths: cursor(2) + check(2) = 4
			const prefixWidth = 4;

			let line: string;
			if (isFocused) {
				if (descriptionSingleLine && width > 40) {
					const maxValueWidth = Math.min(30, width - prefixWidth - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2;

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						line =
							cursorPrefix +
							checkIcon +
							this.theme.focusedText(truncatedValue) +
							this.theme.description(spacing + truncatedDesc);
					} else {
						const maxWidth = width - prefixWidth - 2;
						line = cursorPrefix + checkIcon + this.theme.focusedText(truncateToWidth(displayValue, maxWidth, ""));
					}
				} else {
					const maxWidth = width - prefixWidth - 2;
					line = cursorPrefix + checkIcon + this.theme.focusedText(truncateToWidth(displayValue, maxWidth, ""));
				}
			} else {
				if (descriptionSingleLine && width > 40) {
					const maxValueWidth = Math.min(30, width - prefixWidth - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2;

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						line = cursorPrefix + checkIcon + truncatedValue + this.theme.description(spacing + truncatedDesc);
					} else {
						const maxWidth = width - prefixWidth - 2;
						line = cursorPrefix + checkIcon + truncateToWidth(displayValue, maxWidth, "");
					}
				} else {
					const maxWidth = width - prefixWidth - 2;
					line = cursorPrefix + checkIcon + truncateToWidth(displayValue, maxWidth, "");
				}
			}

			lines.push(line);
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.items.length) {
			const scrollText = `  (${this.focusedIndex + 1}/${this.items.length})`;
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		// Up - wrap
		if (kb.matches(keyData, "selectUp")) {
			this.focusedIndex = this.focusedIndex === 0 ? this.items.length - 1 : this.focusedIndex - 1;
		}
		// Down - wrap
		else if (kb.matches(keyData, "selectDown")) {
			this.focusedIndex = this.focusedIndex === this.items.length - 1 ? 0 : this.focusedIndex + 1;
		}
		// Space - toggle
		else if (kb.matches(keyData, "selectToggle")) {
			const item = this.items[this.focusedIndex];
			if (item) {
				item.selected = !item.selected;
				this.onChange?.(item, item.selected);
			}
		}
		// Enter - confirm
		else if (kb.matches(keyData, "selectConfirm")) {
			this.onConfirm?.(this.getSelectedItems());
		}
		// Escape
		else if (kb.matches(keyData, "selectCancel")) {
			this.onCancel?.();
		}
	}
}
