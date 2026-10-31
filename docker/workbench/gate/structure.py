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
            overlapping-text    glyphs drawn over each other on one line (cells running into their
                                neighbours), at least `min_overlaps` times on a page
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
    rows = {}
    for c in chars:
        rows.setdefault(round(c["top"], 1), []).append(c)
    hits = []
    for r in rows.values():
        r.sort(key=lambda c: c["x0"])
        for a, b in zip(r, r[1:]):
            w = min(a["x1"] - a["x0"], b["x1"] - b["x0"])
            if w > 0 and (a["x1"] - b["x0"]) > 0.3 * w:
                hits.extend([a, b])
    if len(hits) // 2 >= int(opts.get("min_overlaps", 3)):
        out.append({"code": "overlapping-text", "page": page.page_number, "count": len(hits) // 2,
                    "detail": f"{len(hits) // 2} place(s) where glyphs are drawn over each other", "sample": sample(hits)})
    return out


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
                                             "top": round(float(ln["top"]), 2), "bottom": round(float(ln["bottom"]), 2)} for ln in page.extract_text_lines()])
                    page.close()
    except Exception as e:  # unreadable: the caller fails closed
        result["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        print(json.dumps(result))
        return 3
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
