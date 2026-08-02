/** Shared text cleaning, sanitizing, and terminal formatting. */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { NodeBulletBodyTyped } from "./outline/model.ts";
import { SGR_RESET, SGR_REVERSE_OFF, SGR_REVERSE_ON } from "./constants.ts";


// ========================================
// Text Extraction


/** Extract plain text from a message content value (string or content part array).

    Args:
        content: A string, an array of content parts, or unknown.

    Returns:
        The concatenated text of all text-type parts, or the raw string.

    Example:
        >>> TextExtractContent([{ type: "text", text: "hello" }])
        "hello"
 */
function TextExtractContent(content: unknown): string {
	if (typeof content === "string") {
  return content;
}
	if (!Array.isArray(content)) {
  return "";
}
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => part.text ?? "")
		.join("\n");
}


/** Extract plain text from a tool result content array.

    Args:
        result: A tool result object with an optional content array.

    Returns:
        The concatenated text of all text-type content parts.

    Example:
        >>> TextExtractResultContent({ content: [{ type: "text", text: "ok" }] })
        "ok"
 */
export function TextExtractResultContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return TextExtractContent(result.content).split("\n").filter(Boolean).join("\n");
}


/** Extract plain text and tool call markers from message content.

    Args:
        content: A string, array of content parts, or unknown.

    Returns:
        Concatenated text with tool calls marked as [tool:name ...].

    Example:
        >>> TextExtractContentWithToolCalls([{ type: "text", text: "hello" }])
        "hello"
 */
export function TextExtractContentWithToolCalls(content: unknown): string {
	if (typeof content === "string") {
  return content;
}
	if (!Array.isArray(content)) {
  return "";
}
	return content
		.flatMap((part: any) => {
			if (part?.type === "text" && typeof part.text === "string") {
  return [part.text];
}
			if (part?.type === "toolCall" && typeof part.name === "string") {
  return [`[tool:${part.name} ${JSON.stringify(part.arguments ?? {})}]`];
}
			return [];
		})
		.join("\n");
}


// ========================================
// Sanitization


/** Strip ANSI escape sequences from text.

    Args:
        text: The string possibly containing ANSI codes.

    Returns:
        The string with all ANSI escape sequences removed.

    Example:
        >>> TextStripAnsi("\\x1b[31mhello\\x1b[0m")
        "hello"
 */
export function TextStripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}


/** Sanitize text for terminal rendering: normalize line endings, strip ANSI and control characters, expand tabs.

    Args:
        text: The raw input string to sanitize.

    Returns:
        The sanitized string safe for fixed-width terminal rendering.

    Example:
        >>> TextSanitizeTerminal("hello\\r\\nworld\\t!")
        "hello\\nworld    !"
 */
export function TextSanitizeTerminal(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "") // OSC escapes
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI/SGR escapes
		.replace(/\x1b[ -/]*[@-~]/g, "") // other ESC sequences
		.replace(/\t/g, "    ")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control bytes
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}


// ========================================
// Helpers


/** Truncate a string to a maximum code-unit length.

    Args:
        text: The string to truncate.
        maxLength: Maximum output length, including the ellipsis when truncated.
        ellipsis: Marker appended when truncating.

    Returns:
        The truncated string, possibly with a trailing ellipsis marker.

    Example:
        >>> TextTruncate("abcdef", 4)
        "abc…"
 */
export function TextTruncate(text: string, maxLength: number, ellipsis = "…"): string {
	if (text.length <= maxLength) {
  return text;
}
	if (maxLength <= ellipsis.length) {
  return ellipsis.slice(0, Math.max(0, maxLength));
}
	return `${text.slice(0, maxLength - ellipsis.length)}${ellipsis}`;
}




/** Trim, deduplicate, and sort a list of strings.

    Args:
        items: The list of strings to compact.

    Returns:
        Sorted, deduplicated, trimmed strings.

    Example:
        >>> TextCompactUnique([" b ", "a", "a", "  c  "])
        ["a", "b", "c"]
 */
export function TextCompactUnique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}


// ========================================
// Inline Markdown

/** Inline span kinds recognized in node text. */
type TextInlineKind = "plain" | "bold" | "code";

/** One styled span parsed from node text. */
interface TextInlineSegment {
	kind: TextInlineKind;
	text: string;
	start: number;
	end: number;
}

/** Theme callbacks for painting inline markdown spans. */
interface TextInlinePaintTheme {
	plain(s: string): string;
	bold(s: string): string;
	code(s: string): string;
	dim?(s: string): string;
}

const TEXT_INLINE_CODE_BG = "\x1b[48;2;50;50;58m";
const TEXT_INLINE_CODE_FG = "\x1b[38;2;212;212;212m";


