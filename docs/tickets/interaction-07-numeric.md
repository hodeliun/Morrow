## Parent

#7

## What to build

Clarify number/currency settings, render fixed decimal places, distinguish locale/step/bounds/defaults, and offer explicit save/cancel for a batch of format edits.

## Acceptance criteria

- [ ] A value `2` with two decimal places displays `2,00` in pt-BR and reopens identically without changing stored `2`.
- [ ] Locale, minimum, maximum and step have accessible explanations and a visible preview.
- [ ] Invalid values receive a clear diagnostic; unsaved edits can be canceled; current data are not rounded or rewritten.

## Blocked by

None — can start immediately.
