#!/usr/bin/env bash
# Downloads the third-party UI libraries Kode's renderer needs (highlight.js, marked,
# DOMPurify) into this folder as plain local files, instead of loading them from
# cdnjs.cloudflare.com at runtime.
#
# Why this exists: Kode's whole point is working with local Ollama models offline,
# but until now the chat UI's markdown rendering, syntax highlighting, and HTML
# sanitization all silently required internet access to fetch these three scripts
# from a CDN on every launch. That's a real gap for a "local-first" app. Run this
# once after cloning/pulling so the app works fully offline going forward.
#
# Usage: bash src/renderer/vendor/fetch-vendor-libs.sh
# (run from the project root, or anywhere — paths below are relative to this script)

set -euo pipefail
cd "$(dirname "$0")"

# Pinned to the exact versions previously loaded from cdnjs.cloudflare.com in
# index.html, so behavior doesn't change — only where the files come from.
declare -A FILES=(
  ["highlight.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
  ["github-dark.min.css"]="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
  ["marked.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"
  ["purify.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"
)

for name in "${!FILES[@]}"; do
  url="${FILES[$name]}"
  echo "Fetching $name ..."
  curl -fsSL "$url" -o "$name"
  size=$(wc -c < "$name" | tr -d ' ')
  if [ "$size" -lt 1000 ]; then
    echo "⚠️  $name looks too small ($size bytes) — check your internet connection or the URL." >&2
    exit 1
  fi
  echo "  ✅ $name ($size bytes)"
done

echo
echo "Done. index.html already points at these local files — just reload/restart Kode."
