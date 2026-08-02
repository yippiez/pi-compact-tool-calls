/**Node: one entry in a prompt chain with type, content, and tree structure. */
import { randomUUID } from "node:crypto";
import { NodeMetadataClone, type NodeMetadata } from "./metadata.ts";
import {
	NodeInlineClone,
	NodeInlineFromText,
	NodeInlineInsertChip,
	NodeInlineLength,
	NodeInlineText,
	type NodeInlineElement,
} from "./inline.ts";


// ========================================
// Types

/** A v4 UUID identifying a node. */
export type NodeId = string;

/** How a node's `content` is interpreted. */
type NodeType = "node" | "bash" | "file" | "command" | "code";

interface NodeBase {
	/** Stable unique identity (UUID v4). */
	readonly id: NodeId;
	/** The node payload: text, a command, a path, etc. (no type marker). */
	content: string;
	/** Child node ids — infinite nesting, resolved through the node store. */
	children: NodeId[];
	/** Feature-owned metadata copied into session snapshots. */
	metadata?: NodeMetadata;
	/** Render the node to its inline pasteable form. */
	toString(): string;
}

/** A user-authored outline node with native inline attachments. */
export interface PlainNode extends NodeBase {
	type: "node";
	inline: NodeInlineElement[];
	agentResult?: boolean;
	fileDiff?: { file: string; diff: string };
	output?: never;
	exitCode?: never;
}

/** A runnable shell node with optional captured output. */
export interface BashNode extends NodeBase {
	type: "bash";
	inline?: never;
	agentResult?: never;
	fileDiff?: never;
	output?: string;
	exitCode?: number;
}

/** A readonly multiline or inline code node. */
export interface CodeNode extends NodeBase {
	type: "code";
	inline?: never;
	agentResult?: never;
	fileDiff?: never;
	output?: never;
	exitCode?: never;
}

/** A path reference represented as a standalone outline node. */
export interface FileNode extends NodeBase {
	type: "file";
	inline?: never;
	agentResult?: never;
	fileDiff?: never;
	output?: never;
	exitCode?: never;
}

/** A slash command represented as a standalone outline node. */
export interface CommandNode extends NodeBase {
	type: "command";
	inline?: never;
	agentResult?: never;
	fileDiff?: never;
	output?: never;
	exitCode?: never;
}

/** Every valid outline node state, discriminated by `type`. */
export type Node = PlainNode | BashNode | CodeNode | FileNode | CommandNode;

interface NodeInput {
	id?: NodeId;
	type?: NodeType;
	content?: string;
	children?: NodeId[];
	inline?: NodeInlineElement[];
	agentResult?: boolean;
	pasted?: string;
	pastedAt?: number;
	fileDiff?: { file: string; diff: string };
	output?: string;
	exitCode?: number;
	metadata?: NodeMetadata;
}

interface NodeConstructor {
	new(init?: NodeInput): Node;
	fromString(raw: string): Node;
}


// ========================================
// Node

/** Runtime implementation normalized into one of the discriminated node variants. */
class NodeValue {
	readonly id: NodeId;
	type: NodeType;
	content: string;
	children: NodeId[];
	inline?: NodeInlineElement[];
	agentResult?: boolean;
	fileDiff?: { file: string; diff: string };
	output?: string;
	exitCode?: number;
	metadata?: NodeMetadata;

	constructor(init: NodeInput = {}) {
		this.id = init.id ?? randomUUID();
		this.type = init.type ?? "node";
		this.content = init.content ?? "";
		this.children = init.children ?? [];
		this.metadata = NodeMetadataClone(init.metadata);

		// Variant-specific fields are copied only onto the variant that owns them.
		if (this.type === "node") {
			let inline = init.inline
				? NodeInlineClone(init.inline)
				: NodeInlineFromText(this.content);

			// Migrate pre-inline snapshots without retaining legacy fields.
			if (!init.inline && init.pasted) {
				const inserted = NodeInlineInsertChip(
					inline,
					Math.min(init.pastedAt ?? NodeInlineLength(inline), NodeInlineLength(inline)),
					{ kind: "pasted", text: init.pasted },
				);
				inline = inserted.elements;
			}

			// Keep the compatibility text projection synchronized at construction.
			this.inline = inline;
			this.content = NodeInlineText(inline);
			this.agentResult = init.agentResult;
			this.fileDiff = init.fileDiff;
		} else if (this.type === "bash") {
			this.output = init.output;
			this.exitCode = init.exitCode;
		}
	}

	/** Render the node to its inline pasteable form (the body after the bullet).
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	toString(): string {
		switch (this.type) {
			case "bash":
				return `\`$ ${this.content}\``;
			case "code":
				return `\`${this.content}\``;
			case "file":
				return `@${this.content}`;
			case "command":
				return `/${this.content}`;
			default:
				return this.content;
		}
	}

	/** Parse the inline pasteable form back into a normalized node.
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	static fromString(raw: string): Node {
		const bash = raw.match(/^`\$\s(.*)`$/);
		if (bash) {
			return new Node({ type: "bash", content: bash[1] ?? "" });
		}

		const code = raw.match(/^`(.*)`$/);
		if (code) {
			return new Node({ type: "code", content: code[1] ?? "" });
		}
		if (raw.startsWith("@")) {
			return new Node({ type: "file", content: raw.slice(1) });
		}
		if (raw.startsWith("/")) {
			return new Node({ type: "command", content: raw.slice(1) });
		}
		return new Node({ type: "node", content: raw });
	}
}

/** Construct normalized discriminated outline nodes while preserving the legacy `new Node()` API. */
export const Node = NodeValue as unknown as NodeConstructor;


/** True when a bullet body encodes a typed outline node (bash, code, etc.).

    Args:
        raw: Bullet body text after the leading "- ".

    Returns:
        Whether parsing would yield a non-plain node.

    Example:
        >>> NodeBulletBodyTyped("`$ npm test`")
        true
 */
export function NodeBulletBodyTyped(raw: string): boolean {
	const node = Node.fromString(raw.trim());
	return node.type !== "node";
}
