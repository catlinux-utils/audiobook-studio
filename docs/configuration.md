# Configuration, data and backups

Settings live in `data/settings.json` and are editable from the UI (or by hand; the file is
re-serialized on every write).

| Key | Default | Meaning |
|---|---|---|
| `ttsMode` | `managed` | `managed` spawns the bundled audio.cpp child; `external` uses `audiocppUrl` |
| `managedPort` | `8081` | port for the managed TTS server |
| `audiocppUrl` | `http://127.0.0.1:8080` | external audio.cpp base URL (no `/v1`) |
| `model` | `omnivoice` | model id; fixed by the managed config |
| `concurrency` | `1` | parallel requests to audio.cpp (the server queues beyond that) |
| `ffmpegPath` | `ffmpeg` | binary name or absolute path |
| `defaultMaxChunkChars` | `280` | default part size for new books |
| `port` | `8090` | studio port (restart required) |
| `assemblySmooth` | `true` | continuity prep + pause insertion; `false` = raw concat |
| `assemblyGapMs` | `400` | fallback sentence pause when auto-detection has no data |
| `assemblyParagraphGapMs` | `700` | paragraph pause budget; the surplus over `assemblyGapMs` is added at paragraph joins (+300 ms with the defaults) |
| `assemblySoftCutGapMs` | `120` | legacy knob for mid-sentence joins; soft cuts are crossfaded with no inserted pause regardless of this value |

The studio binds to `127.0.0.1` only. There is no authentication; do not expose it directly to a
network. To use it remotely, put it behind an authenticated reverse proxy or tunnel.

## Data and backups

All mutable state is under `data/` (gitignored):

```
data/
  studio.db              SQLite (node:sqlite): books, chapters, chunks, jobs, voices, takes, exports
  settings.json          configuration (created on first run)
  server.log             server output when started with redirection (tail it from Settings)
  books/<bookId>/
    source.epub|txt      original ingest input (kept for re-chunking)
    cover.jpg|png        extracted cover
    chunks/*.wav         generated audio, one file per part
    audio/               assembled chapter WAVs
    audio/.prep-v8/      continuity prep cache (safe to delete)
  voices/<voiceId>.wav   voice reference clips
  voices-takes/          expert/sweep takes
  exports/               final .m4b / MP3 + .qa.txt reports
```

Back up by stopping the studio and copying `data/`. Restoring the folder is enough: the schema is
created/migrated on startup. Generated audio is reproducible (seeds live in the DB), but the model
and voice references must be present to regenerate.

`AUDIOBOOK_STUDIO_HOME` overrides the project root, which is how the Nix wrapper keeps mutable state
outside the read-only store. See [install](install.md#nix-flake-linux-x64).
