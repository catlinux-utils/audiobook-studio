# Install and run

## Requirements

| Component | Requirement |
|---|---|
| **Node.js** | 22.13 or newer (built-in `node:sqlite`; tested on Node 26) |
| **ffmpeg** | recent build (6.x+) on `PATH`, with `libmp3lame`, `aac` and the MP4 muxer — or set the binary path in Settings |
| **GPU** | Vulkan-capable (AMD / Intel / NVIDIA) with current drivers; Vulkan ships with the driver |
| **Disk** | ~4 GB for the runtime + models, plus working space for chunk WAVs and exports |
| **OS** | Windows 10/11 x64 or Linux x64 (setup scripts for both) |
| **Browser** | any current browser (the UI is a React SPA) |

A GPU is required for generation, voice tests, and all ASR/alignment work. On this project's
reference machine a short take takes roughly 20–40 s including model work; a full novel is an
overnight job, not a coffee break.

## Setup

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File setup.ps1
npm install
npm run seed            # optional: public-domain sample books
npm run build
npm start
```

```bash
# Linux
chmod +x setup.sh && ./setup.sh
npm install
npm run seed            # optional
npm run build
npm start
```

Then open **http://127.0.0.1:8090**. The TTS child server comes up on `:8081` automatically; the
first request after a cold start waits for the model to load.

`setup.ps1` / `setup.sh` install audio.cpp 0.9.5 (Windows/Linux x64), the OmniVoice q8_0 weights,
and the ASR and forced-aligner models used by the voice tooling. They accept
`-SkipModel` / `--skip-model` (runtime only) and `-Force` / `--force` (re-download). Artifacts are
cached in `runtime/downloads/` and verified against the SHA-256 values in `versions.json`;
`runtime/` is gitignored and safe to re-install.

Do not run the studio as a network service: it binds to `127.0.0.1` only and has no
authentication. See [configuration](configuration.md) for ports and settings.

## Logs

To use the in-app log viewer, start the studio with its output redirected to `data/server.log`:

```text
# POSIX shell
npm start > data/server.log 2>&1
# Windows
cmd /c npm start > data\server.log 2>&1
```

## Development mode

Development mode runs the API and a Vite dev server with hot reload:

```bash
npm run dev             # API on :8090, UI on :5173 (proxies /api)
```

A full command reference lives in [architecture](architecture.md#commands).

## Nix flake (Linux x64)

The flake builds the studio, the audio.cpp Vulkan runtime and the GGUF weights pinned in
`versions.json`, so nothing is downloaded at first run:

```bash
nix run .                       # or: nix run github:<you>/audiobook-studio
nix build .#models              # ~3.7 GB of weights only
nix develop                     # Node 22 + ffmpeg for npm run dev
```

Mutable state lives in `${XDG_DATA_HOME:-~/.local/share}/audiobook-studio` (`data/`, `runtime/`);
set `AUDIOBOOK_STUDIO_HOME` to move it. The launcher links the read-only store assets into that
directory and leaves any real `runtime/bin` or `runtime/models` you already have untouched.

| Output | Contents |
|---|---|
| `packages.default` | studio + audio.cpp runtime + OmniVoice, CrisperWhisper and MMS aligner (~4 GB) |
| `packages.audiobook-studio-lite` | studio + runtime only; supply `runtime/models` yourself |
| `packages.models` | the three GGUF model files |
| `packages.audio-cpp` | audio.cpp 0.9.5 Ubuntu x64 Vulkan build |

The TTS child needs a working Vulkan 1.3 driver (`libvulkan.so.1`); on NixOS enable
`hardware.graphics.enable` and keep the user in the `video`/`render` groups. If the loader still finds
no device, point `VK_DRIVER_FILES` at your driver's ICD json (NixOS:
`/run/opengl-driver/share/vulkan/icd.d/*.json`). The flake only targets `x86_64-linux` — use
`setup.ps1` on Windows.
