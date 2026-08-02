/** Native inline text/chip model for plain outline nodes. */

export type NodeInlineElement =
	| { kind: "text"; text: string }
	| { kind: "file"; ref: string }
	| { kind: "skill"; name: string }
	| { kind: "pasted"; text: string };

export type NodeInlineChip = Extract<NodeInlineElement, { kind: "file" | "skill" | "pasted" }>;

type NodeInlineCursorTarget =
	| { kind: "text"; index: number; offset: number }
	| { kind: "chip"; index: number; chip: NodeInlineChip };

const INLINE_REFERENCE = /(?:^|[\s(])(?:@(?:"(?<quotedFile>(?:\\.|[^"\\])*)"|(?<file>[^\s`"'<>]+))|\$(?<skill>[a-z0-9](?:[a-z0-9-]{0,63})))(?![a-z0-9_-])/g;

/** Ensure chips always have text elements on both sides and merge adjacent text. */
export function NodeInlineNormalize(elements: NodeInlineElement[]): NodeInlineElement[] {
	const out: NodeInlineElement[] = [];
	const pushText = (text: string) => {
		const last = out[out.length - 1];
		if (last?.kind === "text") { last.text += text; }
		else { out.push({ kind: "text", text }); }
	};
	for (const element of elements) {
		if (element.kind === "text") { pushText(element.text); }
		else {
			if (out.length === 0 || out[out.length - 1]?.kind !== "text") {
  pushText("");
}
			out.push({ ...element });
			pushText("");
		}
	}
	if (out.length === 0) {
  out.push({ kind: "text", text: "" });
}
	if (out[0]?.kind !== "text") {
  out.unshift({ kind: "text", text: "" });
}
	if (out[out.length - 1]?.kind !== "text") {
  out.push({ kind: "text", text: "" });
}
	return out;
}

