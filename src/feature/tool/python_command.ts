/** Detect Python programs embedded in shell commands. */
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export interface PythonRunSnippet {
	code: string;
	label: string;
	sourcePath?: string;
	shellBefore?: string;
	shellAfter?: string;
}

interface ShellToken {
	value: string;
	operator: boolean;
}

interface ShellSegment {
	start: number;
	end: number;
	tokens: ShellToken[];
}

interface PythonLaunch {
	label: string;
	args: string[];
}

// ========================================
// Shell Parsing

/** Tokenize the shell subset needed to recognize Python launch commands.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonShellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let value = "";
	let quote: "'" | '"' | undefined;

	const pushValue = () => {
		if (value.length > 0) {
  tokens.push({ value, operator: false });
}
		value = "";
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") { quote = undefined; }
			else { value += ch; }
			// Continue with the next logical phase.
			continue;
		}
		// Continue with the next logical phase.
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1]!;
				switch (Boolean('"\\$`\n'.includes(next))) {
  case true: {
  					switch (Boolean(next !== "\n")) {
    case true: {
      value += next;
    }
  }
  					i++;
  					// Continue with the next logical phase.
  					continue;
  				}
}
			}
			// Continue with the next logical phase.
			value += ch;
			continue;
		}

		// Continue with the next logical phase.
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			value += command[++i]!;
			continue;
		}
		if (/\s/.test(ch)) {
			pushValue();
			if (ch === "\n") {
  tokens.push({ value: "\n", operator: true });
}
			continue;
		}
		if (";&|".includes(ch)) {
			// Continue with the next logical phase.
			pushValue();
			// Continue with the next logical phase.
			const doubled = command[i + 1] === ch;
			tokens.push({ value: doubled ? ch + ch : ch, operator: true });
			if (doubled) {
  i++;
}
			continue;
		}
		value += ch;
	}
	pushValue();
	return tokens;
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonExecutable(token: string): boolean {
	return /^(?:python(?:3(?:\.\d+)*)?|pypy(?:3)?)$/.test(basename(token));
}

/** Split a shell command at unquoted control operators while retaining source spans.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonShellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;

	/** Return the computed result.
	 *
	 * Example:
	 * >>> undefined
	 * undefined
	 */
	const pushSegment = (end: number) => {
		const source = command.slice(start, end);
		const tokens = PythonShellTokens(source);
		if (tokens.some((token) => !token.operator)) {
			segments.push({ start, end, tokens });
		}
	};

	// Only control operators outside shell quotes divide executable segments.
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
			} else if (ch === "\\") {
				i++;
			}
			continue;
		}
		// Continue with the next logical phase.
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "\n" || ";&|".includes(ch)) {
			pushSegment(i);
			const doubled = ch !== "\n" && command[i + 1] === ch;
			if (doubled) {
				i++;
			}
			start = i + 1;
		}
	}
	// Continue with the next logical phase.
	pushSegment(command.length);
	return segments;
}

/** Return the computed result.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonReadSource(
	path: string,
	cwd: string,
): { code: string; sourcePath: string } {
	const sourcePath = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		const stat = statSync(sourcePath);
		if (stat.isFile() && stat.size <= 256 * 1024) {
			return { code: readFileSync(sourcePath, "utf8"), sourcePath };
		}
	} catch {
		// The source may exist only on a remote compute runtime.
	}
	return {
		code: `# Running ${path}\n# Source is unavailable on this machine.`,
		sourcePath,
	};
}

/** Recognize a Python launcher and return its arguments without reading code.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonLaunchDetect(tokens: ShellToken[]): PythonLaunch | undefined {
	const words = tokens
		.filter((token) => !token.operator)
		.map((token) => token.value);
	if (words.length === 0) {
		return undefined;
	}

	// Ignore common environment/wrapper prefixes before determining the executable.
	let start = 0;
	let hasAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? "");
	while (hasAssignment) {
		start++;
		hasAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? "");
	}
	if (words[start] === "env" || words[start] === "command") {
		start++;
	}
	if (words[start] === "timeout" && words[start + 1]) {
		start += 2;
	}

	const executable = basename(words[start] ?? "");
	const rest = words.slice(start + 1);

	// `compute bash` commonly delegates to a shell wrapper, for example:
	//
	//   compute bash ... -- bash -lc 'python - <<\'PY\' ...'
	//
	// The outer shell tokenizer intentionally keeps quoted command strings as
	// one token, so unwrap `bash -c/-lc` and tokenize that command separately.
	// This also handles the same wrapper when it is used without `compute`.
	if (/^(?:bash|sh|zsh|dash)$/.test(executable)) {
		const commandIndex = rest.findIndex(
			(arg) => arg === "-c" || arg === "-lc" || arg === "--command" || /^-[^-]*c$/.test(arg),
		);
		const nestedCommand = commandIndex >= 0 ? rest[commandIndex + 1] : undefined;
		if (nestedCommand !== undefined) {
			const nested = PythonLaunchDetect(PythonShellTokens(nestedCommand));
			if (nested) {
				return nested;
			}
		}
	}

	if (executable === "compute") {
		// Continue with the next logical phase.
		const execIndex = rest.indexOf("exec");
		if (execIndex >= 0) {
			return { label: "compute exec", args: rest.slice(execIndex + 1) };
		}
		const separator = rest.indexOf("--");
		if (rest[0] !== "bash" || separator < 0) {
			return undefined;
		}
		return PythonLaunchDetect(
			rest.slice(separator + 1).map((value) => ({ value, operator: false })),
		);
	}
	if (executable === "uv" && rest[0] === "run") {
		let args = rest.slice(1);
		const pythonIndex = args.findIndex(PythonExecutable);
		if (pythonIndex >= 0) {
			// Continue with the next logical phase.
			args = args.slice(pythonIndex + 1);
		}
		return { label: "uv run", args };
	}
	if (PythonExecutable(executable)) {
		return { label: executable, args: rest };
	}
	return undefined;
}

/** Extract executable Python source from a recognized shell segment.
 *
 * Example:
 * >>> undefined
 * undefined
 */
