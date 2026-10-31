# LAB ONLY (rw-p7a-tts): make a COPY of an Open Notebook SurrealDB export importable into a fresh lab
# SurrealDB 2.6 (the pinned image). Two things in the nightly export do not round-trip through that
# version's importer (measured 2026-10-30):
#   1. "DEFINE FIELD ..." for a field the table already defines implicitly (a relation's in/out, an
#      array's [*] element) is refused as "already exists": written as DEFINE FIELD OVERWRITE.
#   2. a "\0" escape inside a string literal is refused by the parser: written as "\u0000" (the same
#      character), only where the backslash is not itself escaped.
# Rows and every other statement are copied unchanged. Usage: python fix-surreal-export.py <in> <out>
import re
import sys

BS = "\\"
ESC0 = re.compile("(?<!" + BS * 2 + ")((?:" + BS * 4 + ")*)" + BS * 2 + "0")
fields = escapes = 0
with open(sys.argv[1], encoding="utf-8") as src, open(sys.argv[2], "w", encoding="utf-8", newline="\n") as out:
    for line in src:
        if line.startswith("DEFINE FIELD ") and not line.startswith("DEFINE FIELD OVERWRITE "):
            line = "DEFINE FIELD OVERWRITE " + line[len("DEFINE FIELD "):]
            fields += 1
        fixed = ESC0.sub(lambda m: m.group(1), line)
        escapes += fixed != line
        out.write(fixed)
print(f"fix-surreal-export: {fields} DEFINE FIELD -> OVERWRITE, {escapes} line(s) with a NUL dropped")
