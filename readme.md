# Kode — AI Agent for Coding & Cybersecurity

<p align="center">
  <img src="icon.png" width="128" height="128" alt="Kode Logo">
</p>

**Kode** is a native macOS desktop AI agent built primarily around local [Ollama](https://ollama.ai) models, with optional cloud providers (OpenAI, Anthropic Claude, DeepSeek) — or any other OpenAI-compatible API (Groq, OpenRouter, Together AI, a local LM Studio/vLLM server, etc.) via a custom endpoint — available in Settings. Unlike cloud-only coding agents (Claude Code, OpenCode, etc.), everything Kode does with local models — reading your code, running commands, scanning targets — happens entirely on your machine: nothing is sent anywhere unless you explicitly enable web research or switch to a cloud provider. That makes it the natural choice for security research, work on private/regulated codebases, or simply not wanting your code and terminal output leaving your laptop. It combines a full-featured coding assistant — with a git-backed safety net, patch-based editing, and local semantic code search — with professional-grade penetration testing capabilities, plus persistent per-project memory and web research tools.

## ✨ Features

### 🤖 AI Coding Agent
- **Autonomous coding** — Create files, edit code, run commands, debug errors
- **Project awareness** — Understands your project structure and context
- **Step-by-step execution** — Plans before acting, chains tool results; `write_plan` gives long/vague tasks an explicit, visible checklist instead of losing the thread
- **Multi-model support** — Switch between any Ollama model, OpenAI/Anthropic/DeepSeek, or any other OpenAI-compatible API (Groq, OpenRouter, Together AI, local servers, etc.) in Settings

### 🛟 Safety Net & Verification
- **Git checkpoints** — `git_checkpoint` stages and commits a labeled snapshot (auto-initializes a repo the first time), so any edit can be undone
- **One-command undo** — `git_revert` discards a bad change — a single file, or the whole working tree — back to the last checkpoint
- **Patch-based editing** — `apply_patch` applies a unified diff instead of requiring an exact old-content match, which local models reproduce far more reliably; falls back to content-based matching when a hunk's line numbers are slightly off
- **Instant syntax checks** — `create_file`/`edit_file`/`apply_patch` run a fast syntax check (JS/JSON/Python) right after writing, so a broken edit is flagged immediately instead of discovered later
- **Verify, don't assume** — `run_tests` runs the project's test suite (or a custom command) and reports pass/fail with output, so the agent checks its own work instead of just claiming success

### 🔎 Local Semantic Code Search
- **`index_codebase`** — builds a local vector index of the project with an Ollama embedding model (`nomic-embed-text` by default, ~270MB) — no cloud API involved
- **`semantic_search`** — finds code by what it *does* ("where is the login flow handled"), not just literal text like `search_files`/grep

### 🔓 Red Team / Penetration Testing
- **Automated pentest workflow** — Give a target, agent scans and analyzes autonomously
- **macOS + Kali VM** — Runs tools on macOS directly, guides Kali VM commands
- **WAF/CDN bypass** — Cloudflare origin IP discovery, WAF evasion techniques
- **Web security specialist** — Knowledge, bug bounty methodology
- **Result analysis** — Paste nmap/nikto/sqlmap output → auto-analyzed with next steps
- **Professional reports** — Pentest report format with severity, CVSS, remediation

### 🛠️ Tools Available to the Agent
| Tool | Description |
|------|-------------|
| `create_file` | Create files with content (auto-checked for syntax errors) |
| `edit_file` | Edit existing files by exact old/new content match |
| `apply_patch` | Apply a unified diff — preferred for multi-line/multi-file changes |
| `read_file` | Read file contents |
| `run_command` | Execute shell commands (60s/120s timeout) |
| `run_tests` | Run the test suite (`npm test` by default) and report pass/fail |
| `list_directory` | List directory contents |
| `http_request` | Make HTTP/HTTPS requests |
| `search_files` | Grep-like literal pattern search |
| `index_codebase` / `semantic_search` | Build/query a local embedding index to find code by meaning |
| `git_status` / `git_diff` | Inspect the working tree and review changes before trusting them |
| `git_checkpoint` / `git_revert` | Safety-net commit and one-command undo |
| `write_plan` | Lay out and check off a step-by-step plan for multi-step tasks |

### 💾 Persistent Storage
- **Projects** — Saved across restarts
- **Chat history** — Per-project and standalone chats
- **Chat management** — Rename, delete, switch between chats

### 🛡️ Safety
- **Destructive-command blocking** — `run_command` refuses known-catastrophic patterns (`rm -rf /`, fork bombs, raw-disk overwrites, etc.) outright.
- **Risky-command confirmation** — Patterns that are legitimate in a pentest workflow but also a classic RCE shape (piping a downloaded script into a shell, decoding-and-executing base64, etc.) pause and ask you to approve or block before running. On by default; toggle it off in Settings → Safety if you fully trust the model/target and want it to run autonomously.

## 📋 Requirements

- **macOS** 12+ (Monterey or later)
- **[Ollama](https://ollama.ai)** installed and running
- At least one coding model pulled: `ollama pull qwen2.5-coder:7b`
- Optional, for semantic search: an embedding model — `ollama pull nomic-embed-text`

### Recommended Models

For actual coding work, a *code-specialized* model consistently outperforms a same-size
general-purpose one — prefer these over `llama3.1`/`deepseek-r1` for anything beyond
simple chat:

| Model | Use Case | Command |
|-------|----------|---------|
| `qwen2.5-coder:7b` | Coding — best all-round pick at 7B, good tool-call reliability | `ollama pull qwen2.5-coder:7b` |
| `qwen2.5-coder:32b` | Coding — strongest local option if you have the VRAM (~20GB+) | `ollama pull qwen2.5-coder:32b` |
| `devstral:24b` | Coding — tuned specifically for agentic/tool-using workflows | `ollama pull devstral:24b` |
| `nomic-embed-text` | Semantic code search (`index_codebase`/`semantic_search`) — small, CPU-friendly | `ollama pull nomic-embed-text` |
| `DeepHat/DeepHat-V1-7B` | 🔓 Red Team / Security | `ollama pull DeepHat/DeepHat-V1-7B` |
| `dolphin3:8b` | 🔓 Uncensored assistant | `ollama pull dolphin3:8b` |
| `llama3.1:8b` | General-purpose fallback, fast native tool-calling | `ollama pull llama3.1:8b` |

> **Note:** Security models (DeepHat, Dolphin) unlock the full Red Team prompt with pentest methodology, WAF bypass, and exploit guidance. Standard models get basic security features.

## 🚀 Quick Start

### Development
```bash
# Clone and install
cd kode
npm install

# Fetch vendored UI libraries (highlight.js, marked, DOMPurify) — one-time, so the
# app works fully offline instead of loading these from a CDN. See src/renderer/vendor/README.md
bash src/renderer/vendor/fetch-vendor-libs.sh

# Start in development mode
npm start
```

### Build macOS App
```bash
# Build .app and .dmg
npm run build

# Output: dist/Kode-1.1.0-arm64.dmg (Apple Silicon)
#         dist/Kode-1.1.0-x64.dmg   (Intel)
```

### Tests & Linting
```bash
npm test   # runs test/**/*.test.js (node:test)
npm run lint   # ESLint over main.js + src/
```
CI (`.github/workflows/build-linux.yml`, `build-mac.yml`) runs `npm test` before every build, so a broken build is never packaged or released.

### Code Signing & Notarization (macOS)
A build produced without an Apple Developer certificate is unsigned and will trigger
Gatekeeper's "unidentified developer" warning for anyone but you. `package.json`'s
`build.mac` config already sets `hardenedRuntime: true` and points at
`build/entitlements.mac.plist`, which is everything electron-builder needs to sign and
notarize automatically — it just needs credentials. Either locally or as GitHub Actions
repo secrets, set:

| Variable | What it is |
|---|---|
| `CSC_LINK` | Base64 (or file path) of your Developer ID Application `.p12` certificate |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID ([generate one](https://support.apple.com/en-us/102654)) |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

With those set, `npm run build` / the `build-mac.yml` workflow sign and notarize
automatically — no other config changes needed. Without them, builds still work
(unsigned/ad-hoc-signed), which is fine for local testing on your own machine.

## 🏗️ Project Structure

```
kode/
├── main.js                    # Electron main process
├── icon.png                   # App icon
├── package.json
├── src/
│   ├── preload.js             # IPC bridge (renderer ↔ main)
│   ├── agent/
│   │   ├── core.js            # Agent loop (plan → execute → chain)
│   │   ├── prompts.js         # System prompts (coding + red team)
│   │   ├── tools.js           # Tool implementations
│   │   ├── patch.js           # Unified-diff parser/applier (apply_patch)
│   │   └── embeddings.js      # Local semantic search index (index_codebase/semantic_search)
│   ├── ollama/
│   │   └── client.js          # Ollama API client (streaming)
│   └── renderer/
│       ├── index.html         # App UI
│       ├── app.js             # Frontend logic
│       └── styles.css         # Dark glassmorphism theme
```

## 🎨 UI Features

- **Dark glassmorphism** theme with frosted glass effects
- **Sidebar** — Projects, chat history, model selector
- **Real-time streaming** — Token-by-token response display
- **Markdown rendering** — Code blocks with syntax highlighting
- **Model badge** — 🔓 Red Team indicator for security models
- **Thinking indicator** — Shows agent planning and tool execution

## 🔐 Security Model Workflow

When using DeepHat or Dolphin models:

```
You: "scan 192.168.1.100"

Agent: 🎯 Target: 192.168.1.100
       [runs nmap -sV -sC -T4 192.168.1.100]
       
       📡 Open Ports:
         22/tcp  SSH     OpenSSH 7.2p2
         80/tcp  HTTP    Apache 2.4.18
       
       ⚠️ Vulnerabilities:
         🔴 [CRITICAL] OpenSSH 7.2p2 — CVE-2016-6515
       
       📋 Next Action:
         Run on Kali: sqlmap -u "http://192.168.1.100/page?id=1" --batch
         Paste the output here.
```

## ⚠️ Disclaimer

This tool is designed for **authorized security testing** and **educational purposes** only. Always obtain proper authorization before testing systems you don't own. The developers are not responsible for any misuse.

## 📄 License

MIT License — see [LICENSE](LICENSE).
