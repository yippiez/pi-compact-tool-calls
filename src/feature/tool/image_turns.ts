/** Track recent conversation turns and render assistant Markdown image references. */
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { LocalConditionalImageStack, LocalImagesConfiguredVisible } from "./local_image_renderer.ts";

// ========================================
// State and Types

const IMAGE_TURN_COUNT = 3;
const MARKDOWN_IMAGE_ENTRY = "pchain-markdown-images";
const MARKDOWN_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

interface MarkdownImageEntry {
	paths: string[];
	turnId: string;
	cwd: string;
}

let recentTurnIds = new Set<string>();
let recentToolIds = new Set<string>();
let recentTurnQueue: string[] = [];
let recentToolTurns = new Map<string, string>();
let currentTurnId: string | undefined;

// ========================================
// Turn Tracking

/** Rebuild recent turn and tool-call indexes from the active session branch.
 *
 * Example:
 * >>> ImageTurnsRefresh(entries)
 * undefined
 */
export function ImageTurnsRefresh(entries: SessionEntry[]): void {
	const turns: string[] = [];
	const tools = new Map<string, string>();
	let turnId: string | undefined;
	// Walk the active branch once, assigning every assistant tool to its user turn.
	for (const entry of entries) {
		if (entry.type !== "message") {
			continue;
		}
		if (entry.message.role === "user") {
			turnId = entry.id;
			turns.push(turnId);
			continue;
		}
		if (entry.message.role !== "assistant" || !turnId) {
			continue;
		}
		for (const part of entry.message.content) {
			if (part.type === "toolCall") {
				tools.set(part.id, turnId);
			}
		}
	}
	// Keep actual conversation turns, including turns without image-producing tools.
	recentTurnQueue = turns.slice(-IMAGE_TURN_COUNT);
	recentTurnIds = new Set(recentTurnQueue);
	recentToolTurns = new Map([...tools].filter(([, id]) => recentTurnIds.has(id)));
	recentToolIds = new Set(recentToolTurns.keys());
	currentTurnId = recentTurnQueue.at(-1);
}

/** Advance the recent-turn window without rescanning the historical branch.
 *
 * Example:
 * >>> ImageRememberTurn("turn-1")
 * undefined
 */
function ImageRememberTurn(turnId: string): void {
	// Record the active turn while avoiding duplicate queue entries.
	currentTurnId = turnId;
	if (recentTurnIds.has(turnId)) {
		return;
	}
	// Extend the bounded recent-turn window.
	recentTurnQueue.push(turnId);
	recentTurnIds.add(turnId);
	if (recentTurnQueue.length <= IMAGE_TURN_COUNT) {
		return;
	}
	const expiredTurnId = recentTurnQueue.shift();
	if (!expiredTurnId) {
		return;
	}
	// Prune only tools owned by the turn that just expired.
	recentTurnIds.delete(expiredTurnId);
	for (const [toolCallId, ownerTurnId] of recentToolTurns) {
		if (ownerTurnId === expiredTurnId) {
			recentToolTurns.delete(toolCallId);
			recentToolIds.delete(toolCallId);
		}
	}
}

/** Associate a new tool call with the current turn in constant time.
 *
 * Example:
 * >>> ImageRememberTool("call-1")
 * undefined
 */
function ImageRememberTool(toolCallId: string): void {
	if (!currentTurnId) {
		return;
	}
	recentToolTurns.set(toolCallId, currentTurnId);
	recentToolIds.add(toolCallId);
}

/** Return whether a tool belongs to the latest three conversation turns.
 *
 * Example:
 * >>> ImageToolIsRecent("call-1")
 * false
 */
export function ImageToolIsRecent(toolCallId: string): boolean {
	const recent = recentToolIds.has(toolCallId);
	return recent;
}

/** Return whether a session turn is among the latest three.
 *
 * Example:
 * >>> ImageTurnIsRecent("entry-1")
 * false
 */
function ImageTurnIsRecent(turnId: string): boolean {
	const recent = recentTurnIds.has(turnId);
	return recent;
}

// ========================================
// Markdown Extraction

/** Accept only plain local static-image paths.
 *
 * Example:
 * >>> MarkdownImagePath("plots/result.png", "/tmp")
 * "/tmp/plots/result.png"
 */
function MarkdownImagePath(reference: string, cwd: string): string | undefined {
	let decoded = reference.trim();
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		// Keep malformed percent escapes literal so the renderer reports a local error.
	}
	if (!decoded || decoded.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
		return undefined;
	}
	if (!MARKDOWN_IMAGE_EXTENSIONS.has(extname(decoded).toLowerCase())) {
		return undefined;
	}
	return isAbsolute(decoded) ? decoded : resolve(cwd, decoded);
}

