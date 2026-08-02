/** Deterministically format captured Python source for terminal display. */

interface PythonDisplayToken {
	kind: "comment" | "name" | "number" | "operator" | "punctuation" | "string";
	value: string;
}

interface PythonDisplayStatement {
	blankBefore?: boolean;
	indent: number;
	tokens: PythonDisplayToken[];
}

const PYTHON_STRING_PREFIX = /^(?:r|u|b|f|br|rb|fr|rf)$/i;
const PYTHON_COMPOUND_KEYWORDS = new Set([
	"async",
	"class",
	"def",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"if",
	"match",
	"try",
	"while",
	"with",
]);
const PYTHON_WORD_BEFORE_BRACKET = new Set([
	"and",
	"assert",
	"await",
	"del",
	"elif",
	"else",
	"for",
	"if",
	"in",
	"is",
	"lambda",
	"not",
	"or",
	"raise",
	"return",
	"while",
	"yield",
]);
const PYTHON_MULTI_OPERATORS = [
	"**=", "//=", "<<=", ">>=", "...", ":=", "==", "!=", "<=", ">=", "->",
	"+=", "-=", "*=", "/=", "%=", "@=", "&=", "|=", "^=", "//", "**", "<<", ">>",
];


// ========================================
// Tokenization

/** Return the end offset of a Python string literal.
 *
 * Example:
 * >>> PythonStringEnd("'a;b' + value", 0)
 * 5
 */
function PythonStringEnd(code: string, start: number): number {
	const quoteStart = code[start] === "'" || code[start] === '"'
		? start
		: start + (code.slice(start).match(/^[A-Za-z]+/)?.[0].length ?? 0);
	const quote = code[quoteStart];
	if (quote !== "'" && quote !== '"') {
		return start + 1;
	}
	const triple = code.slice(quoteStart, quoteStart + 3) === quote.repeat(3);
	let index = quoteStart + (triple ? 3 : 1);

	// Scan escapes and the matching single or triple delimiter.
	while (index < code.length) {
		if (code[index] === "\\") {
			index += 2;
			continue;
		}
		if (triple && code.slice(index, index + 3) === quote.repeat(3)) {
			return index + 3;
		}
		if (!triple && code[index] === quote) {
			return index + 1;
		}
		index++;
	}
	return code.length;
}


/** Locate a one-line compound suite body outside nested delimiters.
 *
 * Example:
 * >>> PythonInlineSuiteColon([{kind: "name", value: "if"}, {kind: "name", value: "ok"}, {kind: "punctuation", value: ":"}, {kind: "name", value: "run"}])
 * 2
 */
function PythonInlineSuiteColon(tokens: PythonDisplayToken[]): number {
	if (!PYTHON_COMPOUND_KEYWORDS.has(tokens[0]?.value ?? "")) {
		return -1;
	}
	let depth = 0;
	for (let index = 0; index < tokens.length - 1; index++) {
		const value = tokens[index]!.value;
		if (["(", "[", "{"].includes(value)) {
			depth++;
		} else if ([")", "]", "}"].includes(value)) {
			depth--;
		} else if (value === ":" && depth === 0) {
			return index;
		}
	}
	return -1;
}


/** Expand one-line compound suites into display-only header and body statements.
 *
 * Example:
 * >>> PythonInlineSuites([{indent: 0, tokens: [{kind: "name", value: "if"}]}]).length
 * 1
 */
function PythonInlineSuites(statements: PythonDisplayStatement[]): PythonDisplayStatement[] {
	const expanded: PythonDisplayStatement[] = [];
	for (const statement of statements) {
		const colon = PythonInlineSuiteColon(statement.tokens);
		if (colon < 0) {
			expanded.push(statement);
			continue;
		}
		expanded.push({ ...statement, tokens: statement.tokens.slice(0, colon + 1) });
		expanded.push({ indent: statement.indent + 1, tokens: statement.tokens.slice(colon + 1) });
	}
	return expanded;
}


/** Tokenize Python while retaining literal and comment text verbatim.
 *
 * Example:
 * >>> PythonDisplayTokenize("x='a;b'; print(x)").length
 * 2
 */
