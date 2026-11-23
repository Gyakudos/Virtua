# Virtual Assistant

**Build:** `0.010.19.11.26` (Major.Minor.Day.Month.Year — 19 Nov 2026)
**Phase:** 9 — Android companion, on-device phone mode & desktop sync (includes Phases 0–8)

A strictly local-only desktop assistant. No cloud APIs, no telemetry, no runtime network calls.

## What works in this build

- Electron desktop shell (Windows) with React UI
- Ollama health check + local model picker (loopback only)
- One-shot and streaming chat with Stop/cancel
- **Persistence:** SQLite via Node's built-in `node:sqlite` (no native dependency)
  - Multiple assistant conversations: create, search, rename via messages, archive, delete
  - Messages: edit, pin, delete, regenerate, export to Markdown
- **Personas:** four built-in presets (General, Productivity, Code, Study) plus custom persona editor
- **ChatRP:** separate minimizable window (`ChatRP` button in the sidebar)
  - Character cards with persona, backstory, greeting, avatar path, shared memory
  - Character behavior programming: trait sliders + conditional rules (`when curiosity>=70 → ask a follow-up`)
  - In-character/OOC toggle, italic `*narration*`, per-character conversation history
  - Always-on-top toggle, character JSON import/export
  - **VRM roleplay figure:** the RP window can dock the same local VRM renderer beside the chat; the shared VRM appears immediately (even before choosing a character); a character can set its own `.vrm` path, otherwise the main avatar model is used. Idle/listening/thinking/speaking/error states follow the RP conversation
- Keyboard: `Ctrl+K` new chat, `Enter` send, `Shift+Enter` newline, `Esc` stop
- **Tools + agent mode:** enable **Agent mode** in the toolbar to let the local model call tools
  - Tools: `notes.create`, `notes.search`, `tasks.add`, `tasks.list`, `tasks.complete`, `reminders.create`, `system.time`
  - **Local image OCR:** `images.ocr` reads text from a local image file (pasted images are OCR-ed automatically in the composer)
  - **Local file search:** `files.search` finds files by name and/or text content (read-only, local-only, bounded results; defaults to your home folder, accepts an absolute `root`, and skips credential paths)
  - Safe tools run automatically; write tools show an Approve/Deny card (120s timeout → denied)
  - Tool activity chips and a **Data** drawer (tasks / notes / reminders / audit) show state and history
  - Every call is written to the `tool_audit` table and is reviewable in the UI
- **Knowledge / RAG:** click **Knowledge** (or type `/knowledge`)
  - Add a folder with the native folder picker; only explicitly added folders are indexed
  - Supports text/source/document formats (`.md`, `.txt`, `.ts`, `.js`, `.py`, `.json`, `.pdf` is **not** included yet)
  - Hash-based incremental reindexing: unchanged files are skipped
  - Credential-like paths (`.ssh`, `.aws`, `.env`, browser login data, etc.) are deny-listed
  - `nomic-embed-text` embeddings stored locally in SQLite; retrieval uses cosine similarity
  - **Use knowledge** toggle injects cited snippets into every chat/agent prompt
  - `knowledge.search` and `knowledge.sources` tools let the agent query the index
- **Dev helper:** click **Dev** (or type `/dev`)
  - Repos come from folders you added in Knowledge; `git status` and `git diff` are read-only
  - Tools: `dev.repos`, `code.search`, `code.read`, `git.status`, `git.diff`, `tests.run`
  - `tests.run` is **sensitive**: always shows an approval card, runs without a shell, and only accepts an allowlisted command (`npm test`, `npm run test|typecheck|build|lint|check`, `node --test`, `pytest`, `python -m pytest`, `cargo test`, `go test`, `dotnet test`, `vitest`, `jest`) inside added folders
  - Chaining (`&&`, `;`, pipes, redirects), arbitrary binaries, and paths outside added folders are blocked
