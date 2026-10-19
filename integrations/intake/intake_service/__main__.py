"""python -m intake_service [serve|relay|verify]  (see app.py)"""
import sys

from intake_service.app import main

if __name__ == "__main__":
    sys.exit(main())