/** Parse `**bold**` and `` `code` `` spans from node text.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function TextParseInlineMarkdown(text: string): TextInlineSegment[] {
	const segments: TextInlineSegment[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("**", i)) {
			const close = text.indexOf("**", i + 2);
			if (close !== -1) {
				segments.push({ kind: "bold", text: text.slice(i + 2, close), start: i, end: close + 2 });
				i = close + 2;
				continue;
			}
		}
		if (text[i] === "`") {
			const close = text.indexOf("`", i + 1);
			if (close !== -1) {
				// Continue with the next logical phase.
				segments.push({ kind: "code", text: text.slice(i + 1, close), start: i, end: close + 1 });
				i = close + 1;
				continue;
			}
		}
		let j = i + 1;
		let hasPlainRun = j < text.length && !text.startsWith("**", j) && text[j] !== "`";
		while (hasPlainRun) {
			j++;
			hasPlainRun = j < text.length && !text.startsWith("**", j) && text[j] !== "`";
		}
		segments.push({ kind: "plain", text: text.slice(i, j), start: i, end: j });
		i = j;
	}
	if (segments.length === 0) {
  segments.push({ kind: "plain", text: "", start: 0, end: 0 });
}
	// Continue with the next logical phase.
	return segments;
}


/** Build a default inline-markdown paint theme from a Pi TUI theme.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function TextInlinePaintThemeFrom(theme: { fg(color: ThemeColor, text: string): string; bold(text: string): string }): TextInlinePaintTheme {
	return {
		plain: (s) => s,
		bold: (s) => theme.bold(s),
		code: (s) => `${TEXT_INLINE_CODE_BG}${TEXT_INLINE_CODE_FG}${s}${SGR_RESET}`,
		dim: (s) => theme.fg("dim", s),
	};
}

/** One paintable run in source text (marker, styled content, or plain). */
interface TextInlinePaintPiece {
	start: number;
	end: number;
	styler: (s: string) => string;
}


/** Expand parsed inline spans into absolute paint runs.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function TextInlinePaintPieces(text: string, paint: TextInlinePaintTheme): TextInlinePaintPiece[] {
	const dim = paint.dim ?? paint.plain;
	const pieces: TextInlinePaintPiece[] = [];
	for (const seg of TextParseInlineMarkdown(text)) {
		if (seg.kind === "plain") {
			pieces.push({ start: seg.start, end: seg.end, styler: paint.plain });
			continue;
		}
		const marker = seg.kind === "bold" ? "**" : "`";
		pieces.push({ start: seg.start, end: seg.start + marker.length, styler: dim });
		pieces.push({
			start: seg.start + marker.length,
			end: seg.end - marker.length,
			styler: seg.kind === "bold" ? paint.bold : paint.code,
		});
		// Continue with the next logical phase.
		pieces.push({ start: seg.end - marker.length, end: seg.end, styler: dim });
	}
	return pieces;
}


/** Paint inline markdown with an optional active caret highlight.

    Args:
        text: Source text containing **bold** and `code` spans.
        caretCol: Source index of the active caret, or -1 when inactive.
        paint: Theme callbacks for plain, bold, and code spans.
        sliceStart: Start index limiting output to one wrapped visual line.
        sliceEnd: End index limiting output to one wrapped visual line.

    Returns:
        ANSI-painted text with span styles and optional reverse-video caret.

    Example:
        >>> TextPaintInlineMarkdownAt("**hi**", -1, theme)
        "hi"  (bold-styled)
 */