- **Connections / program connectors:** click **Connections** (or type `/connections`)
  - Per-app grants stored in SQLite (`app_permissions`); revoke any time; nothing is read or launched until granted
  - **Opera bookmarks** (primary browser) — reads local bookmark names, URLs, and folders from `Opera Stable\Bookmarks`; Chrome/Edge are not targeted
  - **VS Code settings** — reads `settings.json` (JSONC comments tolerated) plus installed extension IDs
  - Tools: `connectors.list`, `opera.bookmarks`, `vscode.settings`, `app.control`, `screen.windows`, `screen.read`
  - **App control** (`app.control`) is **write** risk: opens a URL in Opera or a file/folder in VS Code/Notepad — always shows an approval card, no shell, credential paths blocked
  - **Screen reading** (`screen.read`) is **sensitive**: pick one window from `screen.windows`, grant the connector, then approve each capture; a visible "Screen being read" banner appears while active
  - OCR is fully local via `tesseract.js` with bundled `assets/ocr/eng.traineddata.gz` — no cloud OCR, no runtime download
  - Screen captures are written only under the app's user-data `captures/` folder; no continuous/background recording
  - **Paste images into chat** (main chat or ChatRP): Ctrl+V an image and its text is read with the same local OCR and inserted into your message; the PNG is saved only in `captures/`
  - `images.ocr` tool reads text from a local image file, so the agent can OCR screenshots or pictures found with `files.search`; credential paths are blocked
- **VRoid avatar:** click **Avatar** (or type `/avatar`) to open a docked avatar panel
  - **Load .vrm** picks a local `.vrm` file through a native dialog; the file stays on your machine (no upload, no network)
  - Three.js + `@pixiv/three-vrm` renders the model with idle breathing/blinking, head-follows-cursor, and state-driven motion
  - Chat drives the state: `idle` → `listening` (typing) → `thinking` (waiting) → `speaking` (streaming) → `error` (failed call)
  - **Quality:** Low (30 FPS, 1× pixel ratio, `low-power` GPU) or High (60 FPS, up to 2× pixel ratio, antialiasing)
  - WebGL/software-renderer detection; a CSS **2D fallback** appears when WebGL is unavailable or no model is loaded
  - Config (visibility, quality, zoom, VRM path) is stored locally in SQLite
  - The VRM default T-pose is replaced with a relaxed idle stance: lowered arms, slight elbow bend, gentle breathing/sway (blended in over about 0.5 s)
  - Zoom: slider, +/- buttons, or scroll over the preview (60%-250%); reset returns to 100%. Applies to the VRM and the 2D fallback
- **Desktop polish:** open **Data → system** (or type `/system`)
  - **Desktop shortcut** — create/recreate or remove `Virtual Assistant.lnk` on your Desktop (one is already created on this machine)
  - **Tray icon** — right-click to show the assistant, open ChatRP, or quit
  - **Global hotkey** — `Ctrl+Alt+Shift+V` focuses the assistant window
  - **Theme** — switch between dark and light surfaces
  - **Backup** — export conversations, personas, characters, notes, tasks, reminders, calendar events, audit, knowledge sources, and settings to one local JSON file
  - **Restore** — replace local data from a previously exported JSON snapshot in one transaction
  - **Export for Android…** — writes the versioned JSON snapshot plus a copy of every referenced `.vrm` avatar into a folder you choose. Copy that folder to the phone for the Android importer; avatar files are never bundled inside the app itself
  - **Android bridge** — opt-in local WebSocket on port `8787`, loopback by default with an optional LAN bind. A pairing token is required; there is no cloud relay
  - **GitHub update check** — a manual button contacts GitHub only when clicked and can open the matching release page. Release tags use `000.015.002.2026` (Major.Minor.Sub.Year)
  - Reminders fire as local OS notifications within 5 minutes of their time
- **Local voice:** click **Voice** in the toolbar (or type `/voice`)
  - **Text-to-speech:** Windows SAPI (built in, no download) or an optional local Piper executable/model you provide; audio is generated on this PC and played in the app
  - **Speech-to-text:** click **Listen** in the composer, speak, then click **Stop mic**; Whisper `ggml-tiny.en` runs entirely in-process via `whisper.cpp` WASM with the seeded `assets/voice/ggml-tiny.en.bin`
  - Microphone permission is allowed only for the app's own local page; captured PCM is never uploaded and is limited to 30 seconds
  - **Lip-sync:** played audio is analysed with Web Audio; the live amplitude drives VRM `aa`/`oh` shape keys or the 2D fallback mouth
  - Stop buttons cancel both speech generation and playback
- **Local calendar:** click **Calendar** in the toolbar (or type `/calendar`)
  - Import `.ics` files with a native dialog; `VEVENT` summary, description, start/end, all-day, UID, and TZID are parsed locally
  - Dedupe by UID (re-importing is safe); future events also create local reminders that fire as OS notifications
  - Imported events are stored in SQLite and included in JSON backups; recurring rules are not expanded
