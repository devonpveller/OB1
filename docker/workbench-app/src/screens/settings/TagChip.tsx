// The tag chip of a settings row (rwr-settings-shell): who can see the value, from the registry row's tag.
import { TAG_LABEL } from "./settings-data";

export function TagChip({ tag }: { tag: string | null }) {
  const known = tag !== null && tag in TAG_LABEL;
  return (
    <span className={"tag tag-" + (known ? tag : "none")} data-testid="tag" data-tag={tag ?? "none"}>
      {known ? TAG_LABEL[tag!] : "No tag"}
    </span>
  );
}