function PythonDisplayTokenize(code: string): PythonDisplayStatement[] {
	const statements: PythonDisplayStatement[] = [];
	let tokens: PythonDisplayToken[] = [];
	let indentation = 0;
	let atLineStart = true;
	let bracketDepth = 0;
	let blankBefore = false;

	// Capture one source gap and reset line-local scanner state.
	const finishStatement = (physicalLine = false) => {
		if (tokens.length > 0) {
			statements.push({ blankBefore, indent: indentation, tokens });
			blankBefore = false;
		} else if (physicalLine && statements.length > 0) {
			blankBefore = true;
		}
		tokens = [];
		indentation = 0;
		atLineStart = true;
	};

	// Normalize physical line boundaries and leading indentation.
	for (let index = 0; index < code.length;) {
		const character = code[index]!;
		if (character === "\r") {
			index++;
			continue;
		}
		if (character === "\n") {
			finishStatement(true);
			index++;
			continue;
		}

		// Count indentation and discard non-semantic horizontal whitespace.
		if (/\s/.test(character)) {
			if (atLineStart) {
				indentation += character === "\t" ? 4 : 1;
			}
			index++;
			continue;
		}
		atLineStart = false;

		// Preserve comments and quoted literals as opaque tokens.
		if (character === "#") {
			const end = code.indexOf("\n", index);
			tokens.push({ kind: "comment", value: code.slice(index, end < 0 ? code.length : end) });
			index = end < 0 ? code.length : end;
			continue;
		}
		if (character === "'" || character === '"') {
			const end = PythonStringEnd(code, index);
			tokens.push({ kind: "string", value: code.slice(index, end) });
			index = end;
			continue;
		}

		// Recognize names, including prefixes attached to string literals.
		if (/[A-Za-z_]/.test(character)) {
			const match = code.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? character;
			const quote = code[index + match.length];
			if (PYTHON_STRING_PREFIX.test(match) && (quote === "'" || quote === '"')) {
				const end = PythonStringEnd(code, index);
				tokens.push({ kind: "string", value: code.slice(index, end) });
				index = end;
				continue;
			}
			tokens.push({ kind: "name", value: match });
			index += match.length;
			continue;
		}

		// Keep numeric spellings while separating them from operators.
		if (/\d/.test(character)) {
			const number = code.slice(index).match(/^(?:0[xob][0-9a-f_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?j?)/i)?.[0] ?? character;
			tokens.push({ kind: "number", value: number });
			index += number.length;
			continue;
		}


		// Track delimiters so only executable top-level semicolons become lines.
		const multi = PYTHON_MULTI_OPERATORS.find((operator) => code.startsWith(operator, index));
		if (multi) {
			tokens.push({ kind: multi === "..." ? "punctuation" : "operator", value: multi });
			index += multi.length;
			continue;
		}

		// Maintain nesting depth for safe statement boundaries.
		if ("([{".includes(character)) {
			bracketDepth++;
			tokens.push({ kind: "punctuation", value: character });
			index++;
			continue;
		}
		if (")]}".includes(character)) {
			bracketDepth = Math.max(0, bracketDepth - 1);
			tokens.push({ kind: "punctuation", value: character });
			index++;
			continue;
		}

		// Finish compact simple statements without touching semicolons in literals.
		if (character === ";" && bracketDepth === 0) {
			const inlineSuite = PythonInlineSuiteColon(tokens) >= 0;
			const continuedIndentation = indentation + (inlineSuite ? 1 : 0);
			finishStatement();
			indentation = continuedIndentation;
			atLineStart = false;
			index++;
			continue;
		}

		// Store remaining single-character punctuation and operators.
		const kind = ",:.".includes(character) ? "punctuation" : "operator";
		tokens.push({ kind, value: character });
		index++;
	}
	finishStatement();
	const expanded = PythonInlineSuites(statements);
	return expanded;
}


// ========================================
// Spacing

/** Return whether two Python tokens need a separating space.
 *
 * Example:
 * >>> PythonTokensNeedSpace({kind: "name", value: "x"}, {kind: "operator", value: "="}, undefined)
 * true
 */
function PythonTokensNeedSpace(
	previous: PythonDisplayToken | undefined,
	current: PythonDisplayToken,
	beforePrevious: PythonDisplayToken | undefined,
	nearestOpening?: string,
): boolean {
	if (!previous) {
		return false;
	}
	if (current.kind === "comment") {
		return true;
	}

	// Closing punctuation binds to the token on its left.
	if ([")", "]", "}", ",", ":", "."].includes(current.value)) {
		return false;
	}
	if (["(", "[", "{"].includes(previous.value) || previous.value === ".") {
		return false;
	}
	if (previous.value === ",") {
		return true;
	}
	if (previous.value === ":") {
		return nearestOpening !== "[";
	}

	// Opening delimiters distinguish calls and indexing from keyword clauses.
	if (["(", "[", "{"].includes(current.value)) {
		if (current.value === "{" || PYTHON_WORD_BEFORE_BRACKET.has(previous.value)) {
			return true;
		}
		return previous.kind !== "name" && previous.kind !== "string" && ![")", "]", "}"].includes(previous.value);
	}

	// Binary operators are padded while unary signs remain attached.
	if (current.kind === "operator" || previous.kind === "operator") {
		const previousIsUnary = ["+", "-", "~"].includes(previous.value)
			&& (!beforePrevious || beforePrevious.kind === "operator" || ["(", "[", "{", ",", ":"].includes(beforePrevious.value));
		return !previousIsUnary;
	}
	return true;
}


/** Render tokens with conventional Python whitespace.
 *
 * Example:
 * >>> PythonTokensFormat([{kind: "name", value: "x"}, {kind: "operator", value: "="}, {kind: "number", value: "1"}])
 * x = 1
 */
function PythonTokensFormat(tokens: PythonDisplayToken[]): string {
	let output = "";
	const openings: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (PythonTokensNeedSpace(tokens[index - 1], token, tokens[index - 2], openings.at(-1))) {
			output += token.kind === "comment" ? "  " : " ";
		}
		output += token.value;

		// Retain enough delimiter context to distinguish slices from mappings.
		if (["(", "[", "{"].includes(token.value)) {
			openings.push(token.value);
		} else if ([")", "]", "}"].includes(token.value)) {
			openings.pop();
		}
	}
	return output;
}


