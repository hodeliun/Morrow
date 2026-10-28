## Parent

https://github.com/hodeliun/Morrow/issues/45

## What to build

Finish the requested table interactions and consistent presentation across canonical inline tables and linked views.

## Acceptance criteria

- [ ] Hiding a linked table title also hides its source name; restoring it and opening source/options remain discoverable.
- [ ] Clicking the six-dot row grip selects the row; right-click opens its actions, while drag and keyboard accessibility continue working, including filtered and multi-row selection.
- [ ] The permanent toolbar is compact rather than retaining six redundant settings buttons; active filters/sorts and all settings remain discoverable.
- [ ] Canonical inline and linked tables of the same source and view state use matching typography, header/body/background/border and table layout. Independent names and configuration persist.
- [ ] Calculation footer and body alignment agree for default numeric columns and explicit alignments, including resizing, scrolling and frozen columns. Calculation affordances are discreet but accessible.
- [ ] Actual UI regression verification and persistence evidence cover these interactions without weakening existing acceptance.

## Blocked by

None — can start immediately; serialize shared table component ownership with the data and editor deliveries.


