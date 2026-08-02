/** Shared terminal-line transforms and the Pi component adapter for them. */
import { visibleWidth as piTuiVisibleWidth, type Component } from "@earendil-works/pi-tui";


// ========================================
// Renderer

/** Render lines by delegating to a draw callback.

    Example:
        >>> const r = new LineComponent((w) => [`line at ${w} cols`])
 */
export class LineComponent implements Component {
	constructor(private readonly draw: (width: number) => string[]) {}

	/** Mark the renderer as invalid (no-op for this simple implementation). */
	invalidate() {}

	/** Render lines for the given terminal width.
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	render(width: number): string[] {
		return this.draw(width);
	}
}


// ========================================
// Display Width Slicing

/** Return a display-column slice of text starting at startCols, no wider than width.

    Args:
        text: The source string to slice.
        startCols: Display columns to skip from the start.
        width: Maximum display width of the returned slice.

    Returns:
        The sliced substring measured in display columns.

    Example:
        >>> RenderSliceDisplayWidth("hello world", 6, 5)
        "world"
 */
export function RenderSliceDisplayWidth(text: string, startCols: number, width: number): string {
	let col = 0;
	let out = "";

	// Walk code units, tracking display columns
	for (const ch of text) {
		const cw = piTuiVisibleWidth(ch) || 1;

		// Skip characters before the slice start column
		if (col + cw <= startCols) {
			col += cw;
			continue;
		}

		// Stop once the slice reaches the requested width
		if (piTuiVisibleWidth(out) + cw > width) {
			break;
		}
		out += ch;
		col += cw;
	}
	return out;
}


// ========================================
// Background Fill

/** Pad content to the full width and paint a background color across the line.

    Re-opens the background sequence after any SGR reset so the background
    never drops mid-line.

    Args:
        content: The text to paint across the row.
        width: Total display width of the line.
        bg: ANSI background sequence to apply.
        sgrReset: ANSI reset sequence used to re-open the background after resets.

    Returns:
        The padded, background-painted line string.

    Example:
        >>> RenderBgFillLine("hello", 10, "\\x1b[48;2;42;42;42m")
        "  hello   "  (padded and bg-painted)
 */
export function RenderBgFillLine(content: string, width: number, bg: string = "\x1b[48;2;42;42;42m", sgrReset: string = "\x1b[0m"): string {
	// Pad content to the full line width
	const pad = Math.max(0, width - piTuiVisibleWidth(content));
	const filled = content + " ".repeat(pad);

	// Re-apply bg after any inline SGR resets
	const persistent = filled.replace(/\x1b\[0m/g, sgrReset + bg);
	return bg + persistent + sgrReset;
}


/** Paint one terminal row from left-to-right segments, each with its own background.

    Args:
        segments: Left-to-right segments with content, width, and bg per segment.
        totalWidth: Full line width including any tail padding.
        sgrReset: ANSI reset appended at the end of the row.

    Returns:
        The concatenated, background-painted line.

    Example:
        >>> RenderBgFillSegments([{ content: "hi", width: 5, bg: "\\x1b[48;2;0;0;0m" }], 10)
 * undefined
 */
export function RenderBgFillSegments(
	segments: { content: string; width: number; bg: string }[],
	totalWidth: number,
	sgrReset: string = "\x1b[0m",
): string {
	let out = "";
	let used = 0;

	// Paint each segment at its allotted width
	for (const seg of segments) {
		const pad = Math.max(0, seg.width - piTuiVisibleWidth(seg.content));
		const filled = seg.content + " ".repeat(pad);
		const persistent = filled.replace(/\x1b\[0m/g, sgrReset + seg.bg);
		out += seg.bg + persistent;
		used += seg.width;
	}

	// Fill any unused tail columns
	const tail = Math.max(0, totalWidth - used);
	if (tail > 0) {
		out += " ".repeat(tail);
	}
	return out + sgrReset;
}


/** Paint a prefix, chip, and tail with independent row backgrounds.

    Args:
        prefix: Content painted with the surrounding panel background.
        chipContent: Content painted with the chip background.
        chipBg: ANSI background sequence for the chip.
        panelBg: ANSI background sequence for the prefix and tail.
        width: Full row width in display columns.
        sgrReset: ANSI reset appended at the end of the row.

    Returns:
        One full-width painted terminal line.

    Example:
        >>> RenderChipBgLine("● ", "code", chipBg, panelBg, 20)
        "● code              "
 */
export function RenderChipBgLine(
	prefix: string,
	chipContent: string,
	chipBg: string,
	panelBg: string,
	width: number,
	sgrReset: string = "\x1b[0m",
): string {
	const prefixWidth = piTuiVisibleWidth(prefix);
	const chipWidth = piTuiVisibleWidth(chipContent);
	const segments = [
		{ content: prefix, width: prefixWidth, bg: panelBg },
		{ content: chipContent, width: chipWidth, bg: chipBg },
	];

	// Keep the chip background local; paint the remaining row as panel chrome.
	const tailWidth = Math.max(0, width - prefixWidth - chipWidth);
	if (tailWidth > 0) {
  segments.push({ content: "", width: tailWidth, bg: panelBg });
}
	return RenderBgFillSegments(segments, width, sgrReset);
}


// ========================================
// Border Rendering

/** Build a horizontal border line with optional left and right labels.

    Args:
        left: Label placed after the leading border character.
        right: Label placed before the trailing border character.
        width: Total display width of the border line.
        border: Styler for border characters.
        fill: Optional styler for the gap fill; defaults to border.

    Returns:
        A single border line string with labels and fill.

    Example:
        >>> RenderFitBorder(" left ", " right ", 40, dim)
        "─ left ────────────────── right ─"
 */
export function RenderFitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill?: (text: string) => string,
): string {
	const fillFn = fill ?? border;

	// Handle degenerate widths early
	if (width <= 0) {
		return "";
	}
	if (width === 1) {
		return border("─");
	}

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	// Measure label widths and track overflow past the line budget
	let leftWidth = piTuiVisibleWidth(leftText);
	let rightWidth = piTuiVisibleWidth(rightText);
	let totalLabelWidth = fixedWidth + leftWidth + rightWidth + minimumGap;
	let labelsOverflow = totalLabelWidth > width;

	// Shrink the right label first, then the left
	while (labelsOverflow && rightWidth > 0) {
		rightText = RenderTruncateToWidth(rightText, Math.max(0, rightWidth - 1), "");
		rightWidth = piTuiVisibleWidth(rightText);
		totalLabelWidth = fixedWidth + leftWidth + rightWidth + minimumGap;
		labelsOverflow = totalLabelWidth > width;
	}
	while (labelsOverflow && leftWidth > 0) {
		leftText = RenderTruncateToWidth(leftText, Math.max(0, leftWidth - 1), "");
		leftWidth = piTuiVisibleWidth(leftText);
		totalLabelWidth = fixedWidth + leftWidth + rightWidth + minimumGap;
		labelsOverflow = totalLabelWidth > width;
	}

	// Assemble border characters, labels, and fill
	const gapWidth = Math.max(0, width - fixedWidth - leftWidth - rightWidth);
	return `${border("─")}${leftText}${fillFn("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

/** Build a horizontal border with labels at both ends and one centered label.
 *
 * Example:
 * >>> RenderFitBorderCenter(" left ", " middle ", " right ", 40, (text) => text)
 * "─ left ───── middle ───── right ─"
 */
export function RenderFitBorderCenter(
	left: string,
	center: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill?: (text: string) => string,
): string {
	const fillFn = fill ?? border;
	if (width <= 0) {
		return "";
	}
	if (width === 1) {
		return border("─");
	}
	if (!center) {
		return RenderFitBorder(left, right, width, border, fillFn);
	}

	// Reserve the two edge rules and trim the least important labels until every segment fits.
	let leftText = left;
	let centerText = center;
	let rightText = right;
	// Cache display widths so each loop condition is data-only and each trim updates one label at a time.
	let leftWidth = piTuiVisibleWidth(leftText);
	let centerWidth = piTuiVisibleWidth(centerText);
	let rightWidth = piTuiVisibleWidth(rightText);
	let labelsWidth = 2 + leftWidth + centerWidth + rightWidth;
	// Prefer preserving the centered response status over the right context label.
	while (labelsWidth > width && rightWidth > 0) {
		rightText = RenderTruncateToWidth(rightText, Math.max(0, rightWidth - 1), "");
		rightWidth = piTuiVisibleWidth(rightText);
		labelsWidth = 2 + leftWidth + centerWidth + rightWidth;
	}
	// If needed, shrink the path label before sacrificing the response status.
	while (labelsWidth > width && leftWidth > 0) {
		leftText = RenderTruncateToWidth(leftText, Math.max(0, leftWidth - 1), "");
		leftWidth = piTuiVisibleWidth(leftText);
		labelsWidth = 2 + leftWidth + centerWidth + rightWidth;
	}
	// Only narrow the center label once neither edge can give it more room.
	while (labelsWidth > width && centerWidth > 0) {
		centerText = RenderTruncateToWidth(centerText, Math.max(0, centerWidth - 1), "");
		centerWidth = piTuiVisibleWidth(centerText);
		labelsWidth = 2 + leftWidth + centerWidth + rightWidth;
	}

	// Position the status at the physical center of the line, assigning the remaining rule to either side.
	const fillWidth = Math.max(0, width - labelsWidth);
	const desiredStart = Math.floor((width - centerWidth) / 2);
	const before = Math.min(fillWidth, Math.max(0, desiredStart - 1 - leftWidth));
	const after = fillWidth - before;
	return `${border("─")}${leftText}${fillFn("─".repeat(before))}${centerText}${fillFn("─".repeat(after))}${rightText}${border("─")}`;
}


// ========================================
// Color

/** Compute a stable hue from a name string for consistent color mapping.

    Args:
        name: The label or tool name to hash.

    Returns:
        A hue value in the range 0–359.

    Example:
        >>> RenderHueFromName("read")
        247
 */
function RenderHueFromName(name: string): number {
	// Hash code units with a rolling polynomial
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
	}

	// Map into hue degrees
	return h % 360;
}


/** Convert HSL color values to an RGB triple.

    Args:
        h: Hue in degrees (0–360).
        s: Saturation (0–1).
        l: Lightness (0–1).

    Returns:
        An [r, g, b] tuple with each channel 0–255.

    Example:
        >>> RenderHslToRgb(0, 1, 0.5)
        [255, 0, 0]
 */
function RenderHslToRgb(h: number, s: number, l: number): [number, number, number] {
	// Convert HSL to RGB in the standard hexagon model
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;

	// Pick the sector and scale to byte values
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}


/** Return a bold, truecolor ANSI string for a label, colored by a stable hue from name.

    Args:
        name: The key used to derive a stable hue.
        label: The display text to paint.

    Returns:
        A bold truecolor ANSI-wrapped label string.

    Example:
        >>> RenderColorName("bash", "Bash")
        "\\x1b[1;38;2;0;165;81mBash\\x1b[22;39m"
 */
export function RenderColorName(name: string, label: string): string {
	// Stable hue at fixed saturation and lightness
	const [r, g, b] = RenderHslToRgb(RenderHueFromName(name), 0.62, 0.65);

	// Wrap label in bold truecolor ANSI
	return `\x1b[1;38;2;${r};${g};${b}m${label}\x1b[22;39m`;
}


// ========================================
// Internal Helpers

/** Truncate a string to a maximum display width, appending an ellipsis marker if truncated.

    Example:
        >>> RenderTruncateToWidth("hello world", 5, "…")
        "hello…"
 */
function RenderTruncateToWidth(text: string, maxWidth: number, ellipsis: string): string {
	// Find the last code unit that still fits maxWidth
	let w = 0;
	let end = 0;
	for (const ch of text) {
		const cw = piTuiVisibleWidth(ch) || 1;
		if (w + cw > maxWidth && end > 0) {
			break;
		}
		w += cw;
		end++;
	}

	// Return unchanged text or append the ellipsis marker
	if (end >= text.length) {
		return text;
	}
	const kept = text.slice(0, end);
	return ellipsis === "" ? kept : kept + ellipsis;
}
