# pi-compact-tool-calls

A standalone Pi extension that makes built-in tool calls render as compact single-line rows.

## Features

- Collapses `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` calls to `<Tool> <primary arg>` without truncating call paths/arguments.
- Leaves tool execution untouched; only rendering is overridden.
- Uses stable colors per tool name; `Bash` is always red.
- Muted gray arguments keep the transcript compact.
- Collapsed successful calls show no extra result rows.
- Collapsed errors show one red error row.
- `Ctrl+O` expands detailed views for:
  - `bash` output in a rounded, truncated box
  - `ls` output in a rounded, truncated box
  - `grep` output in a rounded, truncated box
  - `edit` results as a colored stacked diff

Output boxes sanitize ANSI/control sequences, truncate to 5 lines, and width-truncate every row to avoid overflow/color bleed.

## Try without installing

```bash
pi --no-extensions -e extensions/pi-compact-tool-calls.ts
```

Or from this directory:

```bash
./run.sh
```

## Install from Git

Global install (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/yippiez/pi-compact-tool-calls
```

Local/project install (writes to `.pi/settings.json` in the current repo):

```bash
pi install -l git:github.com/yippiez/pi-compact-tool-calls
```

## Package layout

```text
extensions/pi-compact-tool-calls.ts
package.json
```

This package is independent of `pi-prompt-chain`; you can install either one alone or both together.
