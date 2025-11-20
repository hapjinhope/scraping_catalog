#!/usr/bin/env bash
set -euo pipefail

# Install missing system libs for Playwright Chromium at runtime (Railway minimal image).
apt-get update -y
apt-get install -y \
  libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
  libxcb1 libasound2 libatspi2.0-0 libexpat1 libgbm1 libgtk-3-0 libpango-1.0-0 \
  libcairo2 libxshmfence1

# Run scraper
node src/scrape.js
