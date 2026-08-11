#!/bin/bash
set -euo pipefail
cd /Users/thbeaver/inference-provider

echo "=== pricing check run: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> logs/pricing-check.log

claude -p "$(cat scripts/pricing-check-prompt.txt)" \
  --allowedTools "Read Edit WebFetch" \
  --add-dir /Users/thbeaver/inference-provider \
  >> logs/pricing-check.log 2>&1