export function TextPaintInlineMarkdownAt(
	text: string,
	caretCol: number,
	paint: TextInlinePaintTheme,
	sliceStart = 0,
	sliceEnd = text.length,
): string {
	let out = "";

	/** Return the computed result.
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	const paintRun = (run: string, absStart: number, styler: (s: string) => string): string => {
		if (caretCol < 0) {
  return styler(run);
}
		if (caretCol < absStart || caretCol > absStart + run.length) {
  return styler(run);
}
		if (caretCol === absStart + run.length) {
  return styler(run);
}
		const rel = caretCol - absStart;
		return `${styler(run.slice(0, rel))}${SGR_REVERSE_ON}${run[rel] ?? " "}${SGR_REVERSE_OFF}${styler(run.slice(rel + 1))}`;
	};

	for (const piece of TextInlinePaintPieces(text, paint)) {
		const start = Math.max(piece.start, sliceStart);
		const end = Math.min(piece.end, sliceEnd);
		// Continue with the next logical phase.
		if (start >= end) {
  continue;
}
		out += paintRun(text.slice(start, end), start, piece.styler);
	}

	// Continue with the next logical phase.
	if (caretCol === text.length && sliceEnd >= text.length) {
  out += `${SGR_REVERSE_ON} ${SGR_REVERSE_OFF}`;
}
	return out;
}














// ========================================
// Text Wrapping


/** Wrap plain text into chunks no wider than `width` display columns.

    Args:
        text: The raw input string to wrap.
        width: Maximum display width per chunk.

    Returns:
        Array of { str, start } where start is the code-unit offset into text.

    Example:
        >>> TextWrap("hello world", 5)
        [{ str: "hello", start: 0 }, { str: " worl", start: 5 }, { str: "d", start: 10 }]
 */
export function TextWrap(text: string, width: number): { str: string; start: number }[] {
	const out: { str: string; start: number }[] = [];
	let start = 0;
	while (start < text.length) {
		let w = 0;
		let end = start;
		while (end < text.length) {
			const cw = TextVisibleWidth(text[end]!) || 1;
			if (w + cw > width && end > start) {
  break;
}
			w += cw;
			end++;
		}
		out.push({ str: text.slice(start, end), start });
		// Continue with the next logical phase.
		start = end;
	}
	// Continue with the next logical phase.
	if (out.length === 0) {
  out.push({ str: "", start: 0 });
}
	return out;
}


// ========================================
// Escaping


/** Escape XML/HTML special characters (&, ", <, >) to entities.

    Args:
        s: The string to escape.

    Returns:
        The escaped string safe for use in XML/HTML attributes or text.

    Example:
        >>> TextEscapeXml('a & "b" <c>')
        "a &amp; &quot;b&quot; &lt;c&gt;"
 */
export function TextEscapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


// ========================================
// Paste Handling


/** Decode CSI-u Ctrl+<letter> escape sequences inside bracketed paste back to control bytes.

    Some terminals/tmux configurations encode control bytes inside bracketed
    paste as CSI-u Ctrl+<letter> sequences. Decode those back before filtering.

    Args:
        text: The raw pasted text possibly containing CSI-u sequences.

    Returns:
        The text with recognized Ctrl+<letter> sequences decoded to control bytes.

    Example:
        >>> TextDecodePasteControlSequences("\\x1b[97;5u")
        "\\x01"
 */
export function TextDecodePasteControlSequences(text: string): string {
	return text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
		const cp = Number(code);
		if (cp >= 97 && cp <= 122) {
  return String.fromCharCode(cp - 96);
}
		if (cp >= 65 && cp <= 90) {
  return String.fromCharCode(cp - 64);
}
		return match;
	});
}


/** Sanitize bracketed-paste input: normalize CRLF, expand tabs, strip control bytes.

    Args:
        text: The raw pasted text.
        decode: Whether to first decode CSI-u control sequences. Defaults to true.

    Returns:
        The cleaned paste text.

    Example:
        >>> TextCleanPaste("a\\r\\nb\\tc")
        "a\\nb    c"
 */
export function TextCleanPaste(text: string, decode = true): string {
	const decoded = decode ? TextDecodePasteControlSequences(text) : text;
	return decoded
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.split("")
		.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
		.join("");
}


// ========================================
// Name Inference




// ========================================
// Worker Output