/** Map arbitrary valid source indentation onto four-space display levels.
 *
 * Example:
 * >>> PythonIndentLevels([{indent: 0, tokens: []}, {indent: 1, tokens: []}])
 * 0,1
 */
function PythonIndentLevels(statements: PythonDisplayStatement[]): number[] {
	const levels = [0];
	const result: number[] = [];
	for (const statement of statements) {
		while (levels.length > 1 && statement.indent < levels[levels.length - 1]!) {
			levels.pop();
		}
		if (statement.indent > levels[levels.length - 1]!) {
			levels.push(statement.indent);
		}
		result.push(Math.max(0, levels.length - 1));
	}
	return result;
}


// ========================================
// Line Layout

interface PythonBracketRange {
	close: number;
	commas: number[];
	open: number;
}

/** Find bracket ranges containing comma-separated values.
 *
 * Example:
 * >>> PythonCommaBrackets([{kind: "punctuation", value: "["}, {kind: "number", value: "1"}, {kind: "punctuation", value: ","}, {kind: "number", value: "2"}, {kind: "punctuation", value: "]"}]).length
 * 1
 */
function PythonCommaBrackets(tokens: PythonDisplayToken[]): PythonBracketRange[] {
	const stack: Array<{ commas: number[]; index: number; value: string }> = [];
	const ranges: PythonBracketRange[] = [];

	// Associate direct-child commas with each balanced bracket pair.
	for (let index = 0; index < tokens.length; index++) {
		const value = tokens[index]!.value;
		if (["(", "[", "{"].includes(value)) {
			stack.push({ commas: [], index, value });
			continue;
		}
		if (value === "," && stack.length > 0) {
			stack[stack.length - 1]!.commas.push(index);
			continue;
		}
		if ([")", "]", "}"].includes(value) && stack.length > 0) {
			const opening = stack.pop()!;
			ranges.push({ open: opening.index, close: index, commas: opening.commas });
		}
	}
	return ranges;
}


/** Find direct comprehension clauses inside a bracket range.
 *
 * Example:
 * >>> PythonComprehensionClauses([{kind: "name", value: "x"}], {open: 0, close: 0, commas: []})
 * []
 */
function PythonComprehensionClauses(
	tokens: PythonDisplayToken[],
	range: PythonBracketRange,
): number[] {
	const clauses: number[] = [];
	let depth = 0;
	for (let index = range.open + 1; index < range.close; index++) {
		const value = tokens[index]!.value;
		if (["(", "[", "{"].includes(value)) {
			depth++;
		} else if ([")", "]", "}"].includes(value)) {
			depth--;
		} else if (depth === 0 && ["for", "if"].includes(value)) {
			clauses.push(index);
		}
	}
	return clauses;
}


