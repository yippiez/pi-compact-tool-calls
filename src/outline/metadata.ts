/** Generic node metadata storage helpers. */



// ========================================
// Types

/** JSON-compatible value stored in node metadata. */
type NodeMetadataJson = null | boolean | number | string | NodeMetadataJson[] | { [key: string]: NodeMetadataJson };

/** One typed metadata slot. Keys are feature-owned. */
interface NodeMetadataEntry<T = NodeMetadataJson> {
	version: number;
	value: T;
}

/** Feature-owned metadata map persisted with each node. */
export type NodeMetadata = Record<string, NodeMetadataEntry>;


// ========================================
// Helpers

/** Clone metadata without sharing mutable entry/value objects.
 *
 * Example:
 * >>> NodeMetadataClone({ key: { version: 1, value: "data" } })
 * { key: { version: 1, value: "data" } }
 * >>> NodeMetadataClone(undefined)
 * undefined
 */
export function NodeMetadataClone(metadata: NodeMetadata | undefined): NodeMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	return JSON.parse(JSON.stringify(metadata)) as NodeMetadata;
}
