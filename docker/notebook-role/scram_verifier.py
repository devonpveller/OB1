#!/usr/bin/env python3
"""Set ob_notebook's password from its secret FILE without the plaintext leaving this process.

    python scram_verifier.py [--generate] <secret-file> | docker exec -i openbrain-db \
        psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -X -q

Prints ONE statement, `ALTER ROLE ob_notebook PASSWORD 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>';`,
on stdout: a SCRAM-SHA-256 verifier computed here (RFC 5802 / RFC 7677, the format PostgreSQL stores
with password_encryption = scram-sha-256). The server stores it as given, so the password itself
never reaches the server, a command line, the process list or a server log - only this verifier,
which a client cannot log in with.

--generate: when <secret-file> does not exist, write a new random password to it first (64 hex
characters, the same strength as `openssl rand -hex 32`). An existing file is never overwritten.

The file is read as UTF-8 with ONE trailing line break dropped - exactly as open_notebook reads
OB1_DB_PASSWORD_FILE (open_notebook/database/ob1_repository.py, _password_from_file). Only
printable ASCII is accepted (no SASLprep here); an empty or longer-than-4-KiB file is refused.
Nothing about the value is ever printed to stderr.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sys

ITERATIONS = 4096  # PostgreSQL 16's scram_iterations default
MAX_BYTES = 4096
ROLE = "ob_notebook"


def read_password(path: str) -> str:
    with open(path, "rb") as fh:
        raw = fh.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("the secret file is larger than 4 KiB")
    value = raw.decode("utf-8")
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if not value:
        raise ValueError("the secret file is empty")
    if any(not (0x20 < ord(c) < 0x7F) for c in value):
        raise ValueError("the password must be printable ASCII without spaces")
    return value


def verifier(password: str, salt: bytes | None = None, iterations: int = ITERATIONS) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def generate(path: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="ascii", newline="\n") as fh:
        fh.write(secrets.token_hex(32) + "\n")


def main(argv: list[str]) -> int:
    args = [a for a in argv if a != "--generate"]
    if len(args) != 1:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    path = args[0]
    try:
        if "--generate" in argv and not os.path.exists(path):
            generate(path)
            print(f"wrote a new password to {path}", file=sys.stderr)
        v = verifier(read_password(path))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        print(f"refused: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(f"ALTER ROLE {ROLE} PASSWORD '{v}';\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
