## Parent

https://github.com/hodeliun/Morrow/issues/45

## What to build

Create inverse relations reliably and make row operations reliable through undo, recovery and reopening. Preserve existing reciprocal relations and atomic validation.

## Acceptance criteria

- [ ] Creating a new inverse from a unidirectional relation succeeds and persists both reciprocal schemas and values after reopening.
- [ ] Linking existing populated relations preserves their union; cardinality errors and invalid configurations reject atomically.
- [ ] Insert-before, undo, then insert-after yields the correct rows and values without silently dropping an action; diagnose the existing failing regression rather than weakening its assertions.
- [ ] Duplicate, copy, move, trash and undo/recovery remain correct after reopening.
- [ ] Meaningful command/storage regression tests and actual hidden UI verification pass; document the root cause and evidence.

## Blocked by

None — can start immediately.


