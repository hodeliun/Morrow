## Parent

#7

## What to build

Offer an obvious custom color picker beside the existing presets for text, highlight and full block background. Make the custom icon color choice visibly identifiable as a picker. Persist safe hex colors in Markdown and reopen them unchanged.

## Acceptance criteria

- [ ] Presets remain available; custom picker accepts and displays a validated hex color and reset works.
- [ ] Text, highlight and block colors survive save/reopen and unsupported/malicious values do not become CSS or executable HTML.
- [ ] Picker has translated labels and keyboard focus; icon picker affordance is clear.
- [ ] Core round-trip and focused UI verification pass with synthetic notes.

## Blocked by

None — can start immediately.
