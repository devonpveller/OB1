"""The export gate's structure and layout checks (research-workbench P6b, rw-p6b-gate).

    /opt/export-gate/bin/python -I /app/gate/structure.py <file.pdf> '<options JSON>'

Run by the workbench (src/export/gate.ts) as a SEPARATE PROCESS over a file; it prints one JSON
object on stdout and exits 0 when it could read the PDF (whatever it found), 3 when it could not.
It reads the PDF with pikepdf (MPL-2.0, unmodified) and pdfplumber (MIT); nothing here imports or
links poppler (GPL, D9 rule 4): the rasteriser, pdftoppm, is a different process the workbench runs.

What it reports (codes are the gate's closed vocabulary; the workbench owns the verdict):
  blocking  no-pages            the PDF has no page
            font-not-embedded   a font the pages use carries no font program (it renders as another
                                face, or not at all, on the reader's machine)
            clipped             text drawn outside the page box: cut off on every reader
            overflow            a letter or digit outside the page's TEXT AREA horizontally (the format's margins,
                                passed in the options): a table or line wider than the page - a
                                clipped table, a long unbreakable cell, a run-off line
            overlapping-text    glyphs of different text runs drawn over each other (a cell running
                                into its neighbour, in any font), at least `min_overlaps` (1) times on a
                                page; kerning and combining marks are not collisions (collisions())
            too-many-pages      more pages than `max_pages`: not checked, so not passed
  warning   qpdf                what qpdf's own structure check reports (pikepdf Pdf.check)
and the text of every page and its lines with their left edges (pdfplumber), for the reference-list
and required-section checks.
"""
import json
import sys


def font_problems(pdf):
    """Every font a page uses directly or through a form XObject that has no embedded program."""
    import pikepdf

    missing = []
    seen = set()

    def walk_resources(res, page_no, depth=0):
        if res is None or depth > 4:
            return
        fonts = res.get("/Font")
        if fonts is not None:
            for _name, font in fonts.items():
                try:
                    key = font.objgen
                except Exception:
                    key = None
                if key is not None and key != (0, 0):
                    if key in seen:
                        continue
                    seen.add(key)
                sub = str(font.get("/Subtype", ""))
                if sub == "/Type3":
                    continue  # glyphs are content streams: nothing to embed
                desc_font = font
                if sub == "/Type0":
                    desc = font.get("/DescendantFonts")
                    if desc is None or len(desc) == 0:
                        missing.append({"page": page_no, "font": str(font.get("/BaseFont", "?"))})
                        continue
                    desc_font = desc[0]
                fd = desc_font.get("/FontDescriptor")
                embedded = fd is not None and any(k in fd for k in ("/FontFile", "/FontFile2", "/FontFile3"))
                if not embedded:
                    missing.append({"page": page_no, "font": str(font.get("/BaseFont", desc_font.get("/BaseFont", "?")))})
        xobjects = res.get("/XObject")
        if xobjects is not None:
            for _n, xo in xobjects.items():
                if isinstance(xo, pikepdf.Stream) and str(xo.get("/Subtype", "")) == "/Form":
                    walk_resources(xo.get("/Resources"), page_no, depth + 1)

    for i, page in enumerate(pdf.pages, start=1):
        walk_resources(page.obj.get("/Resources"), i)
    return missing


def sample(chars, n=80):
    return "".join(c["text"] for c in sorted(chars, key=lambda c: (round(c["top"]), c["x0"])))[:n]


def layout(page, opts):
    """Blocking findings for one pdfplumber page."""
    tol = float(opts.get("tolerance", 2.0))
    left = float(opts["text_area"]["left"])
    right_margin = float(opts["text_area"]["right"])
    width, height = float(page.width), float(page.height)
    right = width - right_margin
    x_min, top_min = float(page.bbox[0]), float(page.bbox[1])
    chars = [c for c in page.chars if c.get("text", "").strip()]
    out = []
    clipped = [c for c in chars
               if c["x0"] < x_min - tol or c["x1"] > x_min + width + tol or c["top"] < top_min - tol or c["bottom"] > top_min + height + tol]
    if clipped:
        out.append({"code": "clipped", "page": page.page_number, "count": len(clipped),
                    "detail": f"{len(clipped)} glyph(s) drawn outside the page box", "sample": sample(clipped)})
    gone = {id(c) for c in clipped}
    # letters and digits only: Typst hangs punctuation (a comma, a hyphen, a quote) a few points into the
    # margin on purpose (optical margin alignment) - that is typography, not an overflow
    over = [c for c in chars if id(c) not in gone and c["text"].isalnum() and (c["x0"] < x_min + left - tol or c["x1"] > x_min + right + tol)]
    if over:
        xs = [c["x0"] for c in over] + [c["x1"] for c in over]
        out.append({"code": "overflow", "page": page.page_number, "count": len(over),
                    "detail": f"{len(over)} glyph(s) outside the text area (x {min(xs):.1f}..{max(xs):.1f} pt; text area {x_min + left:.1f}..{x_min + right:.1f} pt)",
                    "sample": sample(over)})
    pairs = collisions(page.chars)
    if len(pairs) >= int(opts.get("min_overlaps", 1)):
        hit = [c for p in pairs for c in p]
        out.append({"code": "overlapping-text", "page": page.page_number, "count": len(pairs),
                    "detail": f"{len(pairs)} place(s) where glyphs of different text runs are drawn over each other", "sample": sample(hit)})
    return out