function PythonInvocation(
	tokens: ShellToken[],
	cwd: string,
): PythonRunSnippet | undefined {
	const launch = PythonLaunchDetect(tokens);
	if (!launch) {
		return undefined;
	}
	const { args, label } = launch;
	const inlineIndex = args.findIndex(
		(arg) => arg === "-c" || arg === "--command",
	);
	if (inlineIndex >= 0 && args[inlineIndex + 1] !== undefined) {
		return { code: args[inlineIndex + 1]!, label };
	}

	const script = args.find((arg) => arg.toLowerCase().endsWith(".py"));
	if (script) {
		return { ...PythonReadSource(script, cwd), label };
	}
	return undefined;
}

/** Extract a Python heredoc body when the launch command uses stdin. */
function PythonHeredoc(command: string): PythonRunSnippet | undefined {
	const normalized = command.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	let lineOffset = 0;
	for (let i = 0; i < lines.length - 1; i++) {
		const marker = lines[i]!.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
		if (!marker) {
			lineOffset += lines[i]!.length + 1;
			continue;
		}
		const header = lines[i]!.slice(0, marker.index);
		const launchMatch = PythonShellSegments(header)
			.map((segment) => ({
				segment,
				launch: PythonLaunchDetect(segment.tokens),
			}))
			.find((candidate) => candidate.launch !== undefined);
		if (!launchMatch?.launch) {
			lineOffset += lines[i]!.length + 1;
			continue;
		}
		const delimiter = marker[1]!;
		let end = i + 1;
		let closingLine = lines[end]?.replace(/^\t/, "");
		while (end < lines.length && closingLine !== delimiter) {
			end++;
			closingLine = lines[end]?.replace(/^\t/, "");
		}
		if (end >= lines.length) {
			return undefined;
		}
		const afterOffset =
			lines.slice(0, end + 1).reduce((sum, line) => sum + line.length + 1, 0);
		const shellBefore = normalized
			.slice(0, lineOffset + launchMatch.segment.start)
			.trim();

		// A heredoc's follow-up operator is written on its header but executes
		// after the body, so move that suffix into the after-Python section.
		const markerEnd = (marker.index ?? 0) + marker[0].length;
		const headerSuffix = lines[i]!.slice(markerEnd);
		const suffixOperator = headerSuffix.search(/[;&|]/);
		const shellAfter = [
			suffixOperator >= 0 ? headerSuffix.slice(suffixOperator).trim() : "",
			normalized.slice(afterOffset).trim(),
		]
			.filter(Boolean)
			.join("\n");
		return {
			code: lines
				.slice(i + 1, end)
				.map((line) =>
					lines[i]!.includes("<<-") ? line.replace(/^\t/, "") : line,
				)
				.join("\n"),
			label: PythonExecutable(launchMatch.launch.label)
				? "python"
				: launchMatch.launch.label,
			shellBefore: shellBefore || undefined,
			shellAfter: shellAfter || undefined,
		};
	}
	return undefined;
}

/** Detect Python executed by compute, uv, python, or python3 in a shell command. */
export function PythonRunDetect(
	command: string,
	cwd: string,
): PythonRunSnippet | undefined {
	const heredoc = PythonHeredoc(command);
	if (heredoc) {
		return heredoc;
	}

	for (const segment of PythonShellSegments(command)) {
		const invocation = PythonInvocation(segment.tokens, cwd);
		if (!invocation) {
			continue;
		}
		const shellBefore = command.slice(0, segment.start).trim();
		const shellAfter = command.slice(segment.end).trim();
		return {
			...invocation,
			shellBefore: shellBefore || undefined,
			shellAfter: shellAfter || undefined,
		};
	}
	return undefined;
}
