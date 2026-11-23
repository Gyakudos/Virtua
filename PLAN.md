# Virtual Assistant — Build Plan

**Status:** Phases 0–9 implemented as build `0.010.19.11.26`
**Build log:** `0.010.19.11.26` — Electron scaffold, Ollama chat (one-shot + streaming), SQLite persistence, personas, ChatRP window with character behavior editor, notes/tasks/reminders tools, function-calling agent loop, approval UI, audit log, local knowledge/RAG with `nomic-embed-text` embeddings, a dev helper with repo-scoped code/git tools and approval-gated test running, program connectors (Opera bookmarks, VS Code settings, app control, on-demand local screen OCR), bounded local file-name/text search, local image OCR for pasted pictures and image files, a local VRoid avatar with chat-driven states/quality settings/2D fallback, desktop polish (tray, global hotkey, reminders as OS notifications, theme toggle, JSON backup, desktop shortcut), and optional extras (local SAPI/Piper speech, Whisper WASM dictation, audio-driven lip-sync, and `.ics` calendar import), Android bridge/sync, local-first phone mode, and a manual GitHub update check.
**Goal:** A private, **strictly local-only** desktop assistant for personal productivity, chat/knowledge, code help — with a VRoid avatar and the ability to read files, app data, and screens you allow. No cloud services, no telemetry, no runtime network calls.
**Hardware assumption:** Windows machine with an **AMD or Intel GPU** (integrated or discrete). Expect GPU acceleration via Vulkan/DirectX where available, but plan for a CPU/low-graphics fallback.

---

## 1. What we're building

A desktop app you talk to in natural language, with an animated VRoid character on screen. Everything runs locally: a local LLM (Ollama) thinks, a local tool layer acts, and local storage keeps your data.

### Capability pillars

| Pillar | Example requests |
| --- | --- |
| Personal productivity | "Add a task to renew passport on Friday", "What's on my plate this week?", "Note that the Wi-Fi password is ..." |
| Chat + knowledge | "Explain quantum tunneling simply", "What did I write about the trip in my notes?", "Summarize my last meeting notes" |
| Code / dev helper | "Where is auth handled in this repo?", "Explain this diff", "Write a test for `parseDate`" |
| Program + screen awareness | "What bookmarks do I have about design?", "Read the Spotify window — what's playing?", "Open my project in VS Code" |
| VRoid companion | Avatar reacts while listening/thinking/speaking; future lip-sync with local TTS |

**Non-goals (now firm constraints):** any cloud/API calls, web search, cloud calendar sync, telemetry, multi-user, continuous background screen recording, autonomous unapproved actions. Offline after initial setup. Mobile is a local-first hybrid: the Android app runs on phone hardware and can sync with the desktop over an opt-in LAN/Tailscale bridge. The only other outbound request is the manual GitHub update check, and only when the user clicks it.

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│ Desktop shell — Electron + React + TypeScript                    │
│  ├─ Main window: assistant chat, tools, approvals, settings      │
│  ├─ ChatRP window: separate, minimizable, always-on-top optional │
│  ├─ VRoid avatar renderer (Three.js + @pixiv/three-vrm, WebGL)   │
│  └─ Tray, global hotkey, notifications, screen-capture indicator │
└────────────────────────────┬──────────────────────────────────────┘
                             │ typed IPC
┌────────────────────────────▼──────────────────────────────────────┐
│ Assistant core — Node/TypeScript                                 │
│  ├─ Ollama client (chat, streaming, tools, embeddings)           │
│  ├─ Agent loop (think → tool call → observe → answer)            │
│  ├─ Tool registry (Zod schemas + handlers + risk levels)         │
│  ├─ Permission gate (approvals, allowlists, deny-list, audit)    │
│  ├─ RAG pipeline (ingest → chunk → embed → retrieve)             │
│  ├─ Storage (SQLite + sqlite-vec)                                │
│  └─ Connector manager                                            │
│       ├─ Filesystem: read anywhere, deny-list for secrets        │
│       ├─ App-data parsers (per-app approval)                     │
│       ├─ App-control adapters (per-app approval)                 │
│       └─ Screen capture + OCR (per-window, on demand)            │
└────────────────────────────┬──────────────────────────────────────┘
                             │ localhost HTTP (11434)
