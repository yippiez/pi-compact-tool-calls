import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompactToolCallsRegister } from "./feature/tool/compact_tool_calls.ts";

export default function PiCompactToolCallsRegister(pi: ExtensionAPI): void {
	CompactToolCallsRegister(pi);
}
