"""Shared items for the mutants (kept apart so the static scan of a mutant sees only its own code)."""
from connector_kit import Item

ITEMS = (Item(external_id="m/1", content_type="text/plain", raw="first mutant item"),
         Item(external_id="m/2", content_type="text/plain", raw="second mutant item"))