/** Expand one comma-delimited or comprehension expression over display lines.
 *
 * Example:
 * >>> PythonBracketLines([{kind: "name", value: "x"}], 0, 40)
 * undefined
 */
function PythonBracketLines(
	tokens: PythonDisplayToken[],
	indentLevel: number,
	maximumWidth: number,
): string[] | undefined {
	const indentation = " ".repeat(indentLevel * 4);
	const full = `${indentation}${PythonTokensFormat(tokens)}`;
	const ranges = PythonCommaBrackets(tokens).sort((left, right) => left.open - right.open);
	let range: PythonBracketRange | undefined;
	let clauses: number[] = [];

	// Prefer the outermost overflowing sequence, comprehension, or dense dictionary.
	for (const candidate of ranges) {
		const candidateClauses = PythonComprehensionClauses(tokens, candidate);
		const denseDictionary = tokens[candidate.open]!.value === "{" && full.length > 40;
		const expandCommas = candidate.commas.length > 0 && (full.length > maximumWidth || denseDictionary);
		const expandComprehension = candidateClauses.length > 0 && full.length > 40;
		if (expandCommas || expandComprehension) {
			range = candidate;
			clauses = candidateClauses;
			break;
		}
	}
	if (!range) {
		return undefined;
	}

	// Place each direct child or comprehension clause on an indented line.
	const childIndentation = `${indentation}    `;
	const lines = [`${indentation}${PythonTokensFormat(tokens.slice(0, range.open + 1))}`];
	let start = range.open + 1;
	const boundaries = clauses.length > 0 ? [...clauses, range.close] : [...range.commas, range.close];
	for (const boundary of boundaries) {
		const item = PythonTokensFormat(tokens.slice(start, boundary));
		if (item) {
			const comma = clauses.length === 0 ? "," : "";
			lines.push(`${childIndentation}${item}${comma}`);
		}
		start = clauses.length === 0 ? boundary + 1 : boundary;
	}
	lines.push(`${indentation}${PythonTokensFormat(tokens.slice(range.close))}`);
	return lines;
}


/** Expand a long top-level method chain without changing its expression.
 *
 * Example:
 * >>> PythonChainLines([{kind: "name", value: "x"}], 0, 40)
 * undefined
 */
function PythonChainLines(
	tokens: PythonDisplayToken[],
	indentLevel: number,
	maximumWidth: number,
): string[] | undefined {
	const indentation = " ".repeat(indentLevel * 4);
	if (`${indentation}${PythonTokensFormat(tokens)}`.length <= maximumWidth) {
		return undefined;
	}
	let depth = 0;
	let assignment = -1;
	const breaks: number[] = [];

	// Locate chain dots that follow completed top-level calls or indexes.
	for (let index = 0; index < tokens.length; index++) {
		const value = tokens[index]!.value;
		if (["(", "[", "{"].includes(value)) {
			depth++;
		} else if ([")", "]", "}"].includes(value)) {
			depth--;
		} else if (depth === 0 && value === "=" && assignment < 0) {
			assignment = index;
		} else if (depth === 0 && value === "." && [")", "]", "}"].includes(tokens[index - 1]?.value ?? "")) {
			breaks.push(index);
		}
	}
	if (assignment < 0 || breaks.length === 0) {
		return undefined;
	}

	// Parenthesize the display form and align each chained operation.
	const lines = [`${indentation}${PythonTokensFormat(tokens.slice(0, assignment + 1))} (`];
	let start = assignment + 1;
	for (const boundary of [...breaks, tokens.length]) {
		lines.push(`${indentation}    ${PythonTokensFormat(tokens.slice(start, boundary))}`);
		start = boundary;
	}
	lines.push(`${indentation})`);
	return lines;
}


/** Expand a long assignment around top-level binary operators.
 *
 * Example:
 * >>> PythonBinaryLines([{kind: "name", value: "x"}], 0, 40)
 * undefined
 */
