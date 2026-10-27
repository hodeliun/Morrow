## Parent

#7

## What to build

Add an explicit sequential default for new numeric rows, with start and increment, separately from step validation and ordinary literal/formula defaults.

## Acceptance criteria

- [ ] Creating rows from a zero start and increment one yields 0, 1, 2; explicit values take precedence.
- [ ] Deleted numbers are not reused inadvertently; reopening and concurrent creation preserve the next value.
- [ ] Existing rows and ordinary defaults remain unchanged; invalid increments are rejected.
- [ ] Command/session tests cover undo and creation failures.

## Blocked by

#14.
