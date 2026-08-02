/**Collapse built-in tool calls to compact single-row renderers. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { RenderColorName, LineComponent } from "../../render.ts";
import { TextExtractResultContent, TextSanitizeTerminal, TextTruncate } from "../../text.ts";
import { PythonRunRenderCall, PythonRunRenderResult } from "./python_run_renderer.ts";


// ========================================
// Constants

/** Left padding applied to compact tool call rows. */
const COMPACT_LEFT_PAD = " ";

/** Maximum length of a collapsed error string. */
const COMPACT_MAX_ERROR = 75;

/** Maximum lines shown in a bash/stdout detail box. */
const COMPACT_BASH_DETAIL_MAX_LINES = 5;

/** Largest line-pair matrix used to produce a precise write diff. */
const COMPACT_WRITE_DIFF_MAX_CELLS = 500_000;


// ========================================
// Box Rendering


/** Render collapsible boxed details for tool output.

    Example:
        >>> CompactRenderBoxDetails("hello\nworld", "stdout", theme, 60)
 * undefined
 */
function CompactRenderBoxDetails(text: string, labelText: string, theme: any): LineComponent {
	return new LineComponent((width) => {
		// Compute the box geometry from the available width.
		const indent = COMPACT_LEFT_PAD;
		const boxW = Math.max(1, Math.min(104, width - visibleWidth(indent) - 1));
		const innerW = Math.max(1, boxW - 4);
		/** Return the computed result.
		 *
		 * Example:
		 * >>> undefined
		 * undefined
		 */
		const dimLine = (s: string) => theme.fg("dim", truncateToWidth(s, width, ""));

		// Prepare the label and the (capped) content lines.
		const label = truncateToWidth(` ${labelText} `, Math.max(0, boxW - 2), "");
		const clean = TextSanitizeTerminal(text).replace(/\n+$/, "");
		const lines = clean.length > 0 ? clean.split("\n") : [""];
		const visibleLines = lines.slice(0, COMPACT_BASH_DETAIL_MAX_LINES);
		const hidden = Math.max(0, lines.length - visibleLines.length);

		// Draw the top border with the label inset.
		const out: string[] = [];
		out.push(dimLine(`${indent}╭${label}${"─".repeat(Math.max(0, boxW - 2 - visibleWidth(label)))}╮`));

		// Draw each content row, padded to the inner width.
		for (const raw of visibleLines) {
			let cell = truncateToWidth(raw, innerW, "…");
			cell += " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
			out.push(dimLine(`${indent}│ ${cell} │`));
		}

		// Draw the bottom border, tagging how many lines were hidden.
		const tag = hidden > 0 ? truncateToWidth(` ↓${hidden} `, Math.max(0, boxW - 2), "") : "";
		out.push(dimLine(`${indent}╰${"─".repeat(Math.max(0, boxW - 2 - visibleWidth(tag)))}${tag}╯`));
		return out;
	});
}


// ========================================
// Diff Rendering


/** Read the pre-write text, treating a missing file as an empty one.
 *
 * Example:
 * >>> CompactReadBeforeWrite("/missing-file")
 * ""
 */
function CompactReadBeforeWrite(filePath: string): string {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

/** Return a compact line diff for a write operation.
 *
 * Example:
 * >>> CompactWriteDiff("before", "after", "note.txt")
 * "--- a/note.txt\\n+++ b/note.txt..."
 */
function CompactWriteDiff(before: string, after: string, filePath: string): string {
	if (before === after) {
		return "";
	}
	const left = before ? before.split("\n") : [];
	const right = after ? after.split("\n") : [];
	const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
	if (left.length * right.length > COMPACT_WRITE_DIFF_MAX_CELLS) {
		return [...header, ...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)].join("\n");
	}

	// Populate a longest-common-subsequence matrix so insertions do not turn every following line into a change.
	const columns = right.length + 1;
	const matrix = new Uint32Array((left.length + 1) * columns);
	for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
		for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
			const cell = leftIndex * columns + rightIndex;
			matrix[cell] = left[leftIndex] === right[rightIndex]
				? matrix[(leftIndex + 1) * columns + rightIndex + 1]! + 1
				: Math.max(matrix[(leftIndex + 1) * columns + rightIndex]!, matrix[leftIndex * columns + rightIndex + 1]!);
		}
	}

	// Walk the matrix and emit only changed lines; the compact renderer does not need unchanged file context.
	const lines = [...header];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length || rightIndex < right.length) {
		if (left[leftIndex] === right[rightIndex]) {
			// Common lines are intentionally omitted from the compact view.
			leftIndex += 1;
			rightIndex += 1;
		} else if (rightIndex === right.length ||
			(leftIndex < left.length && matrix[(leftIndex + 1) * columns + rightIndex]! >= matrix[leftIndex * columns + rightIndex + 1]!)) {
			lines.push(`-${left[leftIndex] ?? ""}`);
			leftIndex += 1;
		} else {
			lines.push(`+${right[rightIndex] ?? ""}`);
			rightIndex += 1;
		}
	}
	return lines.join("\n");
}

/** Color a single diff line based on its leading marker.

    Example:
        >>> CompactColorDiffLine("+hello", theme)
        " +hello"  (colored as added)
 */
function CompactColorDiffLine(line: string, theme: any): string {
	const padded = `${COMPACT_LEFT_PAD}${line.replace(/\t/g, "   ")}`;
	if (line.startsWith("+")) {
  return theme.fg("toolDiffAdded", padded);
}
	if (line.startsWith("-")) {
  return theme.fg("toolDiffRemoved", padded);
}
	return theme.fg("toolDiffContext", padded);
}


