import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Voice } from '../lib/api';
import { Banner, Button, Card, Checkbox, Input, ProgressBar, Select, StatusBadge, Textarea, formatDuration } from '../components/bits';

export default function Library() {
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  // paste-text form state
  const [pasteOpen, setPasteOpen] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [pTitle, setPTitle] = useState('');
  const [pAuthor, setPAuthor] = useState('');
  const [pLanguage, setPLanguage] = useState('pl');
  const [pVoice, setPVoice] = useState('');
  const [pText, setPText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listBooks().then(setBooks).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'job.update' || ev.type === 'book.update' || ev.type === 'chunk.update') refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (pasteOpen) api.listVoices().then(setVoices).catch(() => setVoices([]));
  }, [pasteOpen]);

  const upload = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const { id } = await api.uploadBook(file);
      navigate(`/books/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const resetPasteForm = () => {
    setPTitle('');
    setPAuthor('');
    setPLanguage('pl');
    setPVoice('');
    setPText('');
  };

  const createPasted = async (generate: boolean) => {
    const text = pText.trim();
    if (!text) {
      setError('paste some text first');
      return;
    }
    const title = pTitle.trim() || (text.split('\n').find((l) => l.trim()) ?? 'Pasted story').slice(0, 80);
    setPasteBusy(true);
    setError('');
    try {
      const { id, chapterId } = await api.pasteBook({
        title,
        author: pAuthor.trim() || undefined,
        language: pLanguage.trim() || undefined,
        text,
        voiceId: pVoice || undefined,
      });
      setPasteOpen(false);
      resetPasteForm();
      if (generate) await api.generateChapter(id, chapterId);
      navigate(`/books/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPasteBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".epub,.txt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button onClick={() => setPasteOpen((o) => !o)} title="paste a short story or article instead of uploading a file">
            📝 Paste text
          </Button>
          <Button variant="primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? 'Ingesting…' : '+ Add book (EPUB / TXT)'}
          </Button>
        </div>
      </div>

      {error && <Banner kind="error" className="mb-4">{error}</Banner>}

      {pasteOpen && (
        <Card title="Paste a story or article" className="mb-6">
          <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_100px_1fr] gap-3 mb-3">
            <Input
              value={pTitle}
              onChange={(e) => setPTitle(e.target.value)}
              placeholder="Title (empty = first line of the text)"
            />
            <Input
              value={pAuthor}
              onChange={(e) => setPAuthor(e.target.value)}
              placeholder="Author (optional)"
            />
            <Input
              value={pLanguage}
              onChange={(e) => setPLanguage(e.target.value)}
              placeholder="lang"
              title="synthesis language hint, e.g. pl"
            />
            <Select
              value={pVoice}
              onChange={(e) => setPVoice(e.target.value)}
              title="voice for generation"
            >
              <option value="">— voice (pick later) —</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </Select>
          </div>
          <Textarea
            className="w-full min-h-[220px]"
            value={pText}
            onChange={(e) => setPText(e.target.value)}
            placeholder="Paste the story or article here… paragraphs are kept, it gets chunked like a book."
          />
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button onClick={() => createPasted(false)} disabled={pasteBusy} title="create as a draft — generate later from the book page">
              {pasteBusy ? 'Creating…' : '💾 Create draft'}
            </Button>
            <Button variant="primary" onClick={() => createPasted(true)} disabled={pasteBusy || !pVoice} title={pVoice ? 'create and queue generation of the whole text' : 'pick a voice first'}>
              {pasteBusy ? 'Working…' : '▶ Create & generate'}
            </Button>
            <Button variant="ghost" onClick={() => { setPasteOpen(false); setError(''); }}>
              cancel
            </Button>
            <span className="text-xs text-zinc-500">up to ~200k characters · same pipeline as books: chunks, queue, QA, exports</span>
          </div>
        </Card>
      )}

      {books.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
          No books yet. Add an EPUB or TXT, or paste a short story above.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {books.map((b) => (
            <div
              key={b.id}
              className="rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-colors cursor-pointer overflow-hidden flex"
              onClick={() => navigate(`/books/${b.id}`)}
            >
              <div className="w-20 shrink-0 bg-zinc-800 relative">
                {b.cover_path ? (
                  <img
                    src={`/api/books/${b.id}/cover`}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      // broken cover file on disk — hide it, the 📖 fallback shows through the parent
                      (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-3xl">📖</div>
                )}
              </div>
              <div className="p-3 flex-1 min-w-0">
                <div className="font-medium truncate">{b.title}</div>
                <div className="text-sm text-zinc-400 truncate mb-2">{b.author || '—'}</div>
                <div className="flex items-center gap-2 mb-2">
                  <StatusBadge status={b.status} />
                  <span className="text-xs text-zinc-500">{b.voice_name ?? 'no voice'}</span>
                </div>
                <ProgressBar done={b.chunks_done ?? 0} total={b.chunk_count ?? 0} failed={b.chunks_failed ?? 0} />
                <div className="flex justify-between text-xs text-zinc-500 mt-1">
                  <span>
                    {b.chunks_done ?? 0}/{b.chunk_count ?? 0} chunks
                    {(b.chunks_failed ?? 0) > 0 && <span className="text-red-400"> · {b.chunks_failed} failed</span>}
                  </span>
                  <span>{formatDuration(b.duration_ms)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
