/**Rich full-width rendering for Python programs launched through the bash tool. */
import { basename } from "node:path";
import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	type Component,
	Container,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Image,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SGR_RESET } from "../../constants.ts";
import { RenderBgFillLine, LineComponent } from "../../render.ts";
import { TextSanitizeTerminal } from "../../text.ts";
import { PythonRunDetect, type PythonRunSnippet } from "./python_command.ts";
import { PythonDisplayCode } from "./python_display_formatter.ts";
import { PythonFindImagePaths, type PythonImageArtifact, type PythonPixelImage } from "./python_image.ts";
import { ImageToolIsRecent } from "./image_turns.ts";
import { LocalConditionalImageStack } from "./local_image_renderer.ts";
export { PythonRunDetect } from "./python_command.ts";
export { PythonDisplayCode } from "./python_display_formatter.ts";
export { PythonPngDecode } from "./python_image.ts";

// ========================================
// Types and Constants

type PythonRenderTheme = Pick<Theme, "fg">;

interface PythonRenderContext {
	cwd: string;
	expanded: boolean;
	showImages?: boolean;
	isError?: boolean;
	state: Record<string, unknown>;
	args?: Record<string, unknown>;
	toolCallId?: string;
}

interface PythonRenderResultValue {
	content?: Array<{ type: string; text?: unknown }>;
}

interface PythonRenderOptions {
	isPartial: boolean;
	expanded: boolean;
}

const PYTHON_CODE_MAX_LINES = 24;
const PYTHON_SHELL_MAX_LINES = 12;
const PYTHON_SHELL_EXPANDED_MAX_LINES = 60;
const PYTHON_RESULT_MAX_LINES = 24;
const PYTHON_RESULT_EXPANDED_MAX_LINES = 200;
/** Matches the full-width gray prompt composer panel. */
const PYTHON_PANEL_BG = "\x1b[48;2;42;42;42m";
const PYTHON_PANEL_RGB: [number, number, number] = [42, 42, 42];
const PYTHON_IMAGE_MAX_COLS = 72;
const PYTHON_IMAGE_MAX_ROWS = 24;
/** Lets Pi TUI treat a Sixel DCS payload as a zero-width image line. */
const PYTHON_SIXEL_TUI_MARKER = "\x1b_Ga=q,q=2;\x1b\\";

type PythonImageProtocol = "kitty" | "iterm2" | "sixel" | "unicode";

