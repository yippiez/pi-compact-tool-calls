/** Render local image files through native terminal protocols, Sixel, or Unicode. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	type Component,
	Container,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { SGR_RESET } from "../../constants.ts";
import { LineComponent } from "../../render.ts";
import { PythonLoadImage, type PythonImageArtifact, type PythonPixelImage } from "./python_image.ts";

// ========================================
// Constants and Types

const LOCAL_IMAGE_MAX_ROWS = 40;
const LOCAL_IMAGE_DEFAULT_WIDTH = 60;
const LOCAL_IMAGE_SIXEL_TUI_MARKER = "\x1b_Ga=q,q=2;\x1b\\";
const LOCAL_IMAGE_BG: [number, number, number] = [0, 0, 0];

type LocalImageTheme = Pick<Theme, "fg">;
export type LocalImageProtocol = "kitty" | "iterm2" | "sixel" | "unicode";

// ========================================
// Pi Width Setting

/** Read an image width from one Pi settings file.
 *
 * Example:
 * >>> LocalImageWidthFromSettings("/tmp/missing.json")
 * undefined
 */
function LocalImageWidthFromSettings(path: string): number | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"))?.terminal?.imageWidthCells;
		return typeof value === "number" && Number.isFinite(value)
			? Math.max(1, Math.floor(value))
			: undefined;
	} catch {
		return undefined;
	}
}

/** Read Pi's terminal image visibility from one settings file.
 *
 * Example:
 * >>> LocalImageShowFromSettings("/tmp/missing.json")
 * undefined
 */
function LocalImageShowFromSettings(path: string): boolean | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"))?.terminal?.showImages;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Return Pi's effective terminal image visibility for the current project.
 *
 * Example:
 * >>> LocalImagesConfiguredVisible("/tmp")
 * true
 */
export function LocalImagesConfiguredVisible(cwd: string): boolean {
	const globalShow = LocalImageShowFromSettings(join(homedir(), ".pi", "agent", "settings.json"));
	const projectShow = LocalImageShowFromSettings(join(cwd, ".pi", "settings.json"));
	return projectShow ?? globalShow ?? true;
}

/** Resolve Pi's effective configured image width for the current project.
 *
 * Example:
 * >>> LocalImageConfiguredWidth("/tmp", 80)
 * 60
 */
function LocalImageConfiguredWidth(cwd: string, availableWidth: number): number {
	const globalWidth = LocalImageWidthFromSettings(join(homedir(), ".pi", "agent", "settings.json"));
	const projectWidth = LocalImageWidthFromSettings(join(cwd, ".pi", "settings.json"));
	const configured = projectWidth ?? globalWidth ?? LOCAL_IMAGE_DEFAULT_WIDTH;
	const width = Math.max(1, Math.min(configured, Math.max(1, availableWidth - 2)));
	return width;
}

// ========================================
// Pixel and Protocol Helpers

/** Composite an RGBA pixel onto the terminal fallback background.
 *
 * Example:
 * >>> LocalImageCompositePixel(image, 0, 0)
 * [255, 0, 0]
 */
function LocalImageCompositePixel(image: PythonPixelImage, x: number, y: number): [number, number, number] {
	const offset = (Math.min(image.height - 1, y) * image.width + Math.min(image.width - 1, x)) * 4;
	const alpha = image.rgba[offset + 3]! / 255;
	return [0, 1, 2].map((channel) =>
		Math.round(image.rgba[offset + channel]! * alpha + LOCAL_IMAGE_BG[channel]! * (1 - alpha)),
	) as [number, number, number];
}

/** Calculate aspect-preserving Unicode half-block dimensions.
 *
 * Example:
 * >>> LocalImageUnicodeSize({ width: 640, height: 480, rgba }, 60)
 * { columns: 60, rows: 23 }
 */
function LocalImageUnicodeSize(image: PythonPixelImage, maxColumns: number): { columns: number; rows: number } {
	const scale = Math.min(maxColumns / image.width, (LOCAL_IMAGE_MAX_ROWS * 2) / image.height);
	return {
		columns: Math.max(1, Math.round(image.width * scale)),
		rows: Math.max(1, Math.ceil((image.height * scale) / 2)),
	};
}

/** Approximate an image with true-color Unicode half blocks.
 *
 * Example:
 * >>> LocalImageUnicodeLines(image, 60)
 * ["\x1b[38;2;..."]
 */
