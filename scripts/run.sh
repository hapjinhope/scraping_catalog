#!/usr/bin/env bash
set -euo pipefail

# Run scraper (зависимости уже устанавливаются на этапе build)
node src/scrape.js
