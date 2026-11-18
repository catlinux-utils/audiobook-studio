# Troubleshooting, scope and limitations

## Troubleshooting

| Symptom | What to check |
|---|---|
| Studio starts but generation never does | Is the runtime installed (`runtime/bin`)? Tail `data/server.log` (also in Settings). Re-run setup. |
| `Vulkan device not found` / init failure | Update GPU drivers; verify Vulkan with `vulkaninfo` if available. Software Vulkan (lavapipe) is not a practical fallback for generation. |
| `503` / `ServerBusyError` | The TTS server is busy with another request; the queue backs off and retries. Keep `concurrency` at 1. |
| First generation hangs ~30 s | Normal model load after a cold start. |
| ASR transcription fails | The model expects 16 kHz mono; the studio converts before sending. Check that the ASR GGUF is installed (run setup again without the skip-model flag). |
| Polish alignment looks empty/garbled | Alignment runs through an ASCII romanization workaround in the studio; make sure the transcript is accurate before aligning. |
| Export takes very long | The word check transcribes every part once. Cached verdicts make repeat exports much faster. |
| Disk growing | Chunk WAVs and `.prep*` caches are the usual suspects. Clear assembly caches in Settings; delete unused books/exports. |
| Port already in use | Change `port` (studio) or `managedPort` (TTS) in Settings and restart. |
| UI shows stale behavior | Rebuild the web bundle (`npm run build`) — the API serves `dist/web`. |

## Scope and limitations

- **Single user, single machine.** No accounts, no multi-tenant storage, no remote rendering. The
  server binds to loopback only.
- **Vulkan only.** There is no CUDA/ROCm/Metal backend; the bundled audio.cpp build is Windows/Linux
  x64.
- **Chunked synthesis has seams.** Continuity assembly hides most of the abrupt prosody resets at
  part boundaries, but each take is generated without knowledge of its neighbours. Very long parts
  can also drift in pacing.
- **QA is a word check, not a quality judge.** It catches missing, extra and variant words via ASR;
  it cannot tell you whether the acting is good.
- **M4B audio is AAC 96 kbps.** Keep the assembled chapter WAVs if you need a lossless master.
- **The HTTP API is unversioned.** It is usable for scripting, but routes and payloads may change
  between 0.x releases.
