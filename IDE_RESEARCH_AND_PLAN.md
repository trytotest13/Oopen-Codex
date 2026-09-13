# "Web-Chat IDE" — Research & Build Plan
**Goal:** A full IDE (in the spirit of Google Antigravity) where the chat panels are the **real web versions of ChatGPT and Claude**, and those chats can **map/modify your local files** through an agent.

**Date:** 2026-09-13 · All facts below verified against current sources (links included).

---

## Part 1 — Resources & Verified Facts

### 1.1 How Antigravity is actually built
Google Antigravity is a **fork of VS Code** (same approach as Cursor and Windsurf), repositioned as an "agentic development platform" — the IDE surface plus agents, CLI, and SDK around it.

- [antigravity.google](https://antigravity.google/) — official site
- [The New Stack: Antigravity Is Google's New Agentic Development Platform](https://thenewstack.io/antigravity-is-googles-new-agentic-development-platform/)
- [Visual Studio Magazine: Google Joins AI IDE Race… Apparently Forking VS Code](https://visualstudiomagazine.com/articles/2025/11/20/google-joins-ai-ide-race-to-compete-with-vs-code-apparently-forking-vs-code.aspx)

> Lesson: every modern "AI IDE" is either a VS Code fork or a framework that mimics VS Code. But **your requirement (embedding chatgpt.com / claude.ai web UIs) is the one thing a plain VS Code fork cannot do** — see 1.2.

### 1.2 Embedding the web chats — the hard constraint (verified)
**chatgpt.com and claude.ai both send `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` headers that forbid being embedded in an iframe.** This is enforced server-side; nothing in your app can override it.

- [Stack Overflow: "Refused to connect" / X-Frame-Options](https://stackoverflow.com/questions/62759349/iframe-site-name-refused-to-connect-error) — cannot be defeated client-side
- [OpenAI Community: chat.openai.com in an iframe — not possible](https://community.openai.com/t/chat-openai-com-in-an-iframe/33821)
- [Reddit r/ClaudeAI: embedding claude.ai via iframe — not possible, use API or own UI](https://www.reddit.com/r/ClaudeAI/comments/1htjm75/best_way_to_embed_a_claude_chat_interface_via/)
- [VS Code Webview API docs](https://code.visualstudio.com/api/extension-guides/webview) — a VS Code webview **is an iframe** and gets **no exemption** → in a plain VS Code fork, `chatgpt.com`/`claude.ai` in a webview shows "Refused to connect."

**What does work: Electron `WebContentsView`.** In Electron, the chat sites are loaded as **top-level browser content** (like a real browser tab), not as an iframe — so the frame-blocking headers don't apply. This is how all the "ChatGPT desktop wrapper" apps work.

- [Electron docs: Web Embeds (iframe vs webview tag vs WebContentsView)](https://electronjs.org/docs/latest/tutorial/web-embeds)
- [WebContentsView replaced the deprecated BrowserView](https://developer.mamezou-tech.com/en/blogs/2024/03/06/electron-webcontentsview/)
- [catgpt: spec for an Electron ChatGPT-web wrapper app](https://github.com/abandoned-industries/catgpt/blob/main/chatgpt-electron-agent-brief.md)
- [Medium: multi-AI (ChatGPT+Claude+Gemini) desktop shell in Electron](https://praveengineer.medium.com/how-i-built-a-browser-with-electron-without-building-a-browser-384592a74b20)

Login persistence: load each site with a **persistent session partition** (`session.fromPartition('persist:chatgpt')`) so you log in once and stay logged in.

### 1.3 Making the web chats able to touch your files — two bridge modes

**Mode A — MCP connectors (official, sanctioned — recommended).**
Both ChatGPT and Claude web can now call **remote MCP servers** you register yourself:

| | ChatGPT | Claude.ai |
|---|---|---|
| Feature | **Developer Mode** (full MCP client, read **and** write tools) | **Custom Connectors** (remote MCP) |
| Setup | Settings → Connectors → **Advanced → Developer Mode** → add server URL | Customize → Connectors → **+ → Add custom connector** → paste URL |
| Requirement | Paid plan, remote MCP server URL | Pro/Max (or Team/Enterprise), **public HTTPS** MCP URL |
| Sources | [OpenAI announcement](https://community.openai.com/t/mcp-server-tools-now-in-chatgpt-developer-mode/1357233), [devops.com walkthrough](https://devops.com/chatgpt-developer-mode-full-mcp-access-with-serious-responsibilities/), [guide](https://medium.com/@alexeylark/chatgpt-custom-mcp-connectors-with-developer-mode-d791fde17d25) | [Claude Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [setup guide](https://tactiq.io/learn/how-to-add-custom-connector-in-claude) |

Your local agent runs an **MCP server** exposing tools (`list_files`, `read_file`, `search_code`, `write_file`, `run_command`). Because connectors need a **public HTTPS URL**, expose the local server through a tunnel:

- `cloudflared tunnel --url http://localhost:8787` (free quick tunnels) — [Cloudflare docs](https://developers.cloudflare.com/pages/how-to/preview-with-cloudflare-tunnel/)
- `ngrok http 8787` — [ngrok](https://ngrok.com/compare/cloudflare-tunnel)
- Pattern reference: [xAI docs on tunneling custom MCP servers](https://docs.x.ai/grok/connectors/custom-mcp-tunneling), [awesome-tunneling list](https://github.com/anderspitman/awesome-tunneling)

**Mode B — DOM automation (powerful but ToS-risky — optional, at your own risk).**
Because you control the Electron `WebContentsView`, you can `webContents.executeJavaScript(...)` to: watch assistant messages, detect tool-call blocks the model writes (e.g. `​```tool:edit_file`), execute them via the local agent, then type the JSON result back into the composer and submit. Fully automatic "Antigravity-like" behavior with any chat. **However:** both companies' consumer terms prohibit automated/scripted access to the web apps, and Anthropic actively enforces (account restrictions). Verify current terms before shipping; make Mode A the default and Mode B an opt-in "Turbo" switch.

- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/) (prohibits scraping/automated collection)
- [Anthropic ToS updates / usage policy](https://privacy.claude.com/en/articles/9190861-terms-of-service-updates), [Anthropic usage policy](https://www.anthropic.com/news/updating-our-usage-policy)
- Enforcement context: [Wired — Anthropic revokes OpenAI's Claude access](https://www.wired.com/story/anthropic-revokes-openais-access-to-claude/), [VentureBeat — Anthropic cracks down on third-party harnesses](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses), [ToS explainer](https://autonomee.ai/blog/claude-code-terms-of-service-explained/)

### 1.4 Prior art (learn from, don't rebuild)
- [RepoRelay](https://www.reddit.com/r/LLMDevs/comments/1w315vi/i_built_a_bridge_that_lets_chatgpt_web_inspect/) — MCP bridge letting **ChatGPT Web read a local repo**
- [ha-mcp](https://community.home-assistant.io/t/brand-new-claude-ai-chatgpt-integration-ha-mcp/937847) — one MCP server registered in **both** claude.ai and ChatGPT web UIs
- [claude-code-router](https://github.com/musistudio/claude-code-router) — local model gateway/control plane for coding agents
- [catgpt brief](https://github.com/abandoned-industries/catgpt/blob/main/chatgpt-electron-agent-brief.md) — detailed Electron ChatGPT-web wrapper spec

### 1.5 Licensing rules if you ever fork VS Code
- The `microsoft/vscode` repo (Code-OSS) is MIT, **but** the VS Code *product* and its Marketplace are proprietary; Marketplace ToS forbids forks ("A fork of VS Code is not VS Code") — [microsoft/vscode#31168](https://github.com/microsoft/vscode/issues/31168)
- Forks must use [Open VSX](https://open-vsx.org/) (Eclipse Foundation registry) — context: [DevClass](https://www.devclass.com/development/2023/06/27/open-vsx-alternative-to-vs-code-marketplace-saved-from-closure-by-new-eclipse-working-group/1625540), [Hacker News](https://news.ycombinator.com/item?id=43785039)

### 1.6 IDE platform options compared

| Option | What it is | Pros | Cons | Fit for you |
|---|---|---|---|---|
| **Custom Electron + Monaco** | Build your own shell: [Monaco](https://github.com/microsoft/monaco-editor) editor, [xterm.js](https://xtermjs.org/) terminal, `WebContentsView` chat tabs | Full control; **only option where embedding the real web chats is first-class**; small codebase; fast MVP | You rebuild terminal/git/LSP yourself (libraries exist) | ✅ **Recommended (Phase 1)** |
| **VS Code fork (Code-OSS)** | Antigravity/Cursor approach | Complete IDE day 1 (debugger, extensions, remote) | Huge codebase, painful upstream merges; embedding web chats needs deep Electron-main surgery; Open VSX only | Phase 2 port target |
| **Eclipse Theia** | Open-source IDE **framework** (not a fork), web+desktop, VS Code-extension compatible via Open VSX | Clean framework, AI-native push ([Theia AI](https://theia-ide.org/)), [docs](https://eclipsesource.com/blogs/2026/07/02/eclipse-theia-in-practice-getting-started-lessons-from-the-field/) | Same iframe problem for chat sites; smaller ecosystem | Solid Phase 2 alternative |
| **OpenSumi** | Alibaba's TypeScript IDE framework, VS Code-style extension model | Cloud/desktop IDE infra, MCP-aware | Smaller community, CN-centric docs | Backup option ([docs](https://opensumi.com/en/docs/extension/overview/)) |

**Key architecture insight:** the **agent MCP server + bridge is shell-independent**. Build it once; it works whether the shell is your Electron app, a VS Code fork, or Theia.

---

## Part 2 — How the IDE should work & look

### 2.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     YOUR IDE (Electron shell)                           │
│                                                                         │
│  ┌────────────┐  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │ Workbench  │  │  CHAT SURFACE         │  │  AGENT SURFACE         │  │
│  │            │  │  (WebContentsView)    │  │                        │  │
│  │ • Explorer │  │  Tabs:                │  │  • Task board          │  │
│  │ • Monaco   │  │   [ChatGPT][Claude]   │  │  • Review queue:       │  │
│  │   editor   │  │   [Gemini ][Custom]   │  │    diff cards, approve │  │
│  │ • Search   │  │                       │  │  • Audit log + undo    │  │
│  │ • Git      │  │  persistent login     │  │  • Tool-call timeline  │  │
│  └─────┬──────┘  └───────────┬───────────┘  └───────────▲────────────┘  │
│        │  files/diffs        │ (user types)             │               │
└────────┼─────────────────────┼──────────────────────────┼───────────────┘
         ▼                     ▼                          │
┌──────────────────────────────────────────────────────────┴──────────────┐
│                 LOCAL AGENT SERVICE (Node, runs with IDE)               │
│  • MCP server (streamable HTTP on localhost:8787)                       │
│    tools: list_files · read_file · search_code · write_file ·           │
│           run_command (approval-gated) · git_snapshot/undo              │
│  • Guardrails: workspace-root jail, allowlist, approval modes, log      │
└───────────────▲─────────────────────────────────────────────────────────┘
                │  public HTTPS via tunnel
     cloudflared tunnel --url http://localhost:8787
                │
     ┌──────────┴───────────┐
     │ chatgpt.com          │  claude.ai
     │ (Developer Mode      │  (Custom Connector)
     │  connector)          │
     └──────────────────────┘
```

Two connection paths coexist:
1. **MCP path (default):** the chat sites call your tools directly through the connector. Clean, sanctioned, and the tool-call UI appears inside ChatGPT/Claude themselves.
2. **Injection path (opt-in "Turbo"):** the IDE injects JS into the chat `WebContentsView` to read replies, detect tool blocks, execute, and inject results — fully hands-free like Antigravity's agent manager. ToS-risk (see 1.3).

### 2.2 UI layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◈ MyIDE      my-project ▾            ChatGPT ● Claude ●  ⚙         │
├───┬──────────────────┬──────────────────────────┬───────────────────┤
│ A │  EXPLORER        │  EDITOR (Monaco tabs)    │  CHAT PANEL       │
│ c │  src/            │  utils.ts ●              │  [ChatGPT][Claude]│
│ t │    utils.ts      │  1 export function …     │  ┌───────────────┐│
│ i │    main.ts       │                          │  │ (real web UI) ││
│ v │  package.json    │  ← diff overlays when    │  │               ││
│ i │  .git/           │    agent proposes edits  │  └───────────────┘│
│ t │                  │                          │  [terminal tabs]  │
├───┴──────────────────┴──────────────────────────┴───────────────────┤
│  AGENT BAR  ▸ 3 tool calls · 1 edit pending review   [Review ▷]      │
│  TERMINAL / PROBLEMS / AUDIT LOG                                     │
└──────────────────────────────────────────────────────────────────────┘
```

- **Activity bar (left):** Explorer, Search, Git, **Agent Manager** (Antigravity-style task board: running tasks, artifacts, review queue), Settings.
- **Center:** Monaco editor with tabs; when the agent proposes a file change, an inline **diff card** appears (side-by-side, Accept/Discard per hunk).
- **Right:** dockable chat panel with real `WebContentsView` tabs — these are the genuine ChatGPT/Claude web apps (you log in once; sessions persist).
- **Bottom:** terminal (xterm.js), problems, audit log of every tool call the agent made (what file, when, by which chat, undone?).
- **Agent Bar:** always-visible status: "Claude is editing 2 files — Review", with a global **Panic** button (kill all pending writes, `git` restore snapshot).

### 2.3 End-to-end workflow (the magic moment)

1. **Open project** → IDE starts the agent service scoped to that folder and (first time) prints a one-time setup: run tunnel → paste URL into ChatGPT Developer Mode / Claude Custom Connectors (5 minutes, once per account).
2. You type in the **embedded ChatGPT tab**: *"Find where retries are handled and add exponential backoff."*
3. ChatGPT calls your connector tools: `search_code("retry")` → `read_file(http/client.ts)`. Your IDE lights up the touched files in the Explorer (activity indicator).
4. ChatGPT calls `write_file(http/client.ts, …)`. The IDE intercepts: shows a **diff card**. Default policy: *writes require approval; reads auto-approved; `run_command` requires approval + allowlist.*
5. You hit **Accept** → file written, editor jumps to the change, a `git` snapshot was taken *before* the edit (one-click undo).
6. The tool result ("file updated, 3 hunks") returns into the chat → the model continues/verifies — the loop feels native, like an agent built into the IDE.

### 2.4 Guardrails (non-negotiable)
- **Workspace jail:** agent can only touch paths inside the opened project.
- **Approval modes:** `read-only auto / write-ask / command-ask+allowlist / yolo (per-task only)`.
- **Audit + undo:** every mutation logged; auto git snapshot per task; global undo.
- **Tunnel auth:** token-protected MCP endpoint (a random path or OAuth) so nobody else can call your file tools; tunnel only runs while the IDE is open.
- **Secrets:** never auto-approve `.env` writes; blocklist `.env`, `.git/`, `id_rsa`, etc.

### 2.5 Build milestones

| Milestone | Deliverable | Est. |
|---|---|---|
| **M0** | Electron shell: open folder, file tree, Monaco editor, save | 1–2 wks |
| **M1** | Chat dock: `WebContentsView` tabs for chatgpt.com + claude.ai, persistent login, zoom/reload | 3–5 days |
| **M2** | Agent service: MCP server (list/read/search/write/terminal) + `cloudflared` tunnel launcher + connector registration guide | 1–2 wks |
| **M3** | IDE-native approvals: diff cards, audit log, snapshots/undo, guardrails | 2–3 wks |
| **M4** | Agent Manager board (multi-task, like Antigravity), "Turbo" injection mode (opt-in), Gemini tab, custom-URL tab | ongoing |
| **M5 (optional)** | Port workbench into VS Code fork or Theia for full IDE parity; reuse same agent service | big |

**Stack:** Electron + TypeScript · Monaco · xterm.js + node-pty · `@modelcontextprotocol/sdk` · simple-git · cloudflared · React (for your own panels).

---

## Part 3 — API support (complete list)

### 3.1 The bridge APIs (core of your product)
- **MCP — Model Context Protocol** (the standard both ChatGPT & Claude web consume): expose your agent as a **remote MCP server** using **streamable HTTP** transport on localhost, published via tunnel. [MCP spec](https://modelcontextprotocol.io/) · SDKs in TS/Python.
- **Tunneling APIs:** cloudflared (free, no account for quick tunnels), ngrok (dashboard + inspection), Tailscale Funnel (private option).
- **Connector registration:** ChatGPT *Developer Mode* (Settings → Connectors → Advanced) and Claude *Custom Connectors* (Customize → Connectors) — see 1.3 for links. Optional OAuth 2.0 on your MCP endpoint if you distribute this to other users.

### 3.2 Chat/model provider APIs (for built-in fallback chat & future native agents)
Keep **one OpenAI-compatible adapter layer** — nearly every provider (including local ones) speaks it:
- **OpenAI** — Chat Completions & Responses API
- **Anthropic** — Messages API
- **Google Gemini** API
- **OpenRouter** — one key, 300+ models
- **Groq / DeepSeek / Mistral / xAI** — OpenAI-compatible endpoints
- **Local:** Ollama, LM Studio, llama.cpp server (`http://localhost:11434/v1` style) — same adapter, zero cost, offline

This gives you a native "IDE chat" for when the web tabs aren't enough (and covers accounts without paid plans).

### 3.3 Platform & editor APIs (the IDE itself)
- **Electron:** `WebContentsView` (embed chats), `session.fromPartition('persist:…')` (logins), `webContents.executeJavaScript` (Turbo mode), IPC main↔renderer, `shell.openExternal`.
- **Monaco editor API:** models, decorations (paint agent edits), diff editor (built-in — use it for review cards).
- **LSP (Language Server Protocol)** + **DAP (Debug Adapter Protocol):** attach real language servers/debuggers to your Monaco workbench (Phase 2).
- **Tree-sitter** (syntax-aware code maps for the agent), **simple-git / isomorphic-git** (snapshots, undo, git panel).
- **xterm.js + node-pty:** real terminal; `run_command` tool streams here so the user sees what the agent runs.

### 3.4 Account requirements (verified)
- **ChatGPT:** paid plan + Developer Mode toggle for full read/write MCP connectors.
- **Claude:** Pro/Max (or Team/Enterprise) for custom connectors.
- Tunnel + your MCP server: free, runs on your machine.

---

## TL;DR decision record
1. Antigravity-style IDE = VS Code fork — **but** ChatGPT/Claude web **cannot** be embedded in VS Code webviews (iframe-blocked). 
2. **Winner:** your own **Electron + Monaco** IDE where chats are `WebContentsView`s (real web apps, persistent login).
3. File access = your **local agent as a remote MCP server** (streamable HTTP) published via **cloudflared/ngrok tunnel**, registered once in **ChatGPT Developer Mode** and **Claude Custom Connectors**. Sanctioned by both platforms.
4. Optional **Turbo mode** injects JS to fully automate the chats (Antigravity-like) — powerful but against both companies' ToS; keep opt-in and understand the account-ban risk.
5. The agent MCP server is shell-independent — build it first; if you later want full VS Code parity, port the shell (fork/Theia) and keep the agent.
