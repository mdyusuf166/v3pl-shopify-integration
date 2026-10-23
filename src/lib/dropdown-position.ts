/**
 * Placement for a dropdown rendered in a portal (position: fixed), so table wrappers with
 * `overflow-x-auto` can never clip it (QA UI-07). Pure so it can be unit-tested.
 */
export type AnchorRect = { top: number; bottom: number; left: number; width: number };
export type DropdownPlacement = { top: number; left: number; width: number; maxHeight: number; direction: "below" | "above" };

export const DROPDOWN_GAP = 4;
export const DROPDOWN_MIN_HEIGHT = 120;

export function placeDropdown(anchor: AnchorRect, viewport: { width: number; height: number }, desiredMaxHeight = 256): DropdownPlacement {
  const spaceBelow = viewport.height - anchor.bottom - DROPDOWN_GAP;
  const spaceAbove = anchor.top - DROPDOWN_GAP;
  const below = spaceBelow >= Math.min(desiredMaxHeight, DROPDOWN_MIN_HEIGHT) || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(DROPDOWN_MIN_HEIGHT / 2, Math.min(desiredMaxHeight, below ? spaceBelow : spaceAbove));
  const width = Math.max(160, anchor.width);
  const left = Math.max(0, Math.min(anchor.left, viewport.width - width));
  const top = below ? anchor.bottom + DROPDOWN_GAP : Math.max(0, anchor.top - DROPDOWN_GAP - maxHeight);
  return { top, left, width, maxHeight, direction: below ? "below" : "above" };
}