export function LocalImageUnicodeLines(image: PythonPixelImage, maxColumns: number): string[] {
	const { columns, rows } = LocalImageUnicodeSize(image, maxColumns);
	const lines: string[] = [];
	// Sample two source rows into each terminal half-block row.
	for (let row = 0; row < rows; row++) {
		let line = "";
		for (let column = 0; column < columns; column++) {
			const x = Math.min(image.width - 1, Math.floor(((column + 0.5) * image.width) / columns));
			const topY = Math.min(image.height - 1, Math.floor(((row * 2 + 0.5) * image.height) / (rows * 2)));
			const bottomY = Math.min(image.height - 1, Math.floor(((row * 2 + 1.5) * image.height) / (rows * 2)));
			const top = LocalImageCompositePixel(image, x, topY);
			const bottom = LocalImageCompositePixel(image, x, bottomY);
			line += `\x1b[38;2;${top.join(";")}m\x1b[48;2;${bottom.join(";")}m▀`;
		}
		lines.push(`${line}${SGR_RESET}`);
	}
	return lines;
}

/** Select the best image protocol supported by the environment.
 *
 * Example:
 * >>> LocalImageProtocolDetect({ WT_SESSION: "id" }, null)
 * "sixel"
 */
export function LocalImageProtocolDetect(
	env: Record<string, string | undefined> = process.env,
	nativeProtocol: "kitty" | "iterm2" | null = getCapabilities().images,
): LocalImageProtocol {
	if (nativeProtocol) {
		return nativeProtocol;
	}
	const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
	const term = env.TERM?.toLowerCase() ?? "";
	// Prefer explicit environment capabilities before generic TERM hints.
	if (env.WT_SESSION) {
		return "sixel";
	}
	if (env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_PANE || env.WARP_SESSION_ID) {
		return "kitty";
	}
	if (["kitty", "ghostty", "wezterm", "warpterminal", "konsole", "rio"].includes(termProgram)) {
		return "kitty";
	}
	if (env.ITERM_SESSION_ID || ["iterm.app", "vscode", "mintty"].includes(termProgram)) {
		return "iterm2";
	}
	if (term.includes("sixel") || term.startsWith("mlterm")) {
		return "sixel";
	}
	return "unicode";
}

/** Resize pixels with nearest-neighbor sampling for Sixel output.
 *
 * Example:
 * >>> LocalImageResize(image, 32, 24)
 * { width: 32, height: 24, rgba: ... }
 */
function LocalImageResize(image: PythonPixelImage, width: number, height: number): PythonPixelImage {
	if (width === image.width && height === image.height) {
		return image;
	}
	const rgba = new Uint8Array(width * height * 4);
	// Map every target pixel to the center of its nearest source sample.
	for (let y = 0; y < height; y++) {
		const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
		for (let x = 0; x < width; x++) {
			const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
			const source = (sourceY * image.width + sourceX) * 4;
			const target = (y * width + x) * 4;
			rgba[target] = image.rgba[source] ?? 0;
			rgba[target + 1] = image.rgba[source + 1] ?? 0;
			rgba[target + 2] = image.rgba[source + 2] ?? 0;
			rgba[target + 3] = image.rgba[source + 3] ?? 255;
		}
	}
	return { width, height, rgba };
}

/** Compress a repeated Sixel character.
 *
 * Example:
 * >>> LocalImageSixelRun("?", 5)
 * "!5?"
 */
function LocalImageSixelRun(character: string, count: number): string {
	return count >= 4 ? `!${count}${character}` : character.repeat(count);
}

/** Encode RGBA pixels with a compact 64-color Sixel palette.
 *
 * Example:
 * >>> LocalImageSixelEncode(image)
 * "\x1bP0;1;q..."
 */
export function LocalImageSixelEncode(image: PythonPixelImage): string {
	const colorLevels = [0, 33, 67, 100];
	const indices = new Uint8Array(image.width * image.height);
	// Quantize RGB into a fixed 64-color terminal palette.
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const color = LocalImageCompositePixel(image, x, y);
			indices[y * image.width + x] = Math.round((color[0] * 3) / 255) * 16
				+ Math.round((color[1] * 3) / 255) * 4
				+ Math.round((color[2] * 3) / 255);
		}
	}
	let output = `\x1bP0;1;q"1;1;${image.width};${image.height}`;
	// Declare the palette once before emitting six-row bands.
	for (let index = 0; index < 64; index++) {
		const red = Math.floor(index / 16);
		const green = Math.floor(index / 4) % 4;
		const blue = index % 4;
		output += `#${index};2;${colorLevels[red]};${colorLevels[green]};${colorLevels[blue]}`;
	}
	for (let bandY = 0; bandY < image.height; bandY += 6) {
		output += LocalImageSixelBand(image, indices, bandY);
		if (bandY + 6 < image.height) {
			output += "-";
		}
	}
	return `${output}\x1b\\`;
}