┌────────────────────────────▼──────────────────────────────────────┐
│ Ollama (local daemon)                                            │
│  Chat: qwen2.5:7b-instruct (or 3b on weaker GPUs)                │
│  Embeddings: nomic-embed-text                                    │
└───────────────────────────────────────────────────────────────────┘
```

### Why this stack

- **Electron + React/TS** — fastest path to a real Windows desktop app; easy packaging with `electron-builder`; WebGL works for the avatar.
- **Ollama** — one install, HTTP API with streaming, function calling, embeddings, model switching. On AMD/Intel it can use Vulkan/CPU; slower than NVIDIA, so prefer quantized 3B–7B models.
- **SQLite + sqlite-vec** — one embedded file for both structured data and vector search; no server.
- **Three.js + @pixiv/three-vrm** — standard way to render `.vrm` avatars on the web/desktop; supports expressions, bone look-at, and animations.
- **TypeScript end-to-end** — shared types across UI, tools, connectors, and storage.

Alternative: keep Electron but put the core in a Python FastAPI service if you want easier access to PDF/OCR/ML libraries. Say the word and I'll swap it.

---

## 3. Core components

### 3.1 Ollama client
- `/api/chat` streaming, `/api/embed`, `/api/tags`, model pull with progress.
- Model selector in UI; auto-detect available VRAM/RAM and suggest model size.
- Context budgeting: trim history, keep system prompt + tool results.

### 3.2 Agent loop
1. Send user message + history + tool schemas to the model.
2. On tool call: validate args (Zod), check permissions, execute, append result, loop.
3. Otherwise stream the final answer; drive avatar state (`listening → thinking → speaking`).
4. Cap iterations (e.g. 8); surface errors instead of looping forever.

### 3.3 Tool registry & permissions
Every tool declares name, description, Zod schema, handler, and risk level.

| Risk | Examples |
| --- | --- |
| Safe | `notes.search`, `tasks.list`, `files.read`, `code.search`, `appdata.read` (approved apps), `screen.read` (approved window, on demand) |
| Write | `notes.create`, `tasks.add`, `reminders.create`, `calendar.create` (local `.ics` only), `app.control` (approved apps) |
| Sensitive | `files.write`, `shell.run`, UI automation — **off by default**, per-call confirmation |

Because you want all folders readable, guardrails matter:
- Read access is broad by default, but a **deny-list** blocks credential-like paths (`.ssh`, `.aws`, `.env`, browser `Login Data`, password stores, OS credential stores).
- RAG indexing is **only** on folders you explicitly add — never the whole disk.
- Writes and shell commands always ask, even with broad read access.

### 3.4 Storage
SQLite tables: `conversations`, `messages`, `notes`, `tasks`, `reminders`, `tool_audit`, `settings`, `rag_sources`, `rag_documents`, `rag_chunks` (embeddings stored as Float32 BLOBs with cosine similarity computed locally — sqlite-vec not required for current corpus sizes), and `app_permissions` (per-app connector grants).

Backup: versioned JSON snapshot of all SQLite tables plus settings from Data → system. "Export for Android" writes the same JSON and copies referenced `.vrm` files into an `avatars/` folder; restore imports a snapshot transactionally. Knowledge chunks/embeddings are intentionally not carried in the snapshot — RAG sources are restored as idle and must be re-indexed locally.

### 3.5 Knowledge / RAG ✅ implemented
- Ingest explicitly chosen folders (`.md`, `.txt`, source code, config/data text); hash-based incremental re-indexing. `.pdf` is not parsed yet.
- Chunk by section/paragraph with overlap (~1400 chars, 200 overlap); embed with `nomic-embed-text` (768 dims).
- Top-K retrieval with a 0.2 cosine threshold; inject cited `[n]` snippets into chat and agent prompts; show source chips and a searchable Knowledge drawer.
- Tools `knowledge.search` and `knowledge.sources` let the agent query the index. Credential-like paths are deny-listed; no whole-disk indexing.

### 3.6 Program connectors ✅ implemented (you asked for all four kinds)
Each connector is opt-in per app/window and visible in the **Connections** drawer (button in the toolbar or `/connections`). Grants live in `app_permissions` and can be revoked at any time; nothing is read or launched until granted.

1. **Project/source files** — covered by the Knowledge/Dev helper phases (explicitly added folders only).
2. **App data/settings** ✅ — **Opera bookmarks** (primary browser; `APPDATA\Opera Software\Opera Stable\Bookmarks`) and **VS Code settings** (`settings.json` JSONC + installed extensions). Known parsers only, no arbitrary binary reads. Chrome/Edge are not targeted.
3. **App control** ✅ — `app.control` opens a URL in Opera or a file/folder in VS Code/Notepad via `spawn` with `shell: false`; write risk, always approved per call, credential paths and non-existent targets blocked. Generic Windows UI clicking/automation remains a later research item.
4. **Screen reading** ✅ — `desktopCapturer` captures one chosen window on demand → local OCR via `tesseract.js` using bundled `assets/ocr/eng.traineddata.gz` (no cloud OCR, no runtime download). Requires both the `screen.read` grant and a per-capture approval; a visible "Screen being read" banner shows while active. Captures are saved under user-data `captures/` only; no continuous background recording. `VA_OCR_PATH` can override the language-data folder for custom packaging.

Connector tools (21 total): `connectors.list`, `opera.bookmarks`, `vscode.settings`, `app.control`, `screen.windows`, `screen.read`.

### 3.7 VRoid avatar ✅ implemented
- Renders a user-chosen local `.vrm` with Three.js + `@pixiv/three-vrm` in a WebGL canvas docked in the main window (toggle with **Avatar** or `/avatar`).
- `avatar:pickVrm` uses a native file dialog; the main process reads the bytes and the renderer parses them with `GLTFLoader` + `VRMLoaderPlugin`. No network, no renderer filesystem access, no upload.
- States driven by chat: idle (breathing blink + slow sway), listening (typing), thinking (waiting, head tilt), speaking (streaming, mouth `aa` + bob), error (sad expression, auto-reset after 2.5s). Look-at follows the cursor via `vrm.lookAt.target`.
- **Quality:** Low = 30 FPS cap, 1× pixel ratio, `low-power` GPU, no antialiasing; High = 60 FPS, up to 2× pixel ratio, antialiasing. Renderer string is detected with `WEBGL_debug_renderer_info`.
- 2D CSS avatar fallback when WebGL is unavailable, the renderer is software, or no model is loaded.
- Config (visibility, quality, last `.vrm` path) persists in the `settings` table; the model file itself stays where the user put it.
- Later: draggable always-on-top overlay, lip-sync from local TTS visemes, character-emotion tie-in, multiple outfits. Respect the `.vrm` model's license.

**AMD/Intel GPU notes:**
- WebGL2 via ANGLE/DirectX should work; performance varies, especially on integrated graphics.
- Add a graphics-quality setting: low (no shadows/post-processing, 30 FPS, small canvas) → high.
- Auto-detect renderer via `WEBGL_debug_renderer_info`; offer **2D/static-avatar fallback** if WebGL is unavailable or slow.
- LLM inference on AMD/Intel is slower; default to `qwen2.5:3b-instruct` if 7B feels sluggish.

### 3.8 Chat function (core UX)

Chat is the primary way you talk to the assistant — it is Phase 1, not an add-on.

- **Conversations:** multiple named chats, auto-title from first message, search, archive, delete.
- **Streaming:** token-by-token replies with Stop, Regenerate, and Edit-message controls.
- **Formatting:** markdown with syntax-highlighted code blocks, copy buttons, tables, and links.
- **Persona:** editable system prompt with presets — General, Productivity, Code, Study.
- **Model control:** choose 7B vs 3B per conversation; advanced sliders for temperature/context length.
- **Context attachments:** add notes, files, folders, or a repo to a chat; tool results appear inline as cards.
- **Slash commands:** `/task`, `/note`, `/search`, `/read screen`, `/model`.
- **History tools:** pin important messages, export a conversation to markdown.
- **Avatar integration:** chat drives `listening → thinking → speaking → idle` states.
- **Keyboard-first:** Ctrl+K new chat, Esc stop, Enter send, Shift+Enter newline.
- **Local only:** all history lives in SQLite; no network features exist to enable.

### 3.9 ChatRP — character roleplay window

A **separate, minimizable window** called **ChatRP** for in-character roleplay, distinct from the utility chat above. Think of it as a character companion rather than a tool interface.

- **Own window:** Electron `BrowserWindow` — minimize, resize, drag, optional always-on-top/overlay mode, quick toggle from tray or global hotkey.
- **Character cards:** name, avatar (`.vrm` or image), backstory, personality, speaking style, scenario, greeting message. Store multiple characters and switch between them.
- **In-character / OOC:** toggle or `OOC:` prefix to step out of character; narration/actions rendered in italics.
- **Character memory:** per-character short-term context plus a long-term memory/relationship summary stored in SQLite, separate from assistant chat history.
- **Roleplay controls:** Regenerate, Continue, Edit last message, Rewind to a previous turn, pin canon moments.
- **Scenario tools:** set scene/location, mood, and "memory notes" the character should remember; import/export character cards as JSON.
- **Avatar tie-in:** the RP window can dock the shared local VRM renderer beside the chat. A character may set its own `.vrm` path, otherwise the main avatar model is used as a fallback. RP conversation state drives `idle/listening/thinking/speaking/error` and the relaxed idle pose; character emotion tags can still drive expressions.
- **Boundaries:** configurable tone/content limits; everything stays local.

### 3.10 Character behavior programming (traits + rules)

A visual editor in **ChatRP → Character → Behavior** to "program" how the character acts, rather than only describing it in prose.

**Trait sliders (0–100):**
Warmth, curiosity, humor, shyness, formality, energy, empathy, stubbornness, playfulness, patience. Save named presets (e.g. "calm mentor", "tsundere", "excited assistant") and override per character.

**Conditional rules — `when [condition] → do [action]`:**

| Condition examples | Action examples |
| --- | --- |
| `curiosity >= 70` | End replies with one relevant follow-up question |
| `shyness >= 60` | Shorter sentences; VRM look-at offset (avoid direct eye contact) |
| `humor >= 50` and context is casual | Add a light joke or teasing remark |
| `user mood == sad` | Switch to gentle tone; expression = concerned |
| `relationship >= "friend"` | Use the user's nickname; allow warmer banter |
| `on greeting / on goodbye / on topic X` | Play wave animation; change scene; recall a canon moment |

**Rule format:**
- Default: declarative JSON/YAML rules evaluated by a small safe engine (no arbitrary code execution).
- Priority + specificity ordering; conflict resolution with a "last rule wins" fallback.
- Debug panel shows which rules fired for a given reply, with a "Test line" preview box.
- Advanced (optional): sandboxed QuickJS/isolated-worker snippets with an allowlisted API, disabled by default.

**Integration:**
- Base persona + trait preset + per-character overrides, all exported with the character card JSON.
- Rules can set VRM expressions/animations, tweak temperature/system prompt, or add memory notes.
- Rules cannot disable the global safety boundaries or introduce network access; shell actions still require the normal approval flow.
- Storage: `character_traits` and `character_rules` tables in SQLite.

### 3.11 Dev helper ✅ implemented
- Repos are folders explicitly added to Knowledge; `dev.repos` lists them and flags `.git` repos.
- Read-only tools: `code.search` (indexed snippets, optional extension filter), `code.read` (inside added folders only), `git.status`, `git.diff`.
- `tests.run` is a **sensitive** tool: approval card every call, no shell, allowlisted local commands, 180s timeout, streamed output in the Dev drawer.
- Chaining/redirects/variables, arbitrary binaries, absolute paths, `..` segments, and paths outside added folders are rejected before spawn.
- Current limitation: "diff explain" is natural-language via the chat/agent reading `git.diff` output; there is no separate diff-summarizer model yet.

### 3.12 Desktop polish ✅ implemented
- Tray icon with Show assistant / Open ChatRP / Quit; embedded locally-generated PNG, no external asset.
- Global hotkey `Ctrl+Alt+Shift+V` focuses (or restores) the main window; registered on ready and unregistered on quit.
- Reminders are checked every 30s against `fireAt`; due reminders within a 5-minute window show a native OS notification once per session.
- Light/dark theme toggle persisted in `settings`; dark remains the default.
- JSON backup exports all local app data (conversations + messages, personas, characters, notes, tasks, reminders, calendar events, audit, RAG sources, app permissions, settings) through a native save dialog. No cloud, no auto-upload.
- Desktop shortcut `Virtual Assistant.lnk` can be created/recreated/removed via Data → system using `shell.writeShortcutLink`; in dev it targets `electron.exe` with `.` args and the project folder as cwd, so it works from source. A shortcut is already created on this machine.

### 3.13 Optional extras ✅ implemented
- **Local calendar:** `.ics` files are picked with a native dialog and parsed in-process: line unfolding, escaped text, `SUMMARY`, `DESCRIPTION`, `DTSTART`/`DTEND` (`VALUE=DATE`, `Z`, and `TZID` via `Intl`), and `UID`. Events are stored in a new `calendar_events` table with a unique UID; re-imports skip existing UIDs. Future events also create local reminders, which use the existing OS-notification path. Recurrence rules are not expanded.
- **Local TTS:** Windows SAPI through `System.Speech.Synthesis` in a short-lived PowerShell process writes a WAV to a temp file, which is read into memory and returned to the renderer over IPC. No network, no downloaded voice. An optional Piper adapter accepts a user-provided local executable/model/config and pipes text over stdin. Active synthesis can be stopped by killing the child process.
- **Local STT:** `whisper.cpp` WASM runs in the main process with its binary embedded in the npm package. The seeded `assets/voice/ggml-tiny.en.bin` (~74 MB) is mounted into Emscripten's virtual filesystem from disk; transcription output is captured through the module's `print` hook. Renderer captures microphone audio with `ScriptProcessorNode`, resamples to 16 kHz mono, and sends it over IPC (30s cap). `print` output is stripped of timestamp/system lines. No runtime downloads.
- **Lip-sync:** Web Audio `AnalyserNode` on the played TTS `<audio>` computes RMS amplitude; the level is passed to `Avatar` without React re-renders and drives VRM `aa`/`oh` expression values plus the 2D fallback mouth height/width.
- **Voice UI:** toolbar **Voice** tab stores engine/rate/voice/language settings locally; composer **Listen** / **Speak** buttons; stop controls cancel generation and playback. Microphone permission is granted only to the app's own local page.
- **Verification:** isolated smoke test confirmed ICS parsing (2 events, TZID and all-day), UID dedupe on re-import, SAPI WAV generation, and Whisper transcription of that locally generated speech (`Local Voice Test 1 2 3`).

### 3.14 Android migration foundation ✅ implemented
- `buildBackupPayload()` produces a versioned, portable snapshot (`format: 2`) of conversations+messages, personas, characters, notes, tasks, reminders, calendar events, audit, RAG source list, app grants, and settings.
- **Restore** replaces all local data in one SQLite transaction; malformed bundles roll back. RAG sources return as `idle` with no fake vector counts, so they must be re-indexed locally.
- **Export for Android…** writes the JSON snapshot into a chosen folder and copies every referenced `.vrm` into `avatars/`, with a `sourcePath → fileName` map for the future Android importer to remap avatar paths. Credential-like paths are skipped; no avatar is bundled inside the app.
- The Android app can reuse `src/shared/types.ts`, the React renderer, and the `window.api` method signatures in `src/renderer/src/vite-env.d.ts`. The Electron preload and main process are replaced by a Kotlin/WebView bridge plus native adapters.

### 3.15 Android runtime ✅ implemented
- `src/mobile/` builds a separate Vite bundle that shares the desktop React components and swaps `window.api` for either a phone-local adapter or a desktop-link WebSocket adapter.
- **Phone mode** stores snapshots in `localStorage` and runs GGUF models through `dev.ffmpegkit-maintained:llama-android` behind the existing `chatOnce` / `chatStream` contract. SAF import keeps models and VRM files app-private; no avatar or model is bundled in the APK.
- **Linked mode** connects to the desktop bridge at `/bridge?role=phone&token=...` and proxies `window.api` calls and stream events over the local WebSocket. Only LAN, mDNS, localhost, and Tailscale-style addresses are accepted.
- `sync:pull` returns `buildBackupPayload(BUILD_VERSION)`; `sync:push` routes to the transactional `restoreBackup()` path. Pull and push are explicit user actions in the phone UI.

---

## 4. Build phases

| Phase | Deliverable | Rough size |
| --- | --- | --- |
| **0. Foundation** ✅ | App scaffold, Ollama health check, one-shot + streaming chat | Implemented |
| **1. Chat function + core** ✅ | Multi-conversation UI, streaming, markdown, model picker, persona, search/export, avatar state hooks | Implemented |
| **1b. ChatRP window** ✅ | Separate minimizable window, character cards, OOC mode, per-character memory, trait sliders + rule editor, avatar expressions | Implemented |
| **2. Tools + agent loop** ✅ | Notes/tasks/reminders, function calling, approval UI, audit log | Implemented |
| **3. Knowledge / RAG** ✅ | Folder indexing, embeddings, retrieval, cited answers | Implemented |
| **4. Dev helper** ✅ | Repo indexing, code search/read, diff explain, run tests (approved) | Implemented |
| **5. Program connectors** ✅ | Per-app approvals, app-data parsers, app-control adapters, on-demand screen OCR | Implemented |
| **6. VRoid avatar** ✅ | VRM render, idle/listen/think/speak states, quality settings, 2D fallback | Implemented |
| **7. Desktop polish** ✅ | Tray, hotkey, OS reminders, theme toggle, backup/export, desktop shortcut | Implemented |
| **8. Optional extras** ✅ | Local voice (SAPI/Piper + Whisper WASM), lip-sync, local `.ics` calendar import | Implemented |
| **9a. Android migration foundation** ✅ | Transactional backup restore + Android bundle export (JSON + copied `.vrm` files) | Implemented |
| **9b. Linked Android companion** ✅ | Desktop bridge over LAN/Tailscale, shared React renderer with an Android `window.api` adapter, SAF import | Implemented |
| **9c. Standalone Android mode** ✅ | On-device storage + GGUF/`llama.cpp` inference behind the same API contract, SAF model/VRM import, Android TTS | Implemented |
| **10. Smoke-test release** ✅ | Windows NSIS setup, Android debug APK, GitHub release `000.015.002.2026`, manual update check, PC Port panel with Pair New/Sync/Trusted Devices | Implemented |

Phases 0–2 = "useful assistant". Phases 3–6 = "yours". Phase 9 is phased as linked-first, standalone-second.

---

## 5. Privacy & safety defaults

- **Strictly local-only by default:** no telemetry, no cloud APIs, no automatic runtime network calls. Everything runs on-device; data never leaves the machine.
- **Setup exception:** the first Ollama model download needs internet, unless we pre-seed model files from a local copy/USB. After that, fully offline. The app itself and the `.vrm` file are local assets.
- **Manual update exception:** the GitHub release check sends one API request only after the user clicks **Check for update**; release pages open only after another click.
- **Android sync exception:** the phone bridge is opt-in, token-paired, and limited to LAN/mDNS/localhost/Tailscale addresses. There is no cloud relay or account.
- Broad file reads, but credential deny-list + no whole-disk indexing.
- Screen reading only for approved windows, on demand, with a visible indicator.
- App control only for apps you approve; shell/UI automation off by default and confirmed per call.
- Secrets in OS credential store; every tool call logged and reviewable in UI.

---

## 6. Offline setup / model provisioning

To honor "local only," the app ships ready to run with no network needed at runtime:

1. **Bundle/pre-seed models** — download `qwen2.5:7b-instruct` (or `3b`) and `nomic-embed-text` once on a connected machine, then copy the Ollama model blobs/manifests into the installer or a local `models/` folder.
2. **First-run provisioning step** — installer detects bundled models and imports them into Ollama's local store (`ollama create`/copy into the models dir); no download prompt.
3. **Offline check** — startup verifies required models exist locally; if missing, show a clear "copy model files here" instruction instead of attempting a download.
4. **Local assets** — the `.vrm` file, OCR data, voice models (if added), and character cards all ship or live on disk.
5. **No auto-update fetch** — updates are manual/offline packages only.

---

## 7. Decisions still open

1. **Installer signing** — the NSIS setup is built and published, but unsigned; a code-signing certificate is still needed to avoid SmartScreen warnings.
2. **VRM asset** — resolved for now: use **Avatar → Load .vrm** to pick any local model; a 2D placeholder covers development/testing. No bundled model until you provide one you have rights to.
3. **Priority apps** — resolved for v1: Opera (browser) + VS Code + Notepad; media players and others can be added later.
4. **Voice** — resolved: built in now with Windows SAPI + seeded Whisper `ggml-tiny.en`; Piper is optional through local paths in the Voice tab.
5. **GPU details** — integrated AMD/Intel or a discrete card? (Affects avatar quality settings and model size.)

---

## 8. First steps when you say "go"

1. Scaffold Electron + Vite + React + TypeScript in this folder.
2. Add Ollama client with streaming chat and local model detection (offline check included).
3. Build minimal chat window (send → streamed reply).
4. Verify with a pre-seeded `qwen2.5:7b-instruct`, fall back to `3b` if slow.
5. Then proceed to Phase 1.

**Current state:** the app is implemented through Phase 10 (build `0.010.19.11.26`, release `000.015.002.2026`). The Windows setup and Android APK are published on GitHub as a full release. The PC has a top-level **Port** panel with Pair New, Sync, and Trusted Devices; the APK has a Portable Sync tab. See the phase table above and `README.md` for what works today.
