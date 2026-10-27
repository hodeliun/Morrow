## Parent

#7

## What to build

Verify and expose relational dot projection in the public fork, including blank/single/multiple relations, and add a pure lazy `IfError(expression, fallback)` function with documented error and empty semantics.

## Acceptance criteria

- [ ] A formula selected from UI can project `thisRow.Relacao.Valor`; typed result survives save/reopen and relation target rename.
- [ ] Blank relation returns blank/list as appropriate, without a formula error; missing targets and invalid columns still show diagnostics.
- [ ] `IfError` evaluates fallback only for a real evaluation error, not `null`, `false` or zero, and does not conceal errors without fallback.
- [ ] Core tests and formula guide document syntax and examples; current build/headless UI scenario is verified.

## Blocked by

#16 for the full UI scenario; core calculation can begin earlier.
