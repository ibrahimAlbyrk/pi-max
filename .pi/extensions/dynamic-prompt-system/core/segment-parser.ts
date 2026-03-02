/**
 * DPS Segment Parser
 *
 * Custom lightweight YAML frontmatter parser.
 * No external dependencies (no gray-matter, no js-yaml).
 *
 * Supports: string, number, boolean, list (- item), 1-level nested object.
 * Frontmatter delimited by --- lines.
 */

import type { ParseResult, Condition } from "./types.js";

// ============================================================================
// Frontmatter Extraction
// ============================================================================

/**
 * Extract frontmatter and content from raw .md file text.
 * Returns null if no valid frontmatter found.
 */
export function parseSegmentFile(raw: string): ParseResult | null {
	const trimmed = raw.trimStart();

	// Must start with ---
	if (!trimmed.startsWith("---")) return null;

	// Find closing ---
	const endIndex = trimmed.indexOf("\n---", 3);
	if (endIndex === -1) return null;

	const yamlBlock = trimmed.substring(3, endIndex).trim();
	const content = trimmed.substring(endIndex + 4).trim();

	try {
		const metadata = parseSimpleYaml(yamlBlock);
		return { metadata, content };
	} catch {
		return null;
	}
}

// ============================================================================
// Simple YAML Parser
// ============================================================================

/**
 * Parse simple YAML subset.
 * Supports:
 *   key: value          (string, number, boolean)
 *   key:                (start of list or nested object)
 *     - item            (list items)
 *     nested_key: value (nested object — 1 level only)
 *   key: [a, b, c]      (inline list)
 */
export function parseSimpleYaml(yaml: string): Record<string, any> {
	const result: Record<string, any> = {};
	const lines = yaml.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Skip empty lines and comments
		if (line.trim() === "" || line.trim().startsWith("#")) {
			i++;
			continue;
		}

		// Top-level key: value
		const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
		if (!keyMatch) {
			i++;
			continue;
		}

		const key = keyMatch[1];
		const valueStr = keyMatch[2].trim();

		if (valueStr === "") {
			// Empty value → next lines are list items or nested object
			const { value, nextIndex } = parseBlock(lines, i + 1);
			result[key] = value;
			i = nextIndex;
		} else if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
			// Inline list: [a, b, c]
			result[key] = parseInlineList(valueStr);
			i++;
		} else {
			// Scalar value
			result[key] = parseScalar(valueStr);
			i++;
		}
	}

	return result;
}

// ============================================================================
// Block Parser (list or nested object)
// ============================================================================

interface BlockResult {
	value: any[] | Record<string, any>;
	nextIndex: number;
}

function parseBlock(lines: string[], startIndex: number): BlockResult {
	if (startIndex >= lines.length) {
		return { value: [], nextIndex: startIndex };
	}

	// Peek at first non-empty indented line to determine type
	let peekIndex = startIndex;
	while (peekIndex < lines.length && lines[peekIndex].trim() === "") {
		peekIndex++;
	}

	if (peekIndex >= lines.length || getIndent(lines[peekIndex]) === 0) {
		return { value: [], nextIndex: startIndex };
	}

	const firstLine = lines[peekIndex].trim();

	if (firstLine.startsWith("- ")) {
		return parseList(lines, startIndex);
	} else {
		return parseNestedObject(lines, startIndex);
	}
}

// ============================================================================
// List Parser
// ============================================================================

function parseList(lines: string[], startIndex: number): BlockResult {
	const items: any[] = [];
	let i = startIndex;

	while (i < lines.length) {
		const line = lines[i];

		// Skip empty lines
		if (line.trim() === "") {
			i++;
			continue;
		}

		// Not indented = back to top level
		if (getIndent(line) === 0) break;

		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) {
			const itemContent = trimmed.substring(2).trim();

			// Check if list item is a simple value or a key: value pair
			const kvMatch = itemContent.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
			if (kvMatch) {
				// List item is an object: - key: value
				// Could be start of a multi-key object or single key
				const obj: Record<string, any> = {};
				const key = kvMatch[1];
				const val = kvMatch[2].trim();

				if (val === "") {
					// Nested block under list item
					const { value, nextIndex } = parseBlock(lines, i + 1);
					obj[key] = value;
					i = nextIndex;
				} else {
					obj[key] = parseScalar(val);
					i++;
				}

				// Continue reading indented key:value pairs at same or deeper level
				while (i < lines.length) {
					const nextLine = lines[i];
					if (nextLine.trim() === "") { i++; continue; }
					if (getIndent(nextLine) <= getIndent(line)) break;

					const innerKv = nextLine.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
					if (innerKv) {
						const innerVal = innerKv[2].trim();
						if (innerVal === "") {
							const { value, nextIndex } = parseBlock(lines, i + 1);
							obj[innerKv[1]] = value;
							i = nextIndex;
						} else {
							obj[innerKv[1]] = parseScalar(innerVal);
							i++;
						}
					} else {
						break;
					}
				}

				items.push(obj);
			} else {
				// Simple scalar list item
				items.push(parseScalar(itemContent));
				i++;
			}
		} else {
			break;
		}
	}

	return { value: items, nextIndex: i };
}

