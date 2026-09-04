# Kode — AI Agent for Coding & Cybersecurity

<p align="center">
  <img src="icon.png" width="128" height="128" alt="Kode Logo">
</p>

A native macOS desktop AI agent. Works with local [Ollama](https://ollama.ai) models, or cloud providers (OpenAI, Claude, DeepSeek, and any other OpenAI-compatible API) via Settings. Local models never send your code anywhere. Combines coding assistance — git-backed safety net, patch-based editing, semantic code search — with penetration-testing tools, project memory, and web research.

## 📥 Install

**Prebuilt (Releases):** download the `.dmg`, drag Kode to Applications, then run once — builds aren't notarized, so Gatekeeper blocks them until you clear the quarantine flag:
```bash
xattr -cr /Applications/Kode.app
```

**From source:** see [Quick Start](#-quick-start) below.

## ✨ Features

### 🤖 Coding Agent
- Create files, edit code, run commands, debug errors
- Plans before acting; `write_plan` tracks multi-step tasks
- Any Ollama model, or OpenAI / Anthropic / DeepSeek / custom OpenAI-compatible API

### 🛟 Safety Net
- `git_checkpoint` / `git_revert` — snapshot and undo
- `apply_patch` — unified-diff editing, more reliable than exact-match
- Syntax check on every write
- `run_tests` — verifies its own work instead of just claiming success

### 🔎 Semantic Code Search
- `index_codebase` / `semantic_search` — find code by meaning, fully local (Ollama embeddings)

### 🔓 Red Team / Pentest
- Autonomous scan-and-analyze workflow
- WAF/CDN bypass, bug bounty methodology
- Auto-analyzes pasted nmap/nikto/sqlmap output
- Pentest report generation with CVSS and remediation

### 🛡️ Command Safety
- Blocks known-catastrophic commands outright (`rm -rf /`, fork bombs, etc.)
- Confirms risky-but-legitimate patterns before running — toggle in Settings

### Tools
| Tool | Description |
|------|-------------|
| `create_file` / `edit_file` / `apply_patch` | Write and edit files |
| `read_file` / `list_directory` / `search_files` | Read and search the project |
| `run_command` / `run_tests` | Execute shell commands, run the test suite |
| `http_request` | Make HTTP/HTTPS requests |
| `index_codebase` / `semantic_search` | Build/query a local embedding index |
| `git_status` / `git_diff` / `git_checkpoint` / `git_revert` | Inspect changes, snapshot, undo |
| `write_plan` | Step-by-step task checklist |

## 📋 Requirements

- macOS 12+ (Monterey or later)
- [Ollama](https://ollama.ai) installed and running (for local models)
- A coding model pulled: `ollama pull qwen2.5-coder:7b`
- Optional: `ollama pull nomic-embed-text` for semantic search

### Recommended Ollama Models

| Model | Use case |
|-------|----------|
| `qwen2.5-coder:7b` | Best all-round coding pick at 7B |
| `qwen2.5-coder:32b` | Strongest local option (~20GB+ VRAM) |
| `devstral:24b` | Tuned for agentic/tool-using workflows |
| `nomic-embed-text` | Semantic code search |
| `DeepHat/DeepHat-V1-7B` | 🔓 Red Team / Security |
| `dolphin3:8b` | 🔓 Uncensored assistant |
| `llama3.1:8b` | General fallback, fast native tool-calling |

> Security models (DeepHat, Dolphin) unlock the full Red Team prompt. Standard models get basic security features.

### Recommended Cloud Models

| Provider | Model | Use case |
|----------|-------|----------|
| DeepSeek | `deepseek-v4-flash` | Fast, low-cost, best all-round pick |
| DeepSeek | `deepseek-v4-pro` | Harder reasoning tasks |
| OpenAI | `gpt-5.6-sol` | Flagship — strong coding at a fraction of Astra's cost |
| OpenAI | `gpt-6-astra` | Top-tier — hardest end-to-end coding/reasoning tasks |
| Claude | `claude-opus-5` | Complex agentic coding, Anthropic's own recommendation |
| Claude | `claude-sonnet-5` | Best speed/intelligence balance for everyday use |
| Other (Custom) | — | Any OpenAI-compatible endpoint — pick whatever model that provider recommends |

> Cloud model names change fast — the Settings dropdown always fetches each provider's live model list, so treat this table as a starting point rather than the final word.

## 🚀 Quick Start

### Development
```bash
cd kode
npm install
bash src/renderer/vendor/fetch-vendor-libs.sh   # one-time — vendors UI libs for offline use
npm start
```

### Build macOS App
```bash
npm run build
# → dist/Kode-1.1.0-arm64.dmg (Apple Silicon), dist/Kode-1.1.0-x64.dmg (Intel)
```

### Tests & Linting
```bash
npm test
npm run lint
```
CI (`.github/workflows/build-*.yml`) runs `npm test` before every build.

### Code Signing (optional)
Unsigned builds trigger Gatekeeper warnings for anyone but you — see [Install](#-install) for running one anyway. To sign and notarize instead, set as env vars or GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `npm run build` picks them up automatically.

## 🏗️ Project Structure

```
kode/
├── main.js                                      # Electron main process
├── icon.png / package.json
└── src/
    ├── preload.js                                # IPC bridge (renderer ↔ main)
    ├── agent/                                    # Agent loop, prompts, tools, patch, embeddings
    ├── {ollama,deepseek,openai,anthropic,custom}/ # Provider clients (custom = any OpenAI-compatible API)
    └── renderer/                                 # UI (index.html, app.js, styles.css)
```

## ⚠️ Disclaimer

For authorized security testing and educational use only. Obtain proper authorization before testing systems you don't own.

## 📄 License

MIT — see [LICENSE](LICENSE).
