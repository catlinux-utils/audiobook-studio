/**
 * Ingest sample-books/*.epub into the studio database without the HTTP API.
 * Run: npm run seed   (safe to re-run; existing books with the same title are skipped)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/db.js';
import { paths, loadSettings } from '../src/config.js';
import { parseEpub } from '../src/ingest/epub.js';
import { splitTxtChapters } from '../src/ingest/txt.js';
import { chunkText } from '../src/ingest/chunker.js';

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sample-books');

function insertBook(file: string): void {
  const db = getDb();
  const buf = fs.readFileSync(file);
  let parsed;
  if (file.endsWith('.epub')) {
    parsed = parseEpub(new Uint8Array(buf));
  } else {
    const chapters = splitTxtChapters(buf.toString('utf8'));
    parsed = { title: path.basename(file, '.txt'), author: '', language: '', chapters, cover: null };
  }
  const existing = db.prepare('SELECT id FROM books WHERE title=?').get(parsed.title) as unknown as { id: string } | undefined;
  if (existing) {
    console.log(`skip (exists): ${parsed.title}`);
    return;
  }
  const maxChunkChars = loadSettings().defaultMaxChunkChars;
  const bookId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO books (id, title, author, language, cover_path, source_file, status, max_chunk_chars, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(bookId, parsed.title, parsed.author, parsed.language, null, path.basename(file), 'draft', maxChunkChars, now, now);

  parsed.chapters.forEach((chapter, ci) => {
    const chapterId = randomUUID();
    db.prepare('INSERT INTO chapters (id, book_id, idx, title, char_count) VALUES (?,?,?,?,?)').run(
      chapterId, bookId, ci, chapter.title, chapter.text.length,
    );
    const chunks = chunkText(chapter.text, maxChunkChars);
    chunks.forEach((chunk, ki) => {
      db.prepare(
        'INSERT INTO chunks (id, book_id, chapter_id, idx, text, char_start, char_end, status) VALUES (?,?,?,?,?,?,?,?)',
      ).run(randomUUID(), bookId, chapterId, ki, chunk.text, chunk.charStart, chunk.charEnd, 'pending');
    });
    console.log(`  chapter ${ci + 1}: ${chapter.title} — ${chunks.length} chunks`);
  });
  console.log(`added: ${parsed.title} (${parsed.chapters.length} chapters)`);
}

fs.mkdirSync(paths.data, { recursive: true });
for (const file of fs.readdirSync(samplesDir).sort()) {
  if (file.endsWith('.epub') || file.endsWith('.txt')) {
    insertBook(path.join(samplesDir, file));
  }
}
console.log('seed complete');
