#!/bin/bash
set -euo pipefail
root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
fi
exec bun "$root/moss.mjs" "$@"
