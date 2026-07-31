# Vendored UI libraries

This folder holds local copies of the three third-party scripts the renderer needs:
`highlight.min.js` + `github-dark.min.css` (syntax highlighting), `marked.min.js`
(markdown parsing), and `purify.min.js` (HTML sanitization for anything rendered
from AI/tool output).

They used to load from `cdnjs.cloudflare.com` at runtime, which meant the chat UI
silently required internet access just to render a message — a real gap for an app
built around local, offline Ollama models. `index.html` now references these files
locally instead, and the CSP no longer allows `cdnjs.cloudflare.com` at all.

These files aren't committed to the repo (see `.gitignore`) since they're exact,
unmodified third-party builds — same reasoning as not committing `node_modules`.

## Setup

Run once after cloning or pulling:

```
bash src/renderer/vendor/fetch-vendor-libs.sh
```

This downloads the exact pinned versions previously used (highlight.js 11.9.0,
marked 12.0.0, DOMPurify 3.1.6) into this folder. If you'd rather fetch them by
hand, the exact URLs are listed inside that script.

If this folder is empty, the app will still start, but markdown won't render,
code blocks won't be syntax-highlighted, and — since DOMPurify itself is what's
missing — `components.js`'s sanitizer falls back to plain-text escaping rather
than allowing any HTML through, so nothing unsafe gets rendered either way.