/** Parse Markdown reference definitions by case-insensitive label.
 *
 * Example:
 * >>> MarkdownImageDefinitions("[plot]: out.png")
 * Map { "plot" => "out.png" }
 */
function MarkdownImageDefinitions(markdown: string): Map<string, string> {
	const definitions = new Map<string, string>();
	for (const match of markdown.matchAll(/^\s*\[([^\]]+)]\s*:\s*(?:<([^>]+)>|(\S+))/gim)) {
		const label = match[1]?.trim().toLowerCase();
		const path = match[2] ?? match[3];
		if (label && path) {
			definitions.set(label, path);
		}
	}
	return definitions;
}

/** Mask code spans while preserving source indexes for image ordering.
 *
 * Example:
 * >>> MarkdownImageSearchText("`![x](ignored.png)`")
 * "                    "
 */
function MarkdownImageSearchText(markdown: string): string {
	const searchable = markdown.replace(/(```|~~~)[\s\S]*?\1|`[^`\n]*`/g, (code) => code.replace(/[^\n]/g, " "));
	return searchable;
}

/** Extract inline and reference-style image paths in source order.
 *
 * Example:
 * >>> MarkdownImagePaths("![plot](out.png)", "/tmp")
 * ["/tmp/out.png"]
 */
export function MarkdownImagePaths(markdown: string, cwd: string): string[] {
	const searchable = MarkdownImageSearchText(markdown);
	const definitions = MarkdownImageDefinitions(searchable);
	const found: Array<{ index: number; path: string }> = [];
	// Collect inline image destinations.
	for (const match of searchable.matchAll(/!\[[^\]]*]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
		if (match.index === undefined) {
			continue;
		}
		const path = MarkdownImagePath(match[1] ?? match[2] ?? "", cwd);
		if (path) {
			found.push({ index: match.index, path });
		}
	}
	// Resolve reference-style image destinations through their definitions.
	for (const match of searchable.matchAll(/!\[([^\]]*)]\[([^\]]*)]/g)) {
		if (match.index === undefined) {
			continue;
		}
		const label = (match[2] || match[1] || "").trim().toLowerCase();
		const reference = definitions.get(label);
		const path = reference ? MarkdownImagePath(reference, cwd) : undefined;
		if (path) {
			found.push({ index: match.index, path });
		}
	}
	// Restore source order across both Markdown forms.
	found.sort((left, right) => left.index - right.index);
	const paths = found.map((item) => item.path);
	return paths;
}

/** Extract assistant text blocks without altering their Markdown.
 *
 * Example:
 * >>> ImageAssistantText(message)
 * "![plot](plot.png)"
 */
function ImageAssistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}
	const text = message.content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
	return text;
}

// ========================================
// Registration

/** Register recent-turn tracking and assistant Markdown image previews.
 *
 * Example:
 * >>> ImageTurnsRegister(pi)
 * undefined
 */
export function ImageTurnsRegister(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<MarkdownImageEntry>(MARKDOWN_IMAGE_ENTRY, (entry, options, theme) => {
		const data = entry.data;
		if (!data?.paths?.length || !data.turnId || !data.cwd) {
			return undefined;
		}
		const showImages = LocalImagesConfiguredVisible(data.cwd);
		return LocalConditionalImageStack(
			data.paths,
			data.cwd,
			theme,
			() => showImages && (options.expanded || ImageTurnIsRecent(data.turnId)),
		);
	});

	// Rebuild indexes whenever Pi establishes or advances the active branch.
	pi.on("session_start", (_event, ctx) => {
		ImageTurnsRefresh(ctx.sessionManager.getBranch());
	});

	pi.on("turn_start", (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf?.type === "message" && leaf.message.role === "user") {
			ImageRememberTurn(leaf.id);
		}
	});

	pi.on("tool_call", (event) => {
		ImageRememberTool(event.toolCallId);
	});

	// Persist only path metadata after an assistant turn; custom entries stay out of context.
	pi.on("turn_end", (event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		const text = ImageAssistantText(event.message);
		const paths = MarkdownImagePaths(text, ctx.cwd);
		if (!currentTurnId || paths.length === 0) {
			return;
		}
		pi.appendEntry<MarkdownImageEntry>(MARKDOWN_IMAGE_ENTRY, { paths, turnId: currentTurnId, cwd: ctx.cwd });
	});
}