// ============================================================================
// Nested Object Parser (1 level)
// ============================================================================

function parseNestedObject(lines: string[], startIndex: number): BlockResult {
	const obj: Record<string, any> = {};
	let i = startIndex;

	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === "") {
			i++;
			continue;
		}

		if (getIndent(line) === 0) break;

		const kvMatch = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
		if (kvMatch) {
			const val = kvMatch[2].trim();
			if (val === "") {
				const { value, nextIndex } = parseBlock(lines, i + 1);
				obj[kvMatch[1]] = value;
				i = nextIndex;
			} else {
				obj[kvMatch[1]] = parseScalar(val);
				i++;
			}
		} else {
			break;
		}
	}

	return { value: obj, nextIndex: i };
}

// ============================================================================
// Scalar Parser
// ============================================================================

function parseScalar(value: string): string | number | boolean {
	// Remove surrounding quotes
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	// Boolean
	if (value === "true") return true;
	if (value === "false") return false;

	// Number (integer or float)
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}

	return value;
}

// ============================================================================
// Inline List Parser
// ============================================================================

function parseInlineList(value: string): any[] {
	// [a, b, c] → ["a", "b", "c"]
	const inner = value.slice(1, -1).trim();
	if (inner === "") return [];

	return inner.split(",").map((item) => parseScalar(item.trim()));
}

// ============================================================================
// Helpers
// ============================================================================

function getIndent(line: string): number {
	const match = line.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

// ============================================================================
// Condition Parser (YAML metadata → Condition type)
// ============================================================================

/**
 * Convert raw YAML conditions array to typed Condition objects.
 *
 * Input formats:
 *   - tool_active: task              → ToolActiveCondition
 *   - file_exists: .git/HEAD         → FileExistsCondition
 *   - dir_exists: .pi/tasks          → DirExistsCondition
 *   - token_usage_above: 75          → TokenUsageAboveCondition
 *   - token_usage_below: 30          → TokenUsageBelowCondition
 *   - turn_count_above: 15           → TurnCountAboveCondition
 *   - turn_count_below: 3            → TurnCountBelowCondition
 *   - model_supports: reasoning      → ModelSupportsCondition
 *   - turns_since_tool_use:
 *       tool: task
 *       min: 5                       → TurnsSinceToolUseCondition
 *   - all: [...]                     → AllCondition
 *   - any: [...]                     → AnyCondition
 *   - not: {...}                     → NotCondition
 */
export function parseConditions(raw: any[]): Condition[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(parseOneCondition).filter((c): c is Condition => c !== null);
}

function parseOneCondition(raw: any): Condition | null {
	if (typeof raw === "string") {
		// "tool_active: task" as a string? Shouldn't happen in our YAML but handle it
		return null;
	}

	if (typeof raw !== "object" || raw === null) return null;

	// Simple key: value conditions
	if ("tool_active" in raw) {
		return { type: "tool_active", tool: String(raw.tool_active) };
	}
	if ("tool_inactive" in raw) {
		return { type: "tool_inactive", tool: String(raw.tool_inactive) };
	}
	if ("file_exists" in raw) {
		return { type: "file_exists", path: String(raw.file_exists) };
	}
	if ("dir_exists" in raw) {
		return { type: "dir_exists", path: String(raw.dir_exists) };
	}
	if ("token_usage_above" in raw) {
		return { type: "token_usage_above", percent: Number(raw.token_usage_above) };
	}
	if ("token_usage_below" in raw) {
		return { type: "token_usage_below", percent: Number(raw.token_usage_below) };
	}
	if ("turn_count_above" in raw) {
		return { type: "turn_count_above", count: Number(raw.turn_count_above) };
	}
	if ("turn_count_below" in raw) {
		return { type: "turn_count_below", count: Number(raw.turn_count_below) };
	}
	if ("model_supports" in raw) {
		return { type: "model_supports", capability: String(raw.model_supports) };
	}

	// Complex conditions
	if ("turns_since_tool_use" in raw) {
		const inner = raw.turns_since_tool_use;
		if (typeof inner === "object" && inner !== null) {
			return {
				type: "turns_since_tool_use",
				tool: String(inner.tool),
				min: Number(inner.min),
			};
		}
		return null;
	}

	// Logical operators
	if ("all" in raw) {
		const inner = Array.isArray(raw.all) ? raw.all : [];
		return { type: "all", conditions: parseConditions(inner) };
	}
	if ("any" in raw) {
		const inner = Array.isArray(raw.any) ? raw.any : [];
		return { type: "any", conditions: parseConditions(inner) };
	}
	if ("not" in raw) {
		const inner = parseOneCondition(raw.not);
		if (inner) return { type: "not", condition: inner };
		return null;
	}

	return null;
}
