# Kode — AI Coding & Security Agent

<p align="center">
  <img src="icon.png" width="128" height="128" alt="Kode Logo">
</p>

**Kode is two agents in one app:**

1. 🤖 **A coding agent** — like Claude Code or OpenCode. It reads your project, writes and edits files, runs commands, debugs failures, and keeps working until the task is actually done.
2. 🛡️ **A security agent** — it audits *your own* source code for vulnerabilities (insecure patterns, missing validation, outdated dependencies) and, going further, runs real penetration-testing tools against systems you're authorized to test — matching findings to CVEs and producing a report with severity ratings and fixes.

It's a native desktop app for macOS and Windows. Run it fully offline with local [Ollama](https://ollama.ai) models — your code never leaves your machine — or connect it to OpenAI, Claude, DeepSeek, or any OpenAI-compatible cloud API.

## 📥 Install

Download the installer for your platform from [Releases](https://github.com/KhitMinnyo/Kode/releases). Builds aren't code-signed, so both operating systems quarantine them on first run — one command clears it.

### macOS

Open the `.dmg`, drag Kode to Applications, then clear the quarantine flag Gatekeeper puts on apps that aren't notarized:

```bash
xattr -cr /Applications/Kode.app
```

### Windows

Download `Kode-<version>-x64.exe` (or `-arm64.exe` on an ARM device). Windows tags every downloaded file with a "came from the internet" mark, and SmartScreen refuses to run an unsigned installer carrying it. Clearing that mark is the direct equivalent of macOS's `xattr -cr`:

```powershell
Unblock-File -Path .\Kode-1.1.5-x64.exe
```

Without PowerShell: right-click the `.exe` → **Properties** → tick **Unblock** → **OK**.

If SmartScreen still shows *"Windows protected your PC"*, click **More info** → **Run anyway**. Kode installs to `%LOCALAPPDATA%\Programs\Kode` unless you choose another folder during setup.

**If setup ends with "Missing Shortcut — Windows is searching for Kode.exe":** Microsoft Defender quarantined `Kode.exe` after the installer extracted it, so the shortcut it just created points at a file that is no longer there — the app isn't broken, its executable was removed out from under it. Open **Windows Security → Virus & threat protection → Protection history**, find the blocked `Kode.exe`, choose **Allow on device**, then run the installer again.

> Both warnings are about the *absence of a code-signing certificate*, not about anything found in the app. They disappear on signed builds — see [Code Signing](#code-signing-optional).

**From source:** see [Quick Start](#-quick-start) below.

## ✨ Features

### 🤖 Coding Agent
- Create files, edit code, run commands, debug errors — plans first for complex tasks, then works through every step without stopping to ask "should I continue?"
- Any Ollama model, or OpenAI / Anthropic / DeepSeek / custom OpenAI-compatible API
- **Attach files or folders** to a message for extra context, the same way you'd attach files in Claude
- **Live side panel** — tracks plan progress step-by-step and shows the project's file list as it changes, so you always know what the agent is doing

### 🛡️ Security Agent
- **Audits your codebase** — "audit this app" scans every file, flags vulnerabilities, insecure patterns, and missing validation, then fixes what it finds
- **Real pentest tooling** — nmap, sqlmap, nikto, hydra, gobuster and more; auto-analyzes their output instead of just dumping it back at you
- **CVE lookups** — matches software/service versions against the NVD database
- **Full report generation** — findings rated by severity with CVSS scores and concrete remediation steps
- **WAF/CDN bypass and bug bounty methodology** for authorized engagements

### 🛟 Safety Net
- `git_checkpoint` / `git_revert` — snapshot and undo
- `apply_patch` — unified-diff editing, more reliable than exact-match
- Syntax check on every write
- `run_tests` — verifies its own work instead of just claiming success

### 🔎 Semantic Code Search
- `index_codebase` / `semantic_search` — find code by meaning, fully local (Ollama embeddings)

### 🔒 Command Safety
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

- macOS 12+ (Monterey or later), or Windows 10/11
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
# → dist/Kode-1.1.5-universal.dmg (Apple Silicon + Intel)
```

### Build Windows App
```bash
npm run build:win
# → dist/Kode-1.1.5-x64.exe, dist/Kode-1.1.5-arm64.exe  (NSIS installers)
```
Cross-building a Windows installer from macOS works for the unsigned case; sign on Windows (or in CI — `.github/workflows/build-win.yml`) when you have a certificate.

### Tests & Linting
```bash
npm test
npm run lint
```
CI (`.github/workflows/build-*.yml`) runs `npm test` before every build.

### Code Signing (optional)
Unsigned builds trigger Gatekeeper warnings on macOS and SmartScreen warnings on Windows for anyone but you — see [Install](#-install) for running one anyway.

**macOS:** set as env vars or GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `npm run build` picks them up automatically.

**Windows:** set `CSC_LINK` (path or base64 of a `.pfx`) and `CSC_KEY_PASSWORD`; `npm run build:win` picks them up the same way. Note that an ordinary OV certificate does not silence SmartScreen immediately — reputation builds up over downloads — while an EV certificate is trusted from the first run.

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
