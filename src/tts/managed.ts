import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, loadSettings } from '../config.js';

/**
 * Managed TTS server: standalone mode spawns the bundled audio.cpp runtime
 * (runtime/bin, installed by setup.ps1 / setup.sh) as a child process with a
 * generated config, so the studio has zero external dependencies. External
 * mode skips the spawn and points the client at a user-provided URL.
 */
class ManagedServer {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;
  private configPath = path.join(paths.runtime, 'server.json');
  private lastExit: { code: number | null; at: string } | null = null;

  runtimeInstalled(): boolean {
    const exe = this.serverBinary();
    return exe !== null;
  }

  private serverBinary(): string | null {
    const candidates =
      process.platform === 'win32'
        ? ['audiocpp_server.exe']
        : ['audiocpp_server'];
    for (const name of candidates) {
      const p = path.join(paths.runtime, 'bin', name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private modelPath(): string | null {
    const dir = path.join(paths.runtime, 'models', 'OmniVoice-GGUF');
    if (!fs.existsSync(dir)) return null;
    const gguf = fs.readdirSync(dir).find((f) => f.endsWith('.gguf'));
    return gguf ? path.join(dir, gguf) : null;
  }

  /** ASR model (CrisperWhisper) — optional; enables voice-prep auto-transcript. */
  private asrModelDir(): string | null {
    const dir = path.join(paths.runtime, 'models', 'CrisperWhisper2.0-GGUF');
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.gguf'))) return null;
    return dir;
  }

  /** Generate runtime/server.json from current settings. */
  writeConfig(port: number): void {
    const model = this.modelPath();
    if (!model) throw new Error('OmniVoice model not installed — run setup.ps1 / setup.sh first');
    const models: Array<Record<string, unknown>> = [
      {
        id: 'omnivoice',
        family: 'omnivoice',
        path: path.dirname(model),
        task: 'tts',
        mode: 'offline',
        default_request_options: {
          num_inference_steps: 32,
          guidance_scale: 2.0,
        },
      },
    ];
    const asrDir = this.asrModelDir();
    if (asrDir) {
      const versions = JSON.parse(fs.readFileSync(path.join(paths.root, 'versions.json'), 'utf8')) as {
        asr_gguf?: { model_id?: string; family?: string };
      };
      models.push({
        id: versions.asr_gguf?.model_id ?? 'asr',
        family: versions.asr_gguf?.family ?? 'crisperwhisper',
        path: asrDir,
        task: 'asr',
        mode: 'offline',
      });
    }
    const config = {
      host: '127.0.0.1',
      port,
      backend: 'vulkan',
      device: 0,
      threads: 4,
      lazy_load: true,
      max_loaded_models: 1,
      ui: false,
      ui_management: false,
      voice_dir: paths.voices,
      models,
    };
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Ensure the managed server is running; resolves once /health answers.
   * No-op in external mode.
   */
  async ensureRunning(): Promise<{ started: boolean; url: string }> {
    const settings = loadSettings();
    if (settings.ttsMode === 'external') return { started: false, url: settings.audiocppUrl };
    if (!this.runtimeInstalled()) {
      throw new Error('TTS runtime not installed — run setup.ps1 (Windows) or setup.sh (Linux)');
    }

    const port = settings.managedPort;
    const url = `http://127.0.0.1:${port}`;
    // already healthy (e.g. previous app run left it alive, or another tool uses the port)
    if (await this.healthy(url)) return { started: false, url };

    this.writeConfig(port);
    const exe = this.serverBinary()!;
    this.stopping = false;
    this.child = spawn(exe, ['--config', this.configPath], {
      cwd: paths.runtime,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', () => undefined); // keep pipes drained
    this.child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[audiocpp] ${line.slice(0, 200)}`);
    });
    this.child.on('exit', (code) => {
      this.lastExit = { code, at: new Date().toISOString() };
      this.child = null;
      if (!this.stopping) {
        console.error(`[audiocpp] managed server exited unexpectedly (code ${code})`);
        if (this.restarts < 3) {
          this.restarts++;
          console.log(`[audiocpp] restarting (attempt ${this.restarts}/3)…`);
          setTimeout(() => this.ensureRunning().catch((e) => console.error('[audiocpp] restart failed:', e.message)), 2000);
        }
      }
    });

    // wait for /health (model load is lazy, so this is fast)
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.healthy(url)) {
        console.log(`[audiocpp] managed TTS server ready at ${url}`);
        return { started: true, url };
      }
      if (!this.child) break; // died during startup
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`managed TTS server did not become healthy${this.lastExit ? ` (last exit code ${this.lastExit.code})` : ''}`);
  }

  private async healthy(url: string, timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

export const managedServer = new ManagedServer();

/** Base URL of the TTS server per current settings (managed or external). */
export function ttsBaseUrl(): string {
  const s = loadSettings();
  return s.ttsMode === 'external' ? s.audiocppUrl : `http://127.0.0.1:${s.managedPort}`;
}