// ========================================
// Full-width Panel Rendering

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonRule(
	label: string,
	width: number,
	theme: PythonRenderTheme,
): string {
	if (width <= 0) {
  return "";
}
	const prefix = label ? `─ ${label} ` : "";
	const line =
		truncateToWidth(prefix, width, "") +
		"─".repeat(Math.max(0, width - visibleWidth(prefix)));
	return theme.fg("borderMuted", truncateToWidth(line, width, ""));
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonPanelRow(content: string, width: number): string {
	if (width <= 0) {
  return "";
}
	const padding = width >= 4 ? 2 : 0;
	const innerWidth = Math.max(1, width - padding * 2);
	const cell = `${" ".repeat(padding)}${truncateToWidth(content, innerWidth, "…")}`;
	return RenderBgFillLine(cell, width, PYTHON_PANEL_BG, SGR_RESET);
}

/** Render shell commands that execute before or after the detected Python segment.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonShellSection(
	command: string,
	label: string,
	width: number,
	theme: PythonRenderTheme,
	expanded: boolean,
): string[] {
	const contentWidth = Math.max(1, width - 4);
	const rawLines = TextSanitizeTerminal(command)
		.replace(/\n+$/, "")
		.split("\n");
	const maxLines = expanded
		? PYTHON_SHELL_EXPANDED_MAX_LINES
		: PYTHON_SHELL_MAX_LINES;
	const shown = rawLines.slice(0, maxLines);
	const out = [PythonRule(label, width, theme)];
	for (const line of shown) {
		const chunks = wrapTextWithAnsi(theme.fg("error", line), contentWidth);
		for (const chunk of chunks.length > 0 ? chunks : [""]) {
			// Continue with the next logical phase.
			out.push(PythonPanelRow(chunk, width));
		}
	}
	if (rawLines.length > shown.length) {
		out.push(
			PythonPanelRow(
				theme.fg(
					"dim",
					`… ${rawLines.length - shown.length} more shell lines`,
				),
				width,
			),
		);
	}
	return out;
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonCompositePixel(
	image: PythonPixelImage,
	x: number,
	y: number,
): [number, number, number] {
	const offset =
		(Math.min(image.height - 1, y) * image.width +
			Math.min(image.width - 1, x)) *
		4;
	const alpha = image.rgba[offset + 3]! / 255;
	return [0, 1, 2].map((channel) =>
		Math.round(
			image.rgba[offset + channel]! * alpha +
				PYTHON_PANEL_RGB[channel]! * (1 - alpha),
		),
	) as [number, number, number];
}

/** Approximate an image inline with true-color Unicode half blocks.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonUnicodeImageLines(
	image: PythonPixelImage,
	width: number,
): string[] {
	const contentWidth = Math.max(1, width - 4);
	const columns = Math.max(
		1,
		Math.min(PYTHON_IMAGE_MAX_COLS, contentWidth, image.width),
	);
	const rows = Math.max(
		1,
		Math.min(
			PYTHON_IMAGE_MAX_ROWS,
			Math.ceil((columns * image.height) / image.width / 2),
		),
	);
	const left = " ".repeat(
		Math.max(0, Math.floor((contentWidth - columns) / 2)),
	);
	const out: string[] = [];
	// Continue with the next logical phase.
	for (let row = 0; row < rows; row++) {
		let pixels = left;
		for (let column = 0; column < columns; column++) {
			const x = Math.min(
				image.width - 1,
				Math.floor(((column + 0.5) * image.width) / columns),
			);
			const topY = Math.min(
				image.height - 1,
				Math.floor(((row * 2 + 0.5) * image.height) / (rows * 2)),
			);
			const bottomY = Math.min(
				image.height - 1,
				Math.floor(((row * 2 + 1.5) * image.height) / (rows * 2)),
			);
			// Continue with the next logical phase.
			const top = PythonCompositePixel(image, x, topY);
			const bottom = PythonCompositePixel(image, x, bottomY);
			pixels += `\x1b[38;2;${top.join(";")}m\x1b[48;2;${bottom.join(";")}m▀`;
		}
		pixels += `\x1b[39m${PYTHON_PANEL_BG}`;
		out.push(PythonPanelRow(pixels, width));
	}
	return out;
}

/** Select the best terminal image protocol supported by the current environment.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function PythonImageProtocolDetect(
	env: Record<string, string | undefined> = process.env,
	nativeProtocol: "kitty" | "iterm2" | null = getCapabilities().images,
): PythonImageProtocol {
	if (nativeProtocol) {
  return nativeProtocol;
}

	const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
	const term = env.TERM?.toLowerCase() ?? "";
	if (env.WT_SESSION) {
  return "sixel";
}
	if (env.KITTY_WINDOW_ID ||
		env.GHOSTTY_RESOURCES_DIR ||
		env.WEZTERM_PANE ||
		env.WARP_SESSION_ID ||
		["kitty", "ghostty", "wezterm", "warpterminal", "konsole", "rio"].includes(
			termProgram,
		// Continue with the next logical phase.
		)) {
  return "kitty";
}
	// Continue with the next logical phase.
	if (env.ITERM_SESSION_ID ||
		["iterm.app", "vscode", "mintty"].includes(termProgram)) {
  return "iterm2";
}
	if (term.includes("sixel") || term.startsWith("mlterm")) {
  return "sixel";
}
	return "unicode";
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonCalculateImageCellSize(
	dimensions: { widthPx: number; heightPx: number },
	maxWidth: number,
	maxHeight: number,
): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const scale = Math.min(
		(maxWidth * cell.widthPx) / Math.max(1, dimensions.widthPx),
		(maxHeight * cell.heightPx) / Math.max(1, dimensions.heightPx),
	);
	return {
		columns: Math.max(
			1,
			Math.min(
				maxWidth,
				Math.ceil((dimensions.widthPx * scale) / cell.widthPx),
			),
		),
		rows: Math.max(
			1,
			// Continue with the next logical phase.
			Math.min(
				maxHeight,
				Math.ceil((dimensions.heightPx * scale) / cell.heightPx),
			),
		),
	};
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonProtocolCanRender(
	image: PythonImageArtifact,
	protocol: PythonImageProtocol,
): boolean {
	if (protocol === "iterm2") {
  return true;
}
	if (protocol === "kitty") {
  return image.mimeType === "image/png";
}
	if (protocol === "sixel") {
  return image.pixels !== undefined;
}
	return false;
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonResizePixelImage(
	image: PythonPixelImage,
	width: number,
	height: number,
): PythonPixelImage {
	if (width === image.width && height === image.height) {
  return image;
}
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sourceY = Math.min(
			image.height - 1,
			Math.floor(((y + 0.5) * image.height) / height),
		);
		for (let x = 0; x < width; x++) {
			const sourceX = Math.min(
				image.width - 1,
				Math.floor(((x + 0.5) * image.width) / width),
			);
			const source = (sourceY * image.width + sourceX) * 4;
			// Continue with the next logical phase.
			const target = (y * width + x) * 4;
			// Continue with the next logical phase.
			rgba[target] = image.rgba[source] ?? 0;
			rgba[target + 1] = image.rgba[source + 1] ?? 0;
			rgba[target + 2] = image.rgba[source + 2] ?? 0;
			rgba[target + 3] = image.rgba[source + 3] ?? 255;
		}
	}
	return { width, height, rgba };
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonSixelRun(character: string, count: number): string {
	return count >= 4 ? `!${count}${character}` : character.repeat(count);
}

/** Encode RGBA pixels with a compact 64-color Sixel palette.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function PythonSixelEncode(image: PythonPixelImage): string {
	const colorLevels = [0, 33, 67, 100];
	const indices = new Uint8Array(image.width * image.height);
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const color = PythonCompositePixel(image, x, y);
			const red = Math.round((color[0] * 3) / 255);
			const green = Math.round((color[1] * 3) / 255);
			const blue = Math.round((color[2] * 3) / 255);
			indices[y * image.width + x] = red * 16 + green * 4 + blue;
		}
	}

	let output = `\x1bP0;1;q"1;1;${image.width};${image.height}`;
	for (let index = 0; index < 64; index++) {
		const red = Math.floor(index / 16);
		// Continue with the next logical phase.
		const green = Math.floor(index / 4) % 4;
		const blue = index % 4;
		output += `#${index};2;${colorLevels[red]};${colorLevels[green]};${colorLevels[blue]}`;
	}

	for (let bandY = 0; bandY < image.height; bandY += 6) {
		const used = new Set<number>();
		for (let y = bandY; y < Math.min(image.height, bandY + 6); y++) {
			for (let x = 0; x < image.width; x++) {
  used.add(indices[y * image.width + x] ?? 0);
}
		}
		const layers: string[] = [];
		for (const color of used) {
			const masks = new Uint8Array(image.width);
			let last = -1;
			// Continue with the next logical phase.
			for (let x = 0; x < image.width; x++) {
				let mask = 0;
				for (let bit = 0; bit < 6 && bandY + bit < image.height; bit++) {
					if (indices[(bandY + bit) * image.width + x] === color) {
  mask |= 1 << bit;
}
				}
				masks[x] = mask;
				if (mask !== 0) {
  last = x;
}
			}
			let layer = `#${color}`;
			let runCharacter = "";
			let runLength = 0;
			for (let x = 0; x <= last; x++) {
				// Continue with the next logical phase.
				const character = String.fromCharCode(63 + (masks[x] ?? 0));
				// Continue with the next logical phase.
				if (character === runCharacter) { runLength++; }
				else {
					if (runLength > 0) {
  layer += PythonSixelRun(runCharacter, runLength);
}
					runCharacter = character;
					runLength = 1;
				}
			}
			if (runLength > 0) {
  layer += PythonSixelRun(runCharacter, runLength);
}
			layers.push(layer);
		}
		output += layers.join("$");
		if (bandY + 6 < image.height) {
  output += "-";
}
	}
	// Continue with the next logical phase.
	return `${output}\x1b\\`;
}

/** Wrap a terminal image control sequence for tmux passthrough when needed.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function PythonTmuxPassthrough(
	sequence: string,
	env: Record<string, string | undefined> = process.env,
): string {
	if (!env.TMUX && !env.TMUX_PANE) {
  return sequence;
}
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

class PythonTerminalImage implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly imageId: number;

	constructor(
		private readonly image: PythonImageArtifact,
		private readonly protocol: Exclude<PythonImageProtocol, "unicode">,
	) {
		this.imageId = allocateImageId();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	/** Return the computed result.
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
  return this.cachedLines;
}
		const dimensions = this.image.pixels
			? { widthPx: this.image.pixels.width, heightPx: this.image.pixels.height }
			: (getImageDimensions(this.image.data!, this.image.mimeType!) ?? undefined);
		if (!dimensions) {
  return [`[Image: ${basename(this.image.path)}]`];
}
		const maxWidth = Math.max(1, Math.min(width - 2, 80));
		const size = PythonCalculateImageCellSize(
			dimensions,
			maxWidth,
			PYTHON_IMAGE_MAX_ROWS,
		);
		// Continue with the next logical phase.
		let sequence: string;
		if (this.protocol === "kitty") {
			// Continue with the next logical phase.
			sequence = encodeKitty(this.image.data!, {
				columns: size.columns,
				rows: size.rows,
				imageId: this.imageId,
				moveCursor: false,
			});
		} else if (this.protocol === "iterm2") {
			sequence = encodeITerm2(this.image.data!, {
				width: size.columns,
				height: "auto",
				name: basename(this.image.path),
				preserveAspectRatio: true,
			});
		} else {
			// Continue with the next logical phase.
			const pixels = this.image.pixels;
			switch (Boolean(!pixels)) {
  case true: {
    return [`[Image: ${basename(this.image.path)}]`];
  }
}
			const cell = getCellDimensions();
			const pixelScale = Math.min(
				(size.columns * cell.widthPx) / dimensions.widthPx,
				(size.rows * cell.heightPx) / dimensions.heightPx,
			);
			const target = PythonResizePixelImage(
				pixels!,
				Math.max(1, Math.round(dimensions.widthPx * pixelScale)),
				Math.max(1, Math.round(dimensions.heightPx * pixelScale)),
			);
			// Continue with the next logical phase.
			sequence = PythonSixelEncode(target);
		}
		if (this.protocol === "sixel") {
			// Sixel advances Windows Terminal's physical cursor. Restore it before Pi
			// performs its own row accounting, or the next repaint erases the image.
			sequence = `\x1b7${sequence}\x1b8`;
		}
		sequence = PythonTmuxPassthrough(sequence);

		let lines: string[];
		if (this.protocol === "kitty") {
			lines = [sequence, ...Array.from({ length: size.rows - 1 }, () => "")];
		} else {
			lines = Array.from({ length: Math.max(0, size.rows - 1) }, () => "");
			const offset = size.rows - 1;
			const moveUp = offset > 0 ? `\x1b[${offset}A` : "";
			const moveDown = offset > 0 ? `\x1b[${offset}B` : "";
			const marker = this.protocol === "sixel" ? PYTHON_SIXEL_TUI_MARKER : "";
			lines.push(`${marker}${moveUp}${sequence}${moveDown}`);
		}
		// Continue with the next logical phase.
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/** Render a full-width header, gray syntax-highlighted code panel, and result divider.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function PythonRunRenderCall(
	command: string,
	theme: PythonRenderTheme,
	context: PythonRenderContext,
): Component | undefined {
	const snippet = PythonRunDetect(command, context.cwd);
	if (!snippet) {
  return undefined;
}
	context.state.pythonRunSnippet = snippet;

	return new LineComponent((width) => {
		if (width < 4) {
  return [truncateToWidth("Python", width, "")];
}

		// Beautify the source before preview limits and syntax highlighting.
		const contentWidth = Math.max(1, width - 4);
		const displayWidth = Math.max(40, contentWidth - 6);
		const rawLines = PythonDisplayCode(
			TextSanitizeTerminal(snippet.code),
			displayWidth,
		)
			.replace(/\n+$/, "")
			.split("\n");
		const shown = context.expanded
			? rawLines
			: rawLines.slice(0, PYTHON_CODE_MAX_LINES);

		// Derive highlighting and line-number geometry from the visible source.
		const highlighted = highlightCode(shown.join("\n"), "python");
		const numberWidth = String(Math.max(1, shown.length)).length;
		const prefixWidth = numberWidth + 2;
		// Continue with the next logical phase.
		const codeWidth = Math.max(1, contentWidth - prefixWidth);
		const out: string[] = [];
		if (snippet.shellBefore) {
			out.push(
				...PythonShellSection(
					snippet.shellBefore,
					"Bash · before",
					width,
					theme,
					context.expanded,
				),
			);
		}
		out.push(PythonRule(`Python · ${snippet.label}`, width, theme));
		for (let i = 0; i < highlighted.length; i++) {
			// Continue with the next logical phase.
			const chunks = wrapTextWithAnsi(highlighted[i]!, codeWidth);
			for (let j = 0; j < Math.max(1, chunks.length); j++) {
				const prefix =
					j === 0
						? `${String(i + 1).padStart(numberWidth)}  `
						: " ".repeat(prefixWidth);
				out.push(
					PythonPanelRow(theme.fg("dim", prefix) + (chunks[j] ?? ""), width),
				);
			}
		}
		if (rawLines.length > shown.length) {
			out.push(
				PythonPanelRow(
					theme.fg(
						// Continue with the next logical phase.
						"dim",
						`… ${rawLines.length - shown.length} more code lines`,
					),
					width,
				),
			);
		}
		if (snippet.shellAfter) {
			out.push(
				...PythonShellSection(
					snippet.shellAfter,
					"Bash · after",
					width,
					theme,
					context.expanded,
				),
			);
		}
		out.push(PythonRule("Result", width, theme));
		// Continue with the next logical phase.
		return out;
	}) as Component;
}

/** Render Python output with native terminal images and a Unicode fallback.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function PythonRunRenderResult(
	result: PythonRenderResultValue,
	options: PythonRenderOptions,
	theme: PythonRenderTheme,
	context: PythonRenderContext,
): Component | undefined {
	const command = String(context.args?.command ?? "");
	const snippet =
		(context.state.pythonRunSnippet as PythonRunSnippet | undefined) ??
		PythonRunDetect(command, context.cwd);
	if (!snippet) {
  return undefined;
}

	const text =
		result.content
			?.filter((part) => part.type === "text")
			.map((part) => String(part.text ?? ""))
			.join("\n") ?? "";
	const clean = TextSanitizeTerminal(text).replace(/\n+$/, "");
	// Continue with the next logical phase.
	const nativeImages = result.content?.filter((part) => part.type === "image").length ?? 0;
	// Continue with the next logical phase.
	const isRemoteCompute = /(?:^|\s)compute\s+(?:exec|bash)\b/.test(command);
	const imagePaths = !options.isPartial && nativeImages === 0 && context.showImages && !isRemoteCompute
		? PythonFindImagePaths(clean)
		: [];
	const container = new Container();

	container.addChild(
		new LineComponent((width) => {
			if (width < 4) {
  return [truncateToWidth(clean || "(no output)", width, "")];
}
			const contentWidth = Math.max(1, width - 4);
			const rawLines = clean
				? clean.split("\n")
				// Continue with the next logical phase.
				: [options.isPartial ? "running…" : "(no output)"];
			const maxLines = context.expanded
				? PYTHON_RESULT_EXPANDED_MAX_LINES
				: PYTHON_RESULT_MAX_LINES;
			const shown = rawLines.slice(0, maxLines);
			const color = context.isError ? "error" : "toolOutput";
			const out: string[] = [];
			// Continue with the next logical phase.
			for (const line of shown) {
				const chunks = wrapTextWithAnsi(theme.fg(color, line), contentWidth);
				for (const chunk of chunks.length > 0 ? chunks : [""]) {
  out.push(PythonPanelRow(chunk, width));
}
			}
			if (rawLines.length > shown.length) {
				out.push(
					PythonPanelRow(
						theme.fg(
							"dim",
							`… ${rawLines.length - shown.length} more result lines`,
						),
						width,
					),
				);
			}
			out.push(PythonRule(options.isPartial ? "running" : "", width, theme));
			// Continue with the next logical phase.
			return out;
		}),
	);

	if (imagePaths.length > 0) {
		container.addChild(
			LocalConditionalImageStack(
				imagePaths,
				context.cwd,
				theme,
				() => options.expanded || ImageToolIsRecent(context.toolCallId ?? ""),
			),
		);
	}
	return container;
}