/** Parse persisted/composed plain text into text, @file chips, and $skill chips. */
export function NodeInlineFromText(text: string): NodeInlineElement[] {
	const elements: NodeInlineElement[] = [];
	let at = 0;
	for (const match of text.matchAll(INLINE_REFERENCE)) {
		const full = match[0] ?? "";
		const skillName = match.groups?.skill;
		const marker = full.lastIndexOf(skillName ? "$" : "@");
		const start = (match.index ?? 0) + marker;
		if (start > at) {
  elements.push({ kind: "text", text: text.slice(at, start) });
}
		if (skillName) {
			elements.push({ kind: "skill", name: skillName });
		} else {
			const raw = match.groups?.quotedFile ?? match.groups?.file ?? "";
			elements.push({ kind: "file", ref: raw.replace(/\\([\\" ])/g, "$1") });
		}
		at = (match.index ?? 0) + full.length;
	}
	if (at < text.length || elements.length === 0) {
  elements.push({ kind: "text", text: text.slice(at) });
}
	return NodeInlineNormalize(elements);
}

/** Promote @file and $skill references inside text elements while preserving existing chips. */
export function NodeInlinePromoteReferences(elements: NodeInlineElement[]): NodeInlineElement[] {
	const out: NodeInlineElement[] = [];
	for (const element of elements) {
		if (element.kind === "text") { out.push(...NodeInlineFromText(element.text)); }
		else { out.push({ ...element }); }
	}
	return NodeInlineNormalize(out);
}

/** Deep clone inline elements. */
export function NodeInlineClone(elements: NodeInlineElement[] | undefined): NodeInlineElement[] {
	return NodeInlineNormalize((elements ?? [{ kind: "text", text: "" }]).map((element) => ({ ...element })));
}

/** Serialize text, file chips, and skill chips to the node's prompt line; pasted chips are blocks.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineText(elements: NodeInlineElement[]): string {
	return elements.map((element) => {
		if (element.kind === "text") {
  return element.text;
}
		if (element.kind === "file") {
  return /\s/.test(element.ref) ? `@"${element.ref.replaceAll('"', '\\"')}"` : `@${element.ref}`;
}
		if (element.kind === "skill") {
  return `$${element.name}`;
}
		return "";
	}).join("");
}

/** Plain cursor projection used for visual row calculations (two cells per chip).
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineProjection(elements: NodeInlineElement[]): string {
	return elements.map((element) => element.kind === "text" ? element.text : "  ").join("");
}

/** Cursor-stop length. Every chip contributes a focus stop between left/right boundaries.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineLength(elements: NodeInlineElement[]): number {
	let length = 0;
	for (const element of elements) {
  length += element.kind === "text" ? element.text.length : 2;
}
	return length;
}

/** Resolve a scalar cursor stop to either a text offset or a chip itself.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineResolve(elements: NodeInlineElement[], rawCol: number): NodeInlineCursorTarget {
	const normalized = NodeInlineNormalize(elements);
	const col = Math.max(0, Math.min(rawCol, NodeInlineLength(normalized)));
	let base = 0;
	for (let index = 0; index < normalized.length; index++) {
		const element = normalized[index]!;
		if (element.kind === "text") {
			const end = base + element.text.length;
			if (col <= end) {
  return { kind: "text", index, offset: col - base };
}
			base = end;
		} else {
			if (col === base + 1) {
  // Continue with the next logical phase.
  return { kind: "chip", index, chip: element };
}
			base += 2;
		}
	}
	// Continue with the next logical phase.
	const index = normalized.length - 1;
	const text = normalized[index] as Extract<NodeInlineElement, { kind: "text" }>;
	return { kind: "text", index, offset: text.text.length };
}

/** Find the scalar cursor stop for a text element offset.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineTextCursor(elements: NodeInlineElement[], index: number, offset: number): number {
	let col = 0;
	for (let i = 0; i < elements.length; i++) {
		const element = elements[i]!;
		if (i === index && element.kind === "text") {
  return col + Math.max(0, Math.min(offset, element.text.length));
}
		col += element.kind === "text" ? element.text.length : 2;
	}
	return col;
}

/** Insert text at a native text cursor. Chip focus inserts into the text to its right.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineInsert(elements: NodeInlineElement[], col: number, value: string): { elements: NodeInlineElement[]; col: number } {
	const out = NodeInlineClone(elements);
	let target = NodeInlineResolve(out, col);
	if (target.kind === "chip") {
		const right = target.index + 1;
		target = { kind: "text", index: right, offset: 0 };
	}
	const text = out[target.index] as Extract<NodeInlineElement, { kind: "text" }>;
	text.text = text.text.slice(0, target.offset) + value + text.text.slice(target.offset);
	return { elements: out, col: NodeInlineTextCursor(out, target.index, target.offset + value.length) };
}

/** Insert a chip at the caret, splitting the current text element natively.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineInsertChip(elements: NodeInlineElement[], col: number, chip: NodeInlineChip): { elements: NodeInlineElement[]; col: number } {
	const out = NodeInlineClone(elements);
	const resolved = NodeInlineResolve(out, col);
	const target = resolved.kind === "chip"
		? { kind: "text" as const, index: resolved.index + 1, offset: 0 }
		: resolved;
	const text = out[target.index] as Extract<NodeInlineElement, { kind: "text" }>;
	const replacement: NodeInlineElement[] = [
		{ kind: "text", text: text.text.slice(0, target.offset) },
		{ ...chip },
		{ kind: "text", text: text.text.slice(target.offset) },
	];
	out.splice(target.index, 1, ...replacement);
	const normalized = NodeInlineNormalize(out);
	// Continue with the next logical phase.
	const focus = NodeInlineTextCursor(normalized, target.index, target.offset) + 1;
	return { elements: normalized, col: focus };
}

/** Split inline elements at a text boundary; chip focus splits before the chip.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineSplit(elements: NodeInlineElement[], col: number): { left: NodeInlineElement[]; right: NodeInlineElement[] } {
	const source = NodeInlineClone(elements);
	const target = NodeInlineResolve(source, col);
	if (target.kind === "chip") {
		return {
			left: NodeInlineNormalize(source.slice(0, target.index)),
			right: NodeInlineNormalize(source.slice(target.index)),
		};
	}
	const text = source[target.index] as Extract<NodeInlineElement, { kind: "text" }>;
	return {
		left: NodeInlineNormalize([
			...source.slice(0, target.index),
			{ kind: "text", text: text.text.slice(0, target.offset) },
		]),
		right: NodeInlineNormalize([
			// Continue with the next logical phase.
			{ kind: "text", text: text.text.slice(target.offset) },
			...source.slice(target.index + 1),
		]),
	};
}

/** Delete backward using native text/chip boundaries.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineBackspace(elements: NodeInlineElement[], col: number): { elements: NodeInlineElement[]; col: number } {
	const out = NodeInlineClone(elements);
	const target = NodeInlineResolve(out, col);
	if (target.kind === "chip") {
		out.splice(target.index, 1);
		return { elements: NodeInlineNormalize(out), col: Math.max(0, col - 1) };
	}
	const text = out[target.index] as Extract<NodeInlineElement, { kind: "text" }>;
	if (target.offset > 0) {
		text.text = text.text.slice(0, target.offset - 1) + text.text.slice(target.offset);
		return { elements: out, col: col - 1 };
	}
	const previous = out[target.index - 1];
	if (previous && previous.kind !== "text") {
		out.splice(target.index - 1, 1);
		// Continue with the next logical phase.
		return { elements: NodeInlineNormalize(out), col: Math.max(0, col - 2) };
	}
	return { elements: out, col };
}

/** Delete forward using native text/chip boundaries.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineDelete(elements: NodeInlineElement[], col: number): { elements: NodeInlineElement[]; col: number } {
	const out = NodeInlineClone(elements);
	const target = NodeInlineResolve(out, col);
	if (target.kind === "chip") {
		out.splice(target.index, 1);
		return { elements: NodeInlineNormalize(out), col: Math.max(0, col - 1) };
	}
	const text = out[target.index] as Extract<NodeInlineElement, { kind: "text" }>;
	if (target.offset < text.text.length) {
		text.text = text.text.slice(0, target.offset) + text.text.slice(target.offset + 1);
		return { elements: out, col };
	}
	const next = out[target.index + 1];
	if (next && next.kind !== "text") {
  out.splice(target.index + 1, 1);
}
	// Continue with the next logical phase.
	return { elements: NodeInlineNormalize(out), col };
}

/** Return each chip with its native focus cursor stop.
 *
 * Example:
 * >>> undefined
 * undefined
 */
export function NodeInlineChipEntries(elements: NodeInlineElement[]): Array<{ chip: NodeInlineChip; col: number }> {
	const out: Array<{ chip: NodeInlineChip; col: number }> = [];
	let col = 0;
	for (const element of elements) {
		if (element.kind === "text") { col += element.text.length; }
		else {
			out.push({ chip: element, col: col + 1 });
			col += 2;
		}
	}
	return out;
}

type NodeInlineChipOf<K> = K extends NodeInlineChip["kind"]
	? Extract<NodeInlineChip, { kind: K }>
	: NodeInlineChip;

/** Return chips in source order, narrowed when a chip kind is requested. */
export function NodeInlineChips<K extends NodeInlineChip["kind"] | undefined = undefined>(
	elements: NodeInlineElement[],
	kind?: K,
): Array<NodeInlineChipOf<K>> {
	return elements.filter(
		(element): element is NodeInlineChip =>
			element.kind !== "text" && (!kind || element.kind === kind),
	) as Array<NodeInlineChipOf<K>>;
}
