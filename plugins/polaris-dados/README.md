# Polaris Dados engine module

This directory holds the pure formula engine extracted for the Polaris Dados plugin. It has no
runtime dependency on Morrow host internals; the host's public data API is supplied by a later
integration layer.

## Provenance and license

The parser and evaluator in `src/engine/formula.ts` derive from the published `hodeliun/Morrow`
fork at commit `778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106`, source path `src/core/formula.ts`,
Git blob `9bdc3c558ca981ed592a5fe5170bba030b94105a`. The original project is licensed under
Apache-2.0; the repository-root `LICENSE` applies to this derived source.

`src/engine/dateValues.ts` contains only `isValidDateKey`, `isValidDateTime`, and the private
`isValidTime` helper required by the latter. They derive from the same commit's
`src/core/typedValues.ts` (blob `a071a4a8506e9f1680328901dace009b9ee6c6ab`). The original engine
import from `./typedValues` was changed to the plugin-local `./dateValues` import. Parser,
evaluator, error behavior, and length/depth/work limits remain copied from the pinned formula
source. The tests adapt pertinent cases from `src/core/formula.test.ts` and add the P1 quantity ×
price examples and explicit bounds checks.

## Scope

The module exports `parseFormula`, `evaluateRuntimeFormula`, and `computeRuntimeFormula`. The
runtime context must be supplied by its caller. This extraction demonstrates the engine module
and its pure test coverage; it does not claim P2/P4 parity, a complete plugin bundle, host provider
registration, UI behavior, or runtime activation.
