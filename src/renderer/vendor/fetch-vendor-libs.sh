#!/usr/bin/env bash
# Downloads the third-party UI libraries Kode's renderer needs (highlight.js, marked,
# DOMPurify) into this folder as plain local files, instead of loading them from
# cdnjs.cloudflare.com at runtime.
#
# Why this exists: Kode's whole point is working with local Ollama models offline,
# but until now the chat UI's markdown rendering, syntax highlighting, and HTML
# sanitization all silently required internet access to fetch these three scripts
# from a CDN on every launch. That's a real gap for a "local-first" app.
#
# This now also runs automatically as part of `npm install` (see package.json's
# "postinstall" script) so it's no longer a manual step to remember — but it stays
# safe to run by hand too:
#   bash src/renderer/vendor/fetch-vendor-libs.sh          # skip files already present
#   bash src/renderer/vendor/fetch-vendor-libs.sh --force  # re-download everything
#
# If there's no internet when `npm install` runs (e.g. first clone, offline machine),
# this exits quietly (code 0) instead of failing the install — Kode's renderer falls
# back to plain text for chat formatting until you run this again with a connection,
# and shows an in-app warning when that happens (see components.js renderMarkdown()).

set -uo pipefail
cd "$(dirname "$0")"

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

# Pinned to the exact versions previously loaded from cdnjs.cloudflare.com in
# index.html, so behavior doesn't change — only where the files come from.
declare -A FILES=(
  ["highlight.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
  ["github-dark.min.css"]="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
  ["marked.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"
  ["purify.min.js"]="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"
)

any_failed=0
any_fetched=0

for name in "${!FILES[@]}"; do
  if [ "$FORCE" -ne 1 ] && [ -f "$name" ]; then
    existing_size=$(wc -c < "$name" | tr -d ' ')
    if [ "$existing_size" -ge 1000 ]; then
      echo "  ✔ $name already present ($existing_size bytes) — skipping"
      continue
    fi
  fi

  url="${FILES[$name]}"
  echo "Fetching $name ..."
  if ! curl -fsSL --max-time 20 "$url" -o "$name.tmp"; then
    echo "  ⚠️  Could not fetch $name (no internet, or $url is unreachable right now)." >&2
    rm -f "$name.tmp"
    any_failed=1
    continue
  fi
  size=$(wc -c < "$name.tmp" | tr -d ' ')
  if [ "$size" -lt 1000 ]; then
    echo "  ⚠️  $name looks too small ($size bytes) — check your internet connection or the URL." >&2
    rm -f "$name.tmp"
    any_failed=1
    continue
  fi
  mv "$name.tmp" "$name"
  any_fetched=1
  echo "  ✅ $name ($size bytes)"
done

echo
if [ "$any_failed" -eq 1 ]; then
  echo "Some files could not be fetched. Kode still runs — chat formatting (markdown," >&2
  echo "syntax highlighting) falls back to plain text until you re-run this script:" >&2
  echo "  bash src/renderer/vendor/fetch-vendor-libs.sh" >&2
  # Exit 0 on purpose: this must never fail `npm install` just because the network
  # was unavailable at that moment.
  exit 0
fi

if [ "$any_fetched" -eq 1 ]; then
  echo "Done. index.html already points at these local files — just reload/restart Kode."
else
  echo "All formatting libraries already present — nothing to do."
fi