/** Meta-commentary line prefixes workers should not insert into the outline. */
const TEXT_WORKER_META_LINE =
	/^(?:-\s*)?(?:summary|overview|result|findings|conclusion|notes?|update|changes?(?:\s+made)?|files?\s+(?:changed|modified|updated)|what\s+i\s+did|here(?:'s| is)|i\s+(?:found|updated|changed|modified|implemented|verified))\b[:\s-]*/i;

/** Standalone headers that narrate tool runs instead of delivering an answer. */
const TEXT_WORKER_TOOL_HEADER = /^(?:-\s*)?\d*\s*.*\btool calls?\b.*(?:completed|finished|done)\b/i;

/** Leading outline/tree glyphs workers sometimes echo in markdown answers. */
const TEXT_OUTLINE_ARTIFACT = /^[\s│|├╰─┴┬○●◌➜]+/;


/** Join soft-wrapped continuation lines (and tree-artifact prefixes) into their bullet.

    Args:
        text: Raw outline markdown, possibly with mid-sentence line breaks.

    Returns:
        Markdown with continuations folded onto the preceding line.

    Example:
        >>> TextJoinOutlineContinuations("- hello\\n world\\n  - child")
        "- hello world\\n  - child"
 */
function TextJoinOutlineContinuations(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	for (const raw of lines) {
		const trimmed = raw.trim();
		if (!trimmed) {
			if (out.length > 0 && out[out.length - 1] !== "") {
  out.push("");
}
			continue;
		}
		const isBullet = /^(?:-\s+|\d+\.\s+)/.test(trimmed);
		const isFence = /^```/.test(trimmed);
		const isClosingFence = /^```\s*$/.test(trimmed);
		if (isFence || isBullet || out.length === 0) {
			out.push(isBullet ? raw.replace(/\s+$/, "") : trimmed);
			continue;
		}
		if (isClosingFence) {
			out.push(trimmed);
			continue;
		}
		const cont = trimmed.replace(TEXT_OUTLINE_ARTIFACT, "").trim();
		if (!cont) {
  continue;
}
		const prev = out[out.length - 1]!;
		const joiner = /[-—]$/.test(prev.trim()) ? "" : " ";
		out[out.length - 1] = `${prev}${joiner}${cont}`;
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


/** Prepare worker markdown for outline-tree preview rendering.

    Args:
        markdown: Worker final text or finish_worker markdown.

    Returns:
        Sanitized outline markdown safe for `NodeStoreFromMarkdown`.

    Example:
        >>> TextPrepareOutlineMarkdown("- root\\n  - child")
        "- root\\n  - child"
 */
export function TextPrepareOutlineMarkdown(markdown: string): string {
	let text = TextSanitizeWorkerMarkdown(markdown);
	if (!text) {
  return "";
}
	text = TextJoinOutlineContinuations(text);
	if (!/^-\s/m.test(text)) {
		const paras = text.split(/\n\n+/).map((p) => p.replace(/\n+/g, " ").trim()).filter(Boolean);
		if (paras.length === 0) {
  return "";
}
		text = paras.length === 1 ? `- ${paras[0]}` : paras.map((p) => `- ${p}`).join("\n");
	}
	return text;
}


/** Normalize worker markdown before it is parsed into outline nodes. */
function TextSanitizeWorkerMarkdown(markdown: string): string {
	let text = markdown.trim().replace(/\n?WORKER_DONE\s*$/i, "").trim();
	if (!text) {
  return "";
}

	text = text
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^(\s*)(\d+)\.\s+/gm, "$1- ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const lines = text.split("\n");
	const filtered = lines.filter((line) => {
		const trimmed = line.trim();
		if (TEXT_WORKER_META_LINE.test(trimmed)) {
  return false;
}
		if (TEXT_WORKER_TOOL_HEADER.test(trimmed)) {
  return false;
}
		return true;
	});
	text = (filtered.length > 0 ? filtered : lines).join("\n").trim();
	text = TextJoinOutlineContinuations(text);

	const topLevel = text.split("\n").filter((line) => /^-\s/.test(line));
	const hasNonBulletLines = text.split("\n").some((line) => line.trim() && !/^-\s/.test(line) && !/^```/.test(line.trim()));
	if (topLevel.length === 1 && !text.includes("\n  ") && !hasNonBulletLines && !text.includes("\n")) {
		const body = topLevel[0]!.replace(/^-\s+/, "").trim();
		// Keep outline bullets for typed nodes (bash/code) so parsing works.
		if (!NodeBulletBodyTyped(body)) {
  text = body;
}
	}

	// Drop indented lines after bash bullets — workers must not ship stdout in markdown.
	{
		const lines = text.split("\n");
		const kept: string[] = [];
		let skipIndentedAfterBash = false;
		for (const line of lines) {
			if (/^-\s/.test(line)) {
				const body = line.replace(/^-\s+/, "").trim();
				skipIndentedAfterBash = /^`\$\s/.test(body);
				kept.push(line);
				continue;
			}
			if (skipIndentedAfterBash && /^\s+/.test(line)) {
  continue;
}
			skipIndentedAfterBash = false;
			kept.push(line);
		}
		text = kept.join("\n").trim();
	}

	// Collapse accidental multi-bash command dumps to the first top-level bash node.
	const topLevelAfter = text.split("\n").filter((line) => /^-\s/.test(line));
	const topBash = topLevelAfter.filter((line) => /^`\$\s/.test(line.replace(/^-\s+/, "").trim()));
	if (topBash.length > 1 && topBash.length === topLevelAfter.length) {
		text = topBash[0]!.trim();
	}

	if (text.length > 6000) {
  text = `${text.slice(0, 5997)}…`;
}
	return text;
}


// ========================================
// Internal Helpers


/** Compute the visible display width of a string using Unicode east-asian-width rules.

    Args:
        text: The string to measure.

    Returns:
        The total visible width in terminal columns.

    Example:
        >>> TextVisibleWidth("hello")
        5
 */
function TextVisibleWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd))) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}
