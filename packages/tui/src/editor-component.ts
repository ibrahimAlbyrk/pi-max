import type { AutocompleteProvider } from "./autocomplete.js";
import type { Component } from "./tui.js";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Scroll boundary support (optional)
	// =========================================================================

	/**
	 * Called when arrow up/down is pressed at editor boundary (empty or first/last visual line)
	 * and not currently browsing history.
	 * Direction: -1 = up, 1 = down.
	 * Return true to consume the event (e.g., scrolled the parent region).
	 */
	onBoundaryScroll?: (direction: -1 | 1) => boolean;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	/** Set a dim placeholder hint shown after a slash command when no arguments are typed */
	setArgumentHint?(hint: string | null): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;

	/** Set a badge on the bottom border (right-aligned). Pass undefined to remove. */
	setBottomBorderBadge?(key: string, styledText: string | undefined): void;

	/** Set a badge on the top border (right-aligned). Pass undefined to remove. */
	setTopBorderBadge?(key: string, styledText: string | undefined): void;
}