function PythonBinaryLines(
	tokens: PythonDisplayToken[],
	indentLevel: number,
	maximumWidth: number,
): string[] | undefined {
	const indentation = " ".repeat(indentLevel * 4);
	if (`${indentation}${PythonTokensFormat(tokens)}`.length <= maximumWidth) {
		return undefined;
	}
	let depth = 0;
	let assignment = -1;
	const breaks: number[] = [];

	// Find operators belonging to the assignment rather than nested calls.
	for (let index = 0; index < tokens.length; index++) {
		const value = tokens[index]!.value;
		if (["(", "[", "{"].includes(value)) {
			depth++;
		} else if ([")", "]", "}"].includes(value)) {
			depth--;
		} else if (depth === 0 && value === "=" && assignment < 0) {
			assignment = index;
		} else if (depth === 0 && assignment >= 0 && ["+", "-", "|"].includes(value)) {
			breaks.push(index);
		}
	}
	if (assignment < 0 || breaks.length === 0) {
		return undefined;
	}

	// Keep each operator with its following operand inside display parentheses.
	const lines = [`${indentation}${PythonTokensFormat(tokens.slice(0, assignment + 1))} (`];
	lines.push(`${indentation}    ${PythonTokensFormat(tokens.slice(assignment + 1, breaks[0]))}`);
	for (let index = 0; index < breaks.length; index++) {
		const boundary = breaks[index]!;
		const end = breaks[index + 1] ?? tokens.length;
		const operand = PythonTokensFormat(tokens.slice(boundary + 1, end));
		lines.push(`${indentation}    ${tokens[boundary]!.value} ${operand}`);
	}
	lines.push(`${indentation})`);
	return lines;
}


/** Format one statement and expand its densest safe structures.
 *
 * Example:
 * >>> PythonStatementLines({indent: 0, tokens: [{kind: "name", value: "x"}]}, 0, 80)
 * x
 */
function PythonStatementLines(
	statement: PythonDisplayStatement,
	indentLevel: number,
	maximumWidth: number,
): string[] {
	const chain = PythonChainLines(statement.tokens, indentLevel, maximumWidth);
	if (chain) {
		return chain;
	}
	const binary = PythonBinaryLines(statement.tokens, indentLevel, maximumWidth);
	if (binary) {
		return binary;
	}
	const brackets = PythonBracketLines(statement.tokens, indentLevel, maximumWidth);
	if (brackets) {
		return brackets;
	}
	return [`${" ".repeat(indentLevel * 4)}${PythonTokensFormat(statement.tokens)}`];
}


/** Return whether a statement begins a top-level compound suite.
 *
 * Example:
 * >>> PythonTopLevelCompound({indent: 0, tokens: [{kind: "name", value: "for"}]}, 0)
 * true
 */
function PythonTopLevelCompound(statement: PythonDisplayStatement, level: number): boolean {
	return level === 0
		&& PYTHON_COMPOUND_KEYWORDS.has(statement.tokens[0]?.value ?? "")
		&& statement.tokens.at(-1)?.value === ":";
}


// ========================================
// Public Formatting

/** Beautify captured Python for display without executing or changing its source.
 *
 * Example:
 * >>> PythonDisplayCode("for x in [1,2]:\n print(x)")
 * for x in [1, 2]:\n    print(x)
 */
export function PythonDisplayCode(code: string, maximumWidth = 88): string {
	const statements = PythonDisplayTokenize(code.replace(/\r\n?/g, "\n"));
	if (statements.length === 0) {
		return "";
	}
	const levels = PythonIndentLevels(statements);
	const lines: string[] = [];

	// Lay out statements and separate imports or completed top-level suites.
	for (let index = 0; index < statements.length; index++) {
		const statement = statements[index]!;
		const level = levels[index]!;
		const previous = statements[index - 1];
		const previousLevel = levels[index - 1];
		const followsImports = level === 0
			&& previousLevel === 0
			&& ["import", "from"].includes(previous?.tokens[0]?.value ?? "")
			&& !["import", "from"].includes(statement.tokens[0]?.value ?? "");
		const followsSuite = level === 0 && previousLevel !== undefined && previousLevel > 0;

		// Preserve source gaps and add only predictable structural blank lines.
		if ((statement.blankBefore || followsImports || followsSuite) && lines.at(-1) !== "") {
			lines.push("");
		}
		lines.push(...PythonStatementLines(statement, level, Math.max(40, maximumWidth)));
		if (PythonTopLevelCompound(statement, level) && statements[index + 1]?.indent === 0) {
			lines.push("");
		}
	}
	const formatted = lines.join("\n").replace(/\n{3,}/g, "\n\n");
	return formatted;
}
