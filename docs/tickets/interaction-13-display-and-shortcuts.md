## Parent

#7

## What to build

Complete the column context menu with direct actions for formula and conditional formatting, and a database-level display column. The chosen display column is the default label of a row in relation pickers, references and previews. Existing per-relation display overrides take precedence. Keep the row's stored title and property values unchanged.

## Acceptance criteria

- [ ] A column can be selected as the database's display column from its menu; the current choice is visible and can be reset to the row title.
- [ ] Relation pickers and row references use the database default, unless a relation has its own explicit display override. Empty display values have a readable fallback.
- [ ] Menu actions open the existing formula and conditional formatting configuration at the relevant column without duplicating configuration logic.
- [ ] Markdown round trip, old vault migration, rename/delete of the selected property and linked views preserve a valid display choice or fall back safely.
- [ ] Keyboard, screen reader labels, translations and synthetic two-table UI verification work.

## Blocked by

#10, #11 and #12.