/** Encode one six-pixel-high Sixel band.
 *
 * Example:
 * >>> LocalImageSixelBand(image, indices, 0)
 * "#0?..."
 */
function LocalImageSixelBand(image: PythonPixelImage, indices: Uint8Array, bandY: number): string {
	const used = new Set<number>();
	for (let y = bandY; y < Math.min(image.height, bandY + 6); y++) {
		for (let x = 0; x < image.width; x++) {
			used.add(indices[y * image.width + x] ?? 0);
		}
	}
	const layers: string[] = [];
	// Encode each color as a separate overlaid bitmap layer.
	for (const color of used) {
		const masks = new Uint8Array(image.width);
		let last = -1;
		for (let x = 0; x < image.width; x++) {
			let mask = 0;
			// Fold six vertical pixels into one printable Sixel character.
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
		// Omit trailing empty columns from each color layer.
		layers.push(LocalImageSixelLayer(color, masks, last));
	}
	const band = layers.join("$");
	return band;
}

/** Encode one palette layer within a Sixel band.
 *
 * Example:
 * >>> LocalImageSixelLayer(1, masks, 4)
 * "#1..."
 */
function LocalImageSixelLayer(color: number, masks: Uint8Array, last: number): string {
	let layer = `#${color}`;
	let runCharacter = "";
	let runLength = 0;
	// Run-length encode repeated six-bit column masks.
	for (let x = 0; x <= last; x++) {
		const character = String.fromCharCode(63 + (masks[x] ?? 0));
		if (character === runCharacter) {
			runLength++;
		} else {
			if (runLength > 0) {
				layer += LocalImageSixelRun(runCharacter, runLength);
			}
			runCharacter = character;
			runLength = 1;
		}
	}
	if (runLength > 0) {
		layer += LocalImageSixelRun(runCharacter, runLength);
	}
	return layer;
}

/** Wrap terminal graphics for tmux passthrough.
 *
 * Example:
 * >>> LocalImageTmuxPassthrough("\x1bP...", { TMUX: "/tmp/tmux" })
 * "\x1bPtmux;..."
 */
export function LocalImageTmuxPassthrough(
	sequence: string,
	env: Record<string, string | undefined> = process.env,
): string {
	if (!env.TMUX && !env.TMUX_PANE) {
		return sequence;
	}
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Calculate native terminal rows and columns with a 40-row cap.
 *
 * Example:
 * >>> LocalImageCellSize({ widthPx: 640, heightPx: 480 }, 60)
 * { columns: 60, rows: 27 }
 */
function LocalImageCellSize(
	dimensions: { widthPx: number; heightPx: number },
	maxWidth: number,
): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const scale = Math.min(
		(maxWidth * cell.widthPx) / Math.max(1, dimensions.widthPx),
		(LOCAL_IMAGE_MAX_ROWS * cell.heightPx) / Math.max(1, dimensions.heightPx),
	);
	return {
		columns: Math.max(1, Math.min(maxWidth, Math.ceil((dimensions.widthPx * scale) / cell.widthPx))),
		rows: Math.max(1, Math.min(LOCAL_IMAGE_MAX_ROWS, Math.ceil((dimensions.heightPx * scale) / cell.heightPx))),
	};
}

// ========================================
// Components

/** Native or Sixel terminal image component with stable protocol output. */
class LocalTerminalImage implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly imageId = allocateImageId();

	constructor(
		private readonly image: PythonImageArtifact,
		private readonly protocol: Exclude<LocalImageProtocol, "unicode">,
		private readonly cwd: string,
	) {}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	/** Render a native terminal image sequence and reserve its rows.
	 *
	 * Example:
	 * >>> component.render(80)
	 * ["\x1b_G...", "", ...]
	 */
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const data = this.protocol === "kitty" ? this.image.pngData : this.image.data;
		const mimeType = this.protocol === "kitty" ? "image/png" : this.image.mimeType;
		if (!data || !mimeType) {
			return ["Error: image payload is unavailable"];
		}
		// Resolve dimensions and fit the image to Pi's width plus pchain's row cap.
		const dimensions = this.image.pixels
			? { widthPx: this.image.pixels.width, heightPx: this.image.pixels.height }
			: getImageDimensions(data, mimeType);
		if (!dimensions) {
			return [`Error: image dimensions are unavailable: ${basename(this.image.path)}`];
		}
		const size = LocalImageCellSize(dimensions, LocalImageConfiguredWidth(this.cwd, width));
		// Encode only the selected terminal protocol and retain stable image identifiers.
		let sequence = this.protocol === "kitty"
			? encodeKitty(data, { columns: size.columns, rows: size.rows, imageId: this.imageId, moveCursor: false })
			: this.protocol === "iterm2"
				? encodeITerm2(data, { width: size.columns, height: "auto", preserveAspectRatio: true })
				: LocalImageSixelSequence(this.image.pixels!, dimensions, size);
		sequence = LocalImageTmuxPassthrough(sequence);
		this.cachedLines = LocalImageSequenceLines(sequence, size.rows, this.protocol);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

/** Build a resized Sixel sequence for the chosen cell dimensions.
 *
 * Example:
 * >>> LocalImageSixelSequence(pixels, dimensions, size)
 * "\x1b7\x1bP..."
 */
function LocalImageSixelSequence(
	pixels: PythonPixelImage,
	dimensions: { widthPx: number; heightPx: number },
	size: { columns: number; rows: number },
): string {
	const cell = getCellDimensions();
	const scale = Math.min(
		(size.columns * cell.widthPx) / dimensions.widthPx,
		(size.rows * cell.heightPx) / dimensions.heightPx,
	);
	const resized = LocalImageResize(
		pixels,
		Math.max(1, Math.round(dimensions.widthPx * scale)),
		Math.max(1, Math.round(dimensions.heightPx * scale)),
	);
	return `\x1b7${LocalImageSixelEncode(resized)}\x1b8`;
}

/** Reserve terminal rows around one graphics control sequence.
 *
 * Example:
 * >>> LocalImageSequenceLines(sequence, 3, "kitty")
 * [sequence, "", ""]
 */
function LocalImageSequenceLines(
	sequence: string,
	rows: number,
	protocol: Exclude<LocalImageProtocol, "unicode">,
): string[] {
	if (protocol === "kitty") {
		return [sequence, ...Array.from({ length: rows - 1 }, () => "")];
	}
	const offset = rows - 1;
	const moveUp = offset > 0 ? `\x1b[${offset}A` : "";
	const moveDown = offset > 0 ? `\x1b[${offset}B` : "";
	const marker = protocol === "sixel" ? LOCAL_IMAGE_SIXEL_TUI_MARKER : "";
	return [...Array.from({ length: Math.max(0, rows - 1) }, () => ""), `${marker}${moveUp}${sequence}${moveDown}`];
}

/** Build one visible component for an image artifact or its error.
 *
 * Example:
 * >>> LocalImageArtifactComponent(artifact, theme, "/tmp")
 * Component
 */
function LocalImageArtifactComponent(
	artifact: PythonImageArtifact,
	theme: LocalImageTheme,
	cwd: string,
): Component {
	if (artifact.error) {
		return new Text(theme.fg("error", artifact.error), 0, 0);
	}
	const protocol = LocalImageProtocolDetect();
	if (protocol === "unicode") {
		return new LineComponent((width) => LocalImageUnicodeLines(artifact.pixels!, LocalImageConfiguredWidth(cwd, width)));
	}
	if (protocol === "kitty" && !artifact.pngData) {
		return new Text(theme.fg("error", `Error: image could not be converted for Kitty: ${artifact.path}`), 0, 0);
	}
	return new LocalTerminalImage(artifact, protocol, cwd);
}

/** Render local paths vertically with one blank line between images.
 *
 * Example:
 * >>> LocalImageStack(["a.png", "b.png"], "/tmp", theme)
 * Container
 */
export function LocalImageStack(paths: string[], cwd: string, theme: LocalImageTheme): Component {
	const container = new Container();
	for (let index = 0; index < paths.length; index++) {
		if (index > 0) {
			container.addChild(new Spacer(1));
		}
		container.addChild(LocalImageArtifactComponent(PythonLoadImage(paths[index]!, cwd), theme, cwd));
	}
	return container;
}

/** Lazily retain an image stack only while its turn is visible.
 *
 * Example:
 * >>> LocalConditionalImageStack(["plot.png"], "/tmp", theme, () => true)
 * Component
 */
export function LocalConditionalImageStack(
	paths: string[],
	cwd: string,
	theme: LocalImageTheme,
	visible: () => boolean,
): Component {
	let stack: Component | undefined;
	return {
		invalidate() {
			stack?.invalidate();
		},
		/** Render and release the stack as turn visibility changes.
		 *
		 * Example:
		 * >>> component.render(80)
		 * ["..."]
		 */
		render(width: number): string[] {
			if (!visible()) {
				stack = undefined;
				return [];
			}
			stack ??= LocalImageStack(paths, cwd, theme);
			return stack.render(width);
		},
	};
}
