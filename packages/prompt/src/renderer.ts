import { TemplateRenderError } from "./errors.js";
import type { RendererContext } from "./types.js";

// ============================================================================
// Tokenizer
// ============================================================================

enum TokenType {
	Text = 0,
	Variable = 1, // {{VAR}} or {{item.prop}}
	If = 2, // {{#if COND}}
	ElseIf = 3, // {{else if COND}}
	Else = 4, // {{else}}
	EndIf = 5, // {{/if}}
	Unless = 6, // {{#unless VAR}}
	EndUnless = 7, // {{/unless}}
	Each = 8, // {{#each ARR as item}}
	EndEach = 9, // {{/each}}
	Partial = 10, // {{> name}}
}

interface Token {
	type: TokenType;
	value: string; // raw inner content between {{ and }}
	raw: string; // original text including {{ }}
}

/**
 * Tokenize template string into a flat list of tokens.
 * Handles {{ ... }} blocks and plain text segments.
 */
function tokenize(template: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;

	while (pos < template.length) {
		const start = template.indexOf("{{", pos);
		if (start === -1) {
			// Rest is plain text
			tokens.push({ type: TokenType.Text, value: template.slice(pos), raw: template.slice(pos) });
			break;
		}

		// Text before the tag
		if (start > pos) {
			const text = template.slice(pos, start);
			tokens.push({ type: TokenType.Text, value: text, raw: text });
		}

		const end = template.indexOf("}}", start);
		if (end === -1) {
			// Unclosed {{ - treat rest as text
			const text = template.slice(start);
			tokens.push({ type: TokenType.Text, value: text, raw: text });
			break;
		}

		const raw = template.slice(start, end + 2);
		const inner = template.slice(start + 2, end).trim();

		tokens.push(classifyToken(inner, raw));
		pos = end + 2;
	}

	return tokens;
}

/**
 * Classify a tag's inner content into the correct token type.
 */
function classifyToken(inner: string, raw: string): Token {
	if (inner.startsWith("#if ")) {
		return { type: TokenType.If, value: inner.slice(4).trim(), raw };
	}
	if (inner.startsWith("#unless ")) {
		return { type: TokenType.Unless, value: inner.slice(8).trim(), raw };
	}
	if (inner.startsWith("#each ")) {
		return { type: TokenType.Each, value: inner.slice(6).trim(), raw };
	}
	if (inner === "/if") {
		return { type: TokenType.EndIf, value: "", raw };
	}
	if (inner === "/unless") {
		return { type: TokenType.EndUnless, value: "", raw };
	}
	if (inner === "/each") {
		return { type: TokenType.EndEach, value: "", raw };
	}
	if (inner.startsWith("else if ")) {
		return { type: TokenType.ElseIf, value: inner.slice(8).trim(), raw };
	}
	if (inner === "else") {
		return { type: TokenType.Else, value: "", raw };
	}
	if (inner.startsWith("> ")) {
		return { type: TokenType.Partial, value: inner.slice(2).trim(), raw };
	}
	return { type: TokenType.Variable, value: inner, raw };
}

// ============================================================================
// AST Nodes
// ============================================================================

interface TextNode {
	kind: "text";
	value: string;
}

interface VariableNode {
	kind: "variable";
	path: string[]; // ["VAR"] or ["item", "prop"]
}

interface PartialNode {
	kind: "partial";
	name: string;
}

interface ConditionBranch {
	condition: Condition | null; // null = else branch
	body: AstNode[];
}

interface IfNode {
	kind: "if";
	branches: ConditionBranch[];
}

interface UnlessNode {
	kind: "unless";
	variable: string;
	body: AstNode[];
}

interface EachNode {
	kind: "each";
	arrayPath: string[]; // path to the array variable
	itemName: string; // loop variable name
	body: AstNode[];
}

type AstNode = TextNode | VariableNode | PartialNode | IfNode | UnlessNode | EachNode;

