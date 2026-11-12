# Polaris Dados pilot plugin

This directory holds the first real Polaris Dados provider for Morrow's public database-provider
API v1. It renders the opted-in database's schema and rows, lets the user edit finite numeric cells
with a local draft and Save/Cancel, calculates formula columns through the extracted engine, and
uses the host's contextual data history. The first synthetic fixture has `Name`, `Quantity`,
`Price`, and `Total`; it is a P1 pilot, not a claim of full data-domain parity.

## Build and synthetic vault

From the repository root:

```sh
npm run build:polaris-dados
node scripts/pilot/create-polaris-dados-fixture.mjs /tmp/morrow-polaris-dados-fixture
```

The build writes one ESM file at `dist/polaris-dados/main.js`; it has no runtime imports, CSS
sidecar, or source map. Host API imports in the source are type-only and are removed from the bundle.
The fixture command copies the bundle, manifest, this README, and the repository Apache-2.0
license into `.morrow/plugins/polaris-dados/`, seeds the synthetic Inventory/Widget pages and
stable workspace IDs, and enables this plugin in that fixture. It creates a new directory or uses
an empty one; it refuses a destination that already contains files. Build the bundle first.

The plugin can also be loaded from an isolated vault by copying those files to the same paths and
adding `polaris-dados` to `.morrow/plugins.json`'s `enabled` list. Morrow's local plugin preference
must also be enabled for that test account. Do not point the fixture command at a personal vault.

## Runtime behavior and limits

- A draft holds the snapshot revision captured when its editor opened. A concurrent change keeps the
  draft stale and requires Cancel/reopen before another save.
- `patchCell` stages the update. The grid marks it as pending until `data.flush` reports persistence;
  a failed flush preserves the staged value and offers Retry.
- Undo/redo go through `data.history`, including the host's non-bubbling root key events. Input text
  undo stays with the browser's number editor. Subscription and event cleanup follows the mount's
  `AbortSignal`.
- Formula references must resolve to a schema property. Known null or missing cell values stay blank;
  an unknown property is a formula error. Formula-to-formula references have cycle, depth, and work
  limits in the plugin wrapper.
- The grid does not add an advanced formula editor, linked-view settings, extra database types,
  controls, or parity claims for the fork's other features.

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

The repository-root Apache-2.0 license accompanies the plugin when the fixture is created.

## Engine source

The module exports `parseFormula`, `evaluateRuntimeFormula`, and `computeRuntimeFormula`. The
runtime context must be supplied by its caller. No runtime file, network, shell, or host-internal
capability is given to the formula engine.
