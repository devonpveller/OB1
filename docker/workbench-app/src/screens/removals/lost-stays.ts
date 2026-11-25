// What each irreversible action here takes away and what it leaves, in plain words. The screen shows the
// matching pair before the typed word is asked for. Kept inside screens/removals/ (rwr-removals), apart from
// the shared shell, so the text and its test move together.
export const ERASE_WORD = "ERASE";
export const DELETE_WORD = "DELETE";

export type LostStays = { lost: string[]; stays: string[] };

// Erase for good (source stage 4: the row, its text pieces and revisions go; a named marker stays).
export const ERASE_SOURCE: LostStays = {
  lost: [
    "The saved text of this source and every earlier version of it.",
    "Its place in the library: it can no longer be opened, searched or cited.",
  ],
  stays: [
    "A marker with its address, title, the reason you pick, and the date, so the same address is not quietly added again.",
    "The trail line that says it was erased (the trail never loses lines).",
    "The marker can be lifted later to let the address in again; that does not bring the erased text back.",
  ],
};

// Delete forever (a trashed document leaves the trash for good).
export const DELETE_DOCUMENT: LostStays = {
  lost: [
    "The document in the trash: its text cannot be put back from this app once it is deleted.",
  ],
  stays: [
    "A line in the trail with its file name, when you deleted it and who did.",
    "The sources and claims it cited: they belong to the library, not to the document.",
  ],
};

// Lift the marker (the address of an erased source may be added again).
export const LIFT_MARKER: LostStays = {
  lost: ["The block on adding this address again."],
  stays: [
    "The erased text stays erased: lifting does not bring it back.",
    "The marker and its trail lines stay as a record; the trail gains a line saying it was lifted.",
  ],
};
