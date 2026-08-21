# Kode — AI Agent for Coding & Cybersecurity

<p align="center">
  <img src="icon.png" width="128" height="128" alt="Kode Logo">
</p>

**Kode** is a native macOS desktop AI agent built primarily around local [Ollama](https://ollama.ai) models, with optional cloud providers (OpenAI, Anthropic Claude, DeepSeek) available in Settings. It combines a full-featured coding assistant with professional-grade penetration testing capabilities, plus persistent per-project memory and web research tools.

## ✨ Features

### 🤖 AI Coding Agent
- **Autonomous coding** — Create files, edit code, run commands, debug errors
- **Project awareness** — Understands your project structure and context
- **Step-by-step execution** — Plans before acting, chains tool results
- **Multi-model support** — Switch between any Ollama model

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
| `create_file` | Create files with content |
| `edit_file` | Edit existing files |
| `read_file` | Read file contents |
| `run_command` | Execute shell commands (60s/120s timeout) |
| `list_directory` | List directory contents |
| `http_request` | Make HTTP/HTTPS requests |
| `search_files` | Grep-like pattern search |

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
- At least one model pulled: `ollama pull deepseek-r1:8b`

### Recommended Models

| Model | Use Case | Command |
|-------|----------|---------|
| `deepseek-r1:8b` | General coding | `ollama pull deepseek-r1:8b` |
| `DeepHat/DeepHat-V1-7B` | 🔓 Red Team / Security | `ollama pull DeepHat/DeepHat-V1-7B` |
| `dolphin3:8b` | 🔓 Uncensored assistant | `ollama pull dolphin3:8b` |
| `llama3.1:8b` | General purpose | `ollama pull llama3.1:8b` |

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
│   │   └── tools.js           # Tool implementations
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
