#!/usr/bin/env bash
# Launch pi with only the pi-compact-tool-calls extension.
set -euo pipefail
cd "$(dirname "$0")"
exec pi --no-extensions \
  -e extensions/pi-compact-tool-calls.ts \
  "$@"