// ============================================================================
// Condition parsing
// ============================================================================

interface Condition {
	variable: string;
	operator: "truthy" | "==" | "!=";
	value?: string;
}

/**
 * Parse a condition expression like "VAR", "VAR == \"val\"", "VAR != \"val\""
 */
function parseCondition(expr: string): Condition {
	// Check for == operator
	const eqIdx = expr.indexOf("==");
	if (eqIdx !== -1 && expr[eqIdx - 1] !== "!") {
		const variable = expr.slice(0, eqIdx).trim();
		const value = stripQuotes(expr.slice(eqIdx + 2).trim());
		return { variable, operator: "==", value };
	}

	// Check for != operator
	const neqIdx = expr.indexOf("!=");
	if (neqIdx !== -1) {
		const variable = expr.slice(0, neqIdx).trim();
		const value = stripQuotes(expr.slice(neqIdx + 2).trim());
		return { variable, operator: "!=", value };
	}

	// Simple truthy check
	return { variable: expr.trim(), operator: "truthy" };
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

// ============================================================================
// Parser: tokens -> AST
// ============================================================================

interface ParserState {
	tokens: Token[];
	pos: number;
}

/**
 * Parse token stream into AST nodes.
 * stopAt defines which token types cause this level to stop (for nested blocks).
 */
function parseNodes(state: ParserState, stopAt?: Set<TokenType>): AstNode[] {
	const nodes: AstNode[] = [];

	while (state.pos < state.tokens.length) {
		const token = state.tokens[state.pos];

		// Check if we should stop at this token (for block-level parsing)
		if (stopAt?.has(token.type)) {
			break;
		}

		state.pos++;

		switch (token.type) {
			case TokenType.Text:
				nodes.push({ kind: "text", value: token.value });
				break;

			case TokenType.Variable:
				nodes.push({ kind: "variable", path: token.value.split(".") });
				break;

			case TokenType.Partial:
				nodes.push({ kind: "partial", name: token.value });
				break;

			case TokenType.If:
				nodes.push(parseIfBlock(state, token.value));
				break;

			case TokenType.Unless:
				nodes.push(parseUnlessBlock(state, token.value));
				break;

			case TokenType.Each:
				nodes.push(parseEachBlock(state, token.value));
				break;

			default:
				// Unexpected token - treat as text
				nodes.push({ kind: "text", value: token.raw });
				break;
		}
	}

	return nodes;
}

function parseIfBlock(state: ParserState, condExpr: string): IfNode {
	const branches: ConditionBranch[] = [];

	// First branch
	const stopTokens = new Set([TokenType.ElseIf, TokenType.Else, TokenType.EndIf]);
	const body = parseNodes(state, stopTokens);
	branches.push({ condition: parseCondition(condExpr), body });

	// Process else if / else / endif
	while (state.pos < state.tokens.length) {
		const token = state.tokens[state.pos];
		state.pos++;

		if (token.type === TokenType.EndIf) {
			break;
		}

		if (token.type === TokenType.ElseIf) {
			const elseIfBody = parseNodes(state, stopTokens);
			branches.push({ condition: parseCondition(token.value), body: elseIfBody });
		} else if (token.type === TokenType.Else) {
			const elseStopTokens = new Set([TokenType.EndIf]);
			const elseBody = parseNodes(state, elseStopTokens);
			branches.push({ condition: null, body: elseBody });
			// Consume the endif
			if (state.pos < state.tokens.length && state.tokens[state.pos].type === TokenType.EndIf) {
				state.pos++;
			}
			break;
		}
	}

	return { kind: "if", branches };
}

function parseUnlessBlock(state: ParserState, variable: string): UnlessNode {
	const stopTokens = new Set([TokenType.EndUnless]);
	const body = parseNodes(state, stopTokens);

	// Consume {{/unless}}
	if (state.pos < state.tokens.length && state.tokens[state.pos].type === TokenType.EndUnless) {
		state.pos++;
	}

	return { kind: "unless", variable: variable.trim(), body };
}

function parseEachBlock(state: ParserState, expr: string): EachNode {
	// Parse "ARRAY as item" or "ARRAY.path as item"
	const asIdx = expr.indexOf(" as ");
	let arrayExpr: string;
	let itemName: string;

	if (asIdx !== -1) {
		arrayExpr = expr.slice(0, asIdx).trim();
		itemName = expr.slice(asIdx + 4).trim();
	} else {
		arrayExpr = expr.trim();
		itemName = "item";
	}

	const stopTokens = new Set([TokenType.EndEach]);
	const body = parseNodes(state, stopTokens);

	// Consume {{/each}}
	if (state.pos < state.tokens.length && state.tokens[state.pos].type === TokenType.EndEach) {
		state.pos++;
	}

	return { kind: "each", arrayPath: arrayExpr.split("."), itemName, body };
}

// ============================================================================
// Evaluator: AST + context -> string
// ============================================================================

/**
 * Resolve a dotted path against the variables context.
 * e.g., ["item", "name"] -> context.variables.item.name
 */
function resolvePath(path: string[], variables: Record<string, unknown>): unknown {
	let current: unknown = variables;
	for (const segment of path) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Evaluate a condition against the current variables.
 */
function evaluateCondition(condition: Condition, variables: Record<string, unknown>): boolean {
	const path = condition.variable.split(".");
	const val = resolvePath(path, variables);

	switch (condition.operator) {
		case "truthy":
			return isTruthy(val);
		case "==":
			return String(val ?? "") === condition.value;
		case "!=":
			return String(val ?? "") !== condition.value;
	}
}

function isTruthy(val: unknown): boolean {
	if (val === undefined || val === null || val === false || val === 0 || val === "") return false;
	if (Array.isArray(val) && val.length === 0) return false;
	return true;
}

/**
 * Evaluate AST nodes into a rendered string.
 */
function evaluateNodes(nodes: AstNode[], ctx: RendererContext): string {
	const parts: string[] = [];

	for (const node of nodes) {
		switch (node.kind) {
			case "text":
				parts.push(node.value);
				break;

			case "variable": {
				const val = resolvePath(node.path, ctx.variables);
				if (val !== undefined && val !== null) {
					parts.push(String(val));
				}
				break;
			}

			case "partial": {
				const content = ctx.resolvePartial(node.name);
				parts.push(content);
				break;
			}

			case "if": {
				for (const branch of node.branches) {
					if (branch.condition === null || evaluateCondition(branch.condition, ctx.variables)) {
						parts.push(evaluateNodes(branch.body, ctx));
						break;
					}
				}
				break;
			}

			case "unless": {
				const val = resolvePath([node.variable], ctx.variables);
				if (!isTruthy(val)) {
					parts.push(evaluateNodes(node.body, ctx));
				}
				break;
			}

			case "each": {
				const arr = resolvePath(node.arrayPath, ctx.variables);
				if (Array.isArray(arr)) {
					for (const item of arr) {
						const loopVars = { ...ctx.variables, [node.itemName]: item };
						const loopCtx: RendererContext = { ...ctx, variables: loopVars };
						parts.push(evaluateNodes(node.body, loopCtx));
					}
				}
				break;
			}
		}
	}

	return parts.join("");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a template string with the given context.
 * Parses template into AST, then evaluates it.
 */
export function renderTemplate(template: string, ctx: RendererContext, promptName?: string): string {
	try {
		const tokens = tokenize(template);
		const state: ParserState = { tokens, pos: 0 };
		const ast = parseNodes(state);
		return evaluateNodes(ast, ctx);
	} catch (err) {
		if (err instanceof TemplateRenderError) throw err;
		throw new TemplateRenderError((err as Error).message, promptName ?? "<unknown>");
	}
}
