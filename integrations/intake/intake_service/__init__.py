"""The intake SERVICE (security-hardening-2026-10, build item I5): an HTTP service and its
worker pool around the intake library (../intake/). Fork-owned (../FORK-OWNED.md).

  python -m intake_service serve     the service (POST /v1/intake, GET /v1/stats, /metrics, /healthz)
  python -m intake_service relay     the TCP relay to openbrain-db (the service's only DB route)
  python -m intake_service verify    check the classifier files against their pins and exit

See ../README.md, "What I5 ships".
"""
