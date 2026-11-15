import { unzipSync, strFromU8 } from 'fflate';
import * as cheerio from 'cheerio';

export interface EpubChapter {
  title: string;
  /** Normalized plain text of the chapter (paragraph breaks preserved). */
  text: string;
}

export interface EpubBook {
  title: string;
  author: string;
  language: string;
  chapters: EpubChapter[];
  /** Cover image bytes + mime type, if present. */
  cover: { data: Uint8Array; mime: string } | null;
}

interface SpineItem {
  href: string;
  /** OPF manifest media-type, e.g. application/xhtml+xml */
  mediaType: string;
  title: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function attr(xml: string, tag: string, attrName: string): string | null {
  // minimal attribute extractor for container.xml / OPF (namespace-agnostic)
  const re = new RegExp(`<${tag}[^>]*\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i');
  const alt = new RegExp(`<${tag}[^>]*\\b${attrName}\\s*=\\s*'([^']*)'`, 'i');
  const m = xml.match(re) ?? xml.match(alt);
  return m ? decodeXmlEntities(m[1]!) : null;
}

function resolvePath(base: string, href: string): string {
  // OPF hrefs are relative to the OPF file location
  const clean = href.split('#')[0]!;
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const parts = (baseDir + clean).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.map(encodeURIComponentSafe).join('/');
}

/** EPUB zips often store paths percent-encoded; normalize both ways. */
function encodeURIComponentSafe(s: string): string {
  return s;
}

function findFile(files: Record<string, Uint8Array>, target: string): string | null {
  if (files[target]) return target;
  const lower = target.toLowerCase();
  for (const name of Object.keys(files)) {
    if (name.toLowerCase() === lower) return name;
    // some epubs double-encode; try decoded match
    try {
      if (decodeURIComponent(name.toLowerCase()) === lower) return name;
    } catch {
      // malformed percent-encoding in zip entry names — ignore
    }
  }
  return null;
}

function readText(files: Record<string, Uint8Array>, name: string): string {
  return strFromU8(files[name]!);
}

/** Extract readable chapters + metadata from an EPUB buffer. */
export function parseEpub(buf: Uint8Array): EpubBook {
  const files = unzipSync(buf);

  const containerKey = findFile(files, 'META-INF/container.xml');
  if (!containerKey) throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  const container = readText(files, containerKey);
  const opfPathRaw = attr(container, 'rootfile', 'full-path');
  if (!opfPathRaw) throw new Error('Not a valid EPUB: no rootfile in container.xml');

  const opfKey = findFile(files, opfPathRaw);
  if (!opfKey) throw new Error(`EPUB OPF not found: ${opfPathRaw}`);
  const opf = readText(files, opfKey);

  const title = decodeXmlEntities(opf.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/i)?.[1] ?? 'Unknown title').trim();
  const author = decodeXmlEntities(opf.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/i)?.[1] ?? 'Unknown author').trim();
  const language = decodeXmlEntities(opf.match(/<dc:language[^>]*>([^<]*)<\/dc:language>/i)?.[1] ?? '').trim();

  // manifest: id -> (href, mediaType)
  const manifest = new Map<string, { href: string; mediaType: string }>();
  const itemRe = /<item\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = attr(tag, 'item', 'id');
    const href = attr(tag, 'item', 'href');
    const mediaType = attr(tag, 'item', 'media-type');
    if (id && href && mediaType) manifest.set(id, { href, mediaType });
  }

  // spine order
  const spineItems: SpineItem[] = [];
  const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  const itemrefRe = /<itemref\b[^>]*\bidref\s*=\s*"([^"]*)"[^>]*>/gi;
  if (spineMatch) {
    let r: RegExpExecArray | null;
    while ((r = itemrefRe.exec(spineMatch[1]!))) {
      const item = manifest.get(r[1]!);
      if (item) {
        spineItems.push({
          href: resolvePath(opfKey, item.href),
          mediaType: item.mediaType,
          title: '',
        });
      }
    }
  }
  if (spineItems.length === 0) {
    // fallback: every xhtml document in the manifest, sorted by href
    for (const { href, mediaType } of manifest.values()) {
      if (/xhtml|html/i.test(mediaType)) {
        spineItems.push({ href: resolvePath(opfKey, href), mediaType, title: '' });
      }
    }
    spineItems.sort((a, b) => a.href.localeCompare(b.href));
  }

  // cover: manifest item with properties="cover-image", or meta[name=cover]
  let cover: EpubBook['cover'] = null;
  const coverId =
    opf.match(/<item\b[^>]*properties=["'][^"']*cover-image[^"']*["'][^>]*>/i)?.[0] ??
    (() => {
      const metaId = opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!metaId) return null;
      return manifest.has(metaId) ? `<item id="${metaId}">` : null;
    })();
  if (coverId) {
    const cid = attr(coverId, 'item', 'id');
    const item = cid ? manifest.get(cid) : undefined;
    if (item) {
      const key = findFile(files, resolvePath(opfKey, item.href));
      if (key) cover = { data: files[key]!, mime: item.mediaType };
    }
  }

  // chapters
  const chapters: EpubChapter[] = [];
  for (const item of spineItems) {
    if (!/xhtml|html/i.test(item.mediaType)) continue;
    const key = findFile(files, item.href);
    if (!key) continue;
    const $ = cheerio.load(readText(files, key));
    $('script, style, nav, header, footer').remove();
    const heading = $('h1, h2, h3').first().text().trim();
    // .text() alone loses block boundaries (cheerio only emits the whitespace
    // present in the source, and many epubs are minified) — mark them explicitly.
    // Real headings get a '# ' marker so the chunker can isolate them exactly
    // instead of guessing (the marker is stripped again before synthesis).
    $('h1, h2, h3, h4, h5, h6').before('# ');
    $('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article, tr, dd, dt, figcaption').after('\n\n');
    $('br').after('\n');
    const text = $('body').text();
    const clean = text
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.split(/\s+/).join(' ').trim())
      .filter(Boolean)
      .join('\n\n');
    if (clean.length < 40) continue; // cover pages, toc fragments, blank pages
    chapters.push({
      title: heading || fileNameToTitle(item.href),
      text: clean,
    });
  }
  if (chapters.length === 0) throw new Error('EPUB contains no readable text chapters');

  return { title, author, language, chapters, cover };
}

function fileNameToTitle(href: string): string {
  const base = href.split('/').pop() ?? href;
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
}