/** Render diff details for an edit tool result.

    Example:
        >>> CompactRenderEditDetails({ path: "foo.ts" }, result, false, theme)
 * undefined
 */
function CompactRenderEditDetails(args: any, result: any, isError: boolean, theme: any): LineComponent {
	return new LineComponent((width) => {
		const path = String(args?.path ?? args?.file_path ?? "");
		const out: string[] = [];
		if (path) {
  out.push(theme.fg("dim", truncateToWidth(`${COMPACT_LEFT_PAD}diff ${path}`, width, "…")));
}
		if (isError) {
			for (const line of TextExtractResultContent(result).split("\n")) {
				out.push(theme.fg("error", truncateToWidth(`${COMPACT_LEFT_PAD}${line}`, width, "…")));
			}
			return out;
		}
		const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
		for (const line of diff.split("\n")) {
			out.push(truncateToWidth(CompactColorDiffLine(line, theme), width, "…"));
		}
		// Continue with the next logical phase.
		return out.length > 0 ? out : [];
	});
}


// ========================================
// Extension Registration


/** Register compact renderers for the built-in tool calls. */
export function CompactToolCallsRegister(pi: ExtensionAPI) {
	const cwd = process.cwd();

	const specs = [
		{ name: "read", verb: "Read", make: () => createReadTool(cwd), arg: (a: any) => a.path },
		{ name: "bash", verb: "Bash", make: () => createBashTool(cwd), arg: (a: any) => a.command },
		{ name: "edit", verb: "Edit", make: () => createEditTool(cwd), arg: (a: any) => a.path },
		{ name: "write", verb: "Write", make: () => createWriteTool(cwd), arg: (a: any) => a.path },
		{
			name: "grep",
			verb: "Grep",
			make: () => createGrepTool(cwd),
			arg: (a: any) => `"${a.pattern}"${a.path ? ` ${a.path}` : a.glob ? ` ${a.glob}` : ""}`,
		},
		{ name: "find", verb: "Find", make: () => createFindTool(cwd), arg: (a: any) => `${a.pattern}${a.path ? ` ${a.path}` : ""}` },
		{ name: "ls", verb: "Ls", make: () => createLsTool(cwd), arg: (a: any) => a.path ?? "." },
	];

	// Continue with the next logical phase.
	for (const spec of specs) {
		const original = spec.make();
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: original.description,
			parameters: original.parameters,
			renderShell: "self",

			/** Execute the original tool and attach a pre/post-write diff when applicable.
			 *
			 * Example:
			 * >>> undefined
			 * undefined
			 */
			async execute(toolCallId, params, signal, onUpdate) {
				if (spec.name !== "write") {
					return original.execute(toolCallId, params as never, signal, onUpdate as never);
				}
				const write = params as { path?: string; content?: string };
				const path = String(write.path ?? "");
				const before = CompactReadBeforeWrite(resolve(cwd, path));
				const result = await original.execute(toolCallId, params as never, signal, onUpdate as never);
				return {
					...result,
					details: { ...(result.details as object | undefined), diff: CompactWriteDiff(before, String(write.content ?? ""), path) },
				};
			},

			/** Render a compact one-line representation of the tool call.
			 *
			 * Example:
			 * >>> undefined
			 * undefined
			 */
			renderCall(args, theme, context) {
				if (spec.name === "bash") {
					// Wait for streamed arguments before choosing the Bash or Python renderer.
					if (!context.argsComplete) {
  return context.lastComponent ?? new Container();
}
					const python = PythonRunRenderCall(String((args as any).command ?? ""), theme, context);
					if (python) {
  return python;
}
				}
				const toolName = spec.name === "bash" ? theme.fg("error", theme.bold(spec.verb)) : RenderColorName(spec.name, spec.verb);
				let line = `${COMPACT_LEFT_PAD}${toolName} `;
				line += theme.fg("muted", String(spec.arg(args as never) ?? ""));
				return new Text(line, 0, 0);
			},

			/** Render a compact representation of the tool result.
			 *
			 * Example:
			 * >>> undefined
			 * undefined
			 */
			renderResult(result, options, theme, context) {
				if (spec.name === "bash") {
					const python = PythonRunRenderResult(result, options, theme, context);
					if (python) {
  return python;
}
				}
				if (options.isPartial) {
  return new Container();
}
				const text = TextExtractResultContent(result);
				const details = result.details as any;
				const isError = context.isError || Boolean(details?.error || details?.blocked) || /^Error/i.test(text);

				// Writes always show their generated before/after diff to make agent changes immediately reviewable.
				if (spec.name === "write") {
					return CompactRenderEditDetails(context.args, result, isError, theme) as any;
				}
				if (options.expanded) {
					if (spec.name === "bash") {
  // Continue with the next logical phase.
  return CompactRenderBoxDetails(text, "stdout", theme) as any;
}
					// Continue with the next logical phase.
					if (spec.name === "ls") {
  return CompactRenderBoxDetails(text, "ls", theme) as any;
}
					if (spec.name === "grep") {
  return CompactRenderBoxDetails(text, "grep", theme) as any;
}
					// Continue with the next logical phase.
					if (spec.name === "edit") {
  return CompactRenderEditDetails(context.args, result, isError, theme) as any;
}
				}

				// Continue with the next logical phase.
				if (isError) {
					return new Text(theme.fg("error", `${COMPACT_LEFT_PAD}✗ ${TextTruncate(text.split("\n")[0] ?? "error", COMPACT_MAX_ERROR)}`), 0, 0);
				}
				return new Container();
			},
		});
	}
}