# Kerning is at most a small fraction of the type size; CJK punctuation compression (a full-width
# quote, comma or bracket set half-width) is up to half an em. Measured on the tester's clean pages:
# Latin kerns 1.1 pt (0.10 em, "w."), a CJK quote before a comma 2.14 pt (0.19 em); a table cell running
# into the next one: 2.7-6.1 pt (0.25-0.55 em) of one glyph over the other's.
# Two full-width punctuation marks in a row (。「) are BOTH compressed: 6.26 pt (0.57 em) measured.
KERN_EM = 0.18
CJK_PUNCT_EM = 0.55
CJK_PUNCT_PAIR_EM = 0.8


def collisions(all_chars):
    """Pairs of glyphs drawn over each other.

    rw-p6b-gate round 3 (tester t-p6b-gate2 D8, D9). Round 2 exempted every pair of glyphs adjacent in
    drawing order (kerning only moves a glyph against its neighbour), but Typst draws a table cell right
    after the previous one, so a cell's last glyph over the next cell's first glyph was exempt (D8).
    Now a pair adjacent in drawing order is exempt only within kerning distance: its boxes overlap by at
    most KERN_EM of the type size (CJK_PUNCT_EM when one of them is East-Asian full-width punctuation).
    Any other pair counts when the boxes overlap by more than 30% of the narrower advance (and at least
    1.5 pt) and by more than half the shorter height.
    MATH (D9): Typst assembles accents, arrows, braces and radicals from pieces of the math font placed
    over, under and into each other by design (the OpenType MATH table), so two glyphs BOTH set in a math
    font are never a collision; a math glyph over a text glyph (a formula spilling over prose or another
    cell) still is. Combining marks (Unicode category M*) are skipped.
    """
    import unicodedata

    def is_mark(c):
        t = c.get("text", "")
        return len(t) == 1 and unicodedata.category(t).startswith("M")

    def is_math(c):
        return "math" in str(c.get("fontname", "")).lower()

    def wide_punct(c):
        # full-width punctuation: East-Asian wide, or an ambiguous-width mark (quotes) set in a CJK face
        t = c.get("text", "")
        if len(t) != 1 or not unicodedata.category(t).startswith("P"):
            return False
        eaw = unicodedata.east_asian_width(t)
        return eaw in ("F", "W") or (eaw == "A" and "cjk" in str(c.get("fontname", "")).lower())

    chars = [(i, c) for i, c in enumerate(all_chars) if c.get("text", "").strip() and not is_mark(c)]
    chars.sort(key=lambda ic: ic[1]["x0"])
    active = []
    pairs = []
    for i, c in chars:
        active = [(j, a) for j, a in active if a["x1"] > c["x0"]]
        for j, a in active:
            if is_math(a) and is_math(c):
                continue
            w = min(a["x1"] - a["x0"], c["x1"] - c["x0"])
            h = min(a["bottom"] - a["top"], c["bottom"] - c["top"])
            ox = min(a["x1"], c["x1"]) - max(a["x0"], c["x0"])
            oy = min(a["bottom"], c["bottom"]) - max(a["top"], c["top"])
            if not (w > 0 and h > 0 and oy > 0.5 * h):
                continue
            if abs(i - j) <= 1:
                size = max(float(a.get("size", 0) or 0), float(c.get("size", 0) or 0))
                wa, wc = wide_punct(a), wide_punct(c)
                limit = (CJK_PUNCT_PAIR_EM if wa and wc else CJK_PUNCT_EM if wa or wc else KERN_EM) * size
                if ox > limit and ox > 1.5:
                    pairs.append((a, c))
            elif ox > max(0.3 * w, 1.5):
                pairs.append((a, c))
        active.append((i, c))
    return pairs


def main(argv):
    path = argv[1]
    opts = json.loads(argv[2]) if len(argv) > 2 else {}
    opts.setdefault("text_area", {"left": 0, "right": 0})
    max_pages = int(opts.get("max_pages", 500))
    result = {"pages": 0, "blocking": [], "warnings": [], "texts": [], "lines": [], "tools": {}}
    try:
        import pikepdf
        import pdfplumber
        result["tools"] = {"pikepdf": pikepdf.__version__, "pdfplumber": pdfplumber.__version__}
        with pikepdf.open(path) as pdf:
            result["pages"] = len(pdf.pages)
            # qpdf's own syntax check (pikepdf 10: check_pdf_syntax; older: check)
            syntax = getattr(pdf, "check_pdf_syntax", None) or getattr(pdf, "check")
            for p in list(syntax())[:20]:
                result["warnings"].append({"code": "qpdf", "detail": str(p)[:300]})
            if result["pages"] == 0:
                result["blocking"].append({"code": "no-pages", "detail": "the PDF has no page"})
            elif result["pages"] > max_pages:
                result["blocking"].append({"code": "too-many-pages", "detail": f"{result['pages']} pages; the gate checks at most {max_pages}"})
            else:
                for m in font_problems(pdf):
                    result["blocking"].append({"code": "font-not-embedded", "page": m["page"], "detail": f"font {m['font']} is not embedded"})
        if result["pages"] and result["pages"] <= max_pages:
            with pdfplumber.open(path) as doc:
                for page in doc.pages:
                    result["blocking"].extend(layout(page, opts))
                    result["texts"].append(page.extract_text() or "")
                    # every text line with its left edge (the reference list's entries: an author-date
                    # entry starts at the list's left edge, its continuation lines are indented)
                    result["lines"].append([{"text": ln["text"], "page": page.page_number, "x0": round(float(ln["x0"]), 2), "x1": round(float(ln["x1"]), 2),
                                             "top": round(float(ln["top"]), 2), "bottom": round(float(ln["bottom"]), 2),
                                             "size": round(max((float(ch.get("size", 0)) for ch in ln.get("chars", [])), default=0.0), 2)}
                                            for ln in page.extract_text_lines()])
                    page.close()
    except Exception as e:  # unreadable: the caller fails closed
        result["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        print(json.dumps(result))
        return 3
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
