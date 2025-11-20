#!/usr/bin/env bash
set -euo pipefail

# Wrapper to launch the main runner regardless of cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
bash scripts/run.sh "$@"
