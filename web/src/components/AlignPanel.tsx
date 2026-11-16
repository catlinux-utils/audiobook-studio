import { useEffect, useRef, useState } from 'react';
import { api, type Alignment } from '../lib/api';
import { Button, SectionTitle, Textarea } from './bits';

/**
 * Transcript ↔ audio verification: forced-align every transcript word to the
 * reference audio (Meta MMS), click a word to hear it in isolation, fix words
 * that don't sound like they look. Wrong transcript words are what make clones
 * garble — this panel is the fix loop, shared by Voices lab and VoiceExpert.
 */
export default function AlignPanel({
  voiceId,
  transcript,
  onTranscriptChange,
  onSaved,
  onError,
}: {
  voiceId: string;
  transcript: string;
  onTranscriptChange: (t: string) => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [align, setAlign] = useState<Alignment | null>(null);
  const [busy, setBusy] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setAlign(null); // old alignment no longer matches a different voice
  }, [voiceId]);

  const ensureAudio = (): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio(api.audioUrl.voice(voiceId));
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  };

  const playSlice = (start: number, end: number) => {
    const a = ensureAudio();
    a.currentTime = Math.max(0, start);
    void a.play().catch(() => onError('click the page once to allow audio playback'));
    const stop = () => {
      if (a.currentTime >= end - 0.02 || a.ended) {
        a.pause();
        a.removeEventListener('timeupdate', stop);
      }
    };
    a.addEventListener('timeupdate', stop);
  };

  const runAlign = async () => {
    setBusy('align');
    onError('');
    try {
      setAlign(await api.alignVoice(voiceId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const saveTranscript = async () => {
    setBusy('save');
    try {
      await api.updateVoice(voiceId, { referenceText: transcript });
      setAlign(null); // old alignment no longer matches the new text
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const suspects = align?.words.filter((w) => w.suspect) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <SectionTitle>Transcript ↔ audio</SectionTitle>
        <Button variant="ghost" onClick={runAlign} disabled={busy !== ''}>
          {busy === 'align' ? 'aligning…' : align ? '↺ re-align' : '🔍 verify transcript'}
        </Button>
        <Button variant="ghost" onClick={saveTranscript} disabled={busy !== '' || transcript.trim() === ''}>
          {busy === 'save' ? 'saving…' : '💾 save transcript'}
        </Button>
        {align && (
          <span className="text-xs text-zinc-500">
            {align.durationSec.toFixed(1)}s audio · {Math.round(align.coverage * 100)}% covered
            {suspects.length > 0 && <span className="text-red-400"> · {suspects.length} suspect</span>}
          </span>
        )}
      </div>
      <Textarea
        className="w-full min-h-[56px]"
        value={transcript}
        onChange={(e) => onTranscriptChange(e.target.value)}
        placeholder="transcript of the reference clip — fix words here after listening"
      />
      {align && (
        <div className="mt-2 text-sm leading-7">
          {align.words.map((w, i) => (
            <span key={i}>
              {w.gapBefore > 0.7 && <span className="text-amber-500 text-xs mr-1">⟨{w.gapBefore.toFixed(1)}s gap⟩</span>}
              <button
                className={`inline rounded px-1 mr-0.5 ${
                  w.suspect
                    ? 'bg-red-950 border border-red-800 text-red-300 hover:bg-red-900'
                    : 'text-zinc-300 hover:bg-zinc-800 border border-transparent'
                }`}
                title={w.why || `${w.start.toFixed(2)}–${w.end.toFixed(2)}s — click to listen`}
                onClick={() => w.start >= 0 && playSlice(w.start, Math.max(w.end, w.start + 0.15))}
              >
                {w.text}
              </button>
            </span>
          ))}
          <div className="text-xs text-zinc-500 mt-1">
            red = alignment looks wrong (click to hear why) · click any word to hear it in isolation · amber ⟨gap⟩ = audio the transcript doesn't cover
          </div>
        </div>
      )}
    </div>
  );
}