- Slash commands: `/new`, `/export`, `/tasks`, `/notes`, `/knowledge`, `/dev`, `/connections`, `/avatar`, `/system`, `/calendar`, `/voice`

## Android companion

A local-first WebView app under `android/` reuses the same React UI through a Kotlin `window.api` adapter.

- **Phone mode** runs on the phone hardware with no PC present. Import a GGUF model with **Mode & sync → Local model → Import GGUF**; inference uses the bundled `llama-android` runtime entirely on-device. Chats, personas, characters, settings, and imported VRM avatars stay in app-private storage.
- **Port:** open **Port** on the PC and click **Pair New** for a fresh QR, then open **Portable Sync → Scan PC QR** in the APK. The QR carries only your LAN address and a newly rotated local pairing token; older QR codes stop working for new connections. No cloud relay or account is involved. The panel also has **Sync** to send the current PC snapshot to the connected phone, plus a **Trusted Devices** list to revoke or re-allow a phone. Manual address/token entry is still available in the APK's Portable Sync tab.
- **Desktop link mode** connects to the desktop bridge over your LAN, mDNS, or Tailscale only. The APK stores a stable device ID so the paired phone appears in the PC's Trusted Devices list. No cloud relay or account is involved.
- **Copy from desktop:** use **Export for Android…**, copy the resulting folder to the phone, then use **Import bundle** in the phone app. Referenced `.vrm` files are remapped to the phone copies. No VRM is bundled in the APK.
- **Sync later:** with the bridge connected, **Pull from PC** pulls a versioned snapshot from the desktop; **Push to PC** replaces desktop data with the phone snapshot using the desktop app's transactional restore path.
- Build web assets with `npm run build:android:assets`, then build the APK from `android/` with Gradle (`assembleDebug`). Android SDK, Java, and Gradle wrapper are used locally; no remote build service.

## Downloads

The [latest release `000.015.002.2026`](https://github.com/Gyakudos/Virtua/releases/tag/000.015.002.2026) contains smoke-test builds:

- `Virtua-Setup-0.10.0-x64.exe` — Windows x64 setup. It is unsigned, so Windows SmartScreen may require **More info → Run anyway**.
- `app-debug.apk` — Android arm64-v8a companion APK with a local QR scanner. No VRM or GGUF model is included; import your own files on the phone.

The desktop manual update check uses GitHub's latest release and still falls back to the version tag if needed.

## Setup

1. Install Node.js 20.19+ (Node 26 works) and Ollama.
2. Seed models locally (no download at runtime):
   - Already seeded on this machine: `qwen2.5:3b-instruct` (Q4_K_M, ~1.9 GB) and `nomic-embed-text` (~274 MB) for RAG.
   - For stronger hardware: `ollama pull qwen2.5:7b-instruct`.
   - To go fully offline on another machine, copy Ollama's `models` directory or pre-seed during install.
   - Speech-to-text uses the pre-seeded `assets/voice/ggml-tiny.en.bin` (~74 MB); no model is downloaded at runtime.
3. Install dependencies: `npm install`
4. Run in dev mode: `npm run dev`
5. Production build: `npm run build` then `npm start`
6. Windows setup build: `npm run dist:win` (output goes to `dist-setup/`)

`package.json` uses a semver-compatible `0.10.0` because npm requires MAJOR.MINOR.PATCH; the full custom build version is shown in the app and defined in `src/shared/version.ts`.

## Optional environment

- `OLLAMA_HOST` — override the Ollama endpoint (default `http://127.0.0.1:11434`).
- `VA_OCR_PATH` — override the folder containing `eng.traineddata.gz` (defaults to `resources/assets/ocr` in the setup build, or `assets/ocr` in source mode). No network fallback.
- `VA_VOICE_MODEL` — override the path to the local Whisper `ggml` model (defaults to `resources/assets/voice/ggml-tiny.en.bin` in the setup build, or `assets/voice/ggml-tiny.en.bin` in source mode). No network fallback.

## Next phases

1. Optional Android voice/OCR parity (SAPI/Piper and Whisper features remain desktop-only for now)
2. Code signing for the Windows setup so SmartScreen does not warn

See `PLAN.md` for the full blueprint.
