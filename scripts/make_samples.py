"""Build minimal sample EPUBs from public-domain texts for testing the studio.

Run from the repo root:  python scripts/make_samples.py
Expects source texts in the system temp dir (see paths below) — the script is
a one-time generator; the resulting EPUBs are committed to sample-books/.
"""
import os
import tempfile
import zipfile

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'sample-books')


def xhtml(title: str, body: str) -> str:
    paragraphs = '\n'.join(f'<p>{p.strip()}</p>' for p in body.split('\n\n') if p.strip())
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="pl">
<head><title>{title}</title></head>
<body><h2>{title}</h2>
{paragraphs}
</body></html>'''


def build_epub(path: str, title: str, author: str, language: str, chapters: list[tuple[str, str]]):
    if os.path.exists(path):
        os.remove(path)
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''')
        items = ''
        spine = ''
        for i, (ch_title, ch_text) in enumerate(chapters):
            name = f'chapter{i:02d}.xhtml'
            z.writestr(f'OEBPS/{name}', xhtml(ch_title, ch_text))
            items += f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>\n'
            spine += f'<itemref idref="c{i}"/>\n'
        z.writestr('OEBPS/content.opf', f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:{title.replace(' ', '-').lower()}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>{language}</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    {items}
  </manifest>
  <spine>{spine}</spine>
</package>''')
        nav_lis = '\n'.join(f'<li><a href="chapter{i:02d}.xhtml">{t}</a></li>' for i, (t, _) in enumerate(chapters))
        z.writestr('OEBPS/nav.xhtml', f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><h1>Contents</h1><ol>{nav_lis}</ol></nav></body></html>''')
    print(f'wrote {path} ({os.path.getsize(path)} bytes, {len(chapters)} chapters)')


def read_lines(name: str) -> list[str]:
    with open(os.path.join(tempfile.gettempdir(), name), encoding='utf-8') as f:
        return f.read().split('\n')


def section(lines: list[str], start: int, end: int) -> str:
    return '\n\n'.join(p.strip() for p in '\n'.join(lines[start:end]).split('\n\n') if p.strip())


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    # --- Pan Tadeusz, Ksiega pierwsza (Adam Mickiewicz, 1834, public domain) ---
    pt = read_lines('pan-tadeusz.txt')
    ksiega1 = section(pt, 11, 1057)
    build_epub(
        os.path.join(OUT, 'pan-tadeusz-ksiega-1.epub'),
        'Pan Tadeusz — Księga pierwsza', 'Adam Mickiewicz', 'pl',
        [('Księga pierwsza: Gospodarstwo', ksiega1)],
    )

    # --- W pustyni i w puszczy, rozdzialy I-III (Henryk Sienkiewicz, 1911, PD) ---
    wp = read_lines('pustyni.txt')
    ch1 = section(wp, 11, 87)
    ch2 = section(wp, 89, 225)
    ch3 = section(wp, 227, 291)
    build_epub(
        os.path.join(OUT, 'w-pustyni-i-w-puszczy-roz-1-3.epub'),
        'W pustyni i w puszczy (rozdz. I–III)', 'Henryk Sienkiewicz', 'pl',
        [('Rozdział I', ch1), ('Rozdział II', ch2), ('Rozdział III', ch3)],
    )

    # --- Poe, The Tell-Tale Heart (1843, public domain) ---
    poe = read_lines('poe.txt')
    start = 9252  # 0-based line of the story title
    # the volume has no next-story all-caps marker; the story ends at "hideous heart!"
    end = next(i for i, l in enumerate(poe) if 'hideous heart' in l.lower()) + 1
    body = '\n\n'.join(p.strip() for p in '\n'.join(poe[start:end]).split('\n\n') if p.strip())
    build_epub(
        os.path.join(OUT, 'poe-the-tell-tale-heart.epub'),
        'The Tell-Tale Heart', 'Edgar Allan Poe', 'en',
        [('The Tell-Tale Heart', body)],
    )


if __name__ == '__main__':
    main()
