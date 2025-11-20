#!/usr/bin/env bash
set -euo pipefail

# Ensure system deps for Playwright Chromium are present in runtime
npx playwright install-deps chromium

# Run scraper
node src/scrape.js
