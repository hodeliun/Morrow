# Persisted format 13

Format 13 follows the repository's versioning convention. Its first curated
publication belongs to the T03 delivery; later interfaces may expose the data
contracts below without introducing another shape change.
`SCHEMA_VERSION` is 13, and the migration from 12 to 13 is an
identity migration. Existing normalizers supply safe defaults; the migration
does not synthesize new values in old documents.

The additive extensions currently included are:

- An optional database `titleAlias`, which labels the virtual title column
  without duplicating or replacing row titles.
- The database display-property default continues to accept legacy omission or
  explicit `null` as the virtual title column. Reading either form must not mark
  a valid legacy database read-only or rewrite its file merely on open.
- View-local column order that can include the virtual `title` token while
  retaining opaque IDs.
- Image width and inert image-marker compatibility metadata remain supported.
  These were already published with T18 on format 12 and are retained here;
  they are not a newly introduced format-13 interface.
- An optional named-control `textFormat` (`plain` or `email`). Absence retains
  legacy text behavior. Formula values remain strings; this adds no formula
  interpreter or control type.
- The `multiSelect` named-control type, reusing select-option IDs for typed
  current and default lists. An empty list remains distinct from `null`; formulas
  receive the ID list directly. This is an additive value type within the same
  unpublished format 13 delivery.
- The `scale` and `progress` named-control types, which store finite numbers
  with explicit minimum, maximum, and step settings. Scale settings also retain
  the icon, color, and value-display preferences. Calculated results may declare
  the readonly `scale` output type; both numeric result types preserve the raw
  formula number and validate it against their configured range.
- The `dateRange` named-control type, storing either `null` or exactly two
  ordered ISO date keys. Its selected presets materialize those endpoints;
  reopening does not recalculate them.
- The optional per-note `calculatedResultBackground` choice. An absent field
  normalizes to `null` and displays the legacy enabled background. Explicit
  booleans round-trip through snapshots and backup; Markdown uses the managed
  `morrowCalculatedResultBackground` key and omits the legacy `null` value.
  An invalid non-boolean value fails safely instead of being discarded during
  an unrelated edit.

This list defines the contracts consolidated for the first curated format-13
delivery. A later published delivery that changes the persisted shape requires
another compatible version and migration, rather than silently reusing format
13. Exposing an already defined contract through a later interface is not itself
a persisted-shape change.

The first curated commit that introduces format 13 must contain the readers,
normalizers and persistence contracts for all these additions. Later interface
commits may expose them, but must not leave an intermediate format-13 reader
that silently drops fields already supported by that format. Before this
delivery, the published baseline was format 12; the earlier private test packages
were not a published format-13 product requiring a separate format-14 migration.

T03 exposes only its verified Name/display-property interface. The additional
named-control types and per-note result-background field are persistence
contracts in this delivery; their creation/editing widgets and appearance
controls are not advertised as delivered here. Formula-function additions such
as `Last()` are separate behavior and are not required by this format migration.

These contracts include Markdown import metadata, structured row clipboard
validation, duplicate/paste commands, simulated row-creation plans and
partial-save recovery journals.
An explicit background value must survive those paths, including `false`.
Legacy absence remains compatible; malformed values and unknown clipboard
fields still fail atomically. The profile's default is captured when a new
row is planned, so preview, execution and recovery describe the same value;
copying or importing an existing note preserves its own value instead.

## Compatibility and preservation

Format 12 data without the new fields remains loadable. Format 13 data must
round-trip the supported fields and preserve unknown data using the existing
compatibility paths. Unsupported named-control metadata opens read-only with
its original content intact. Versions greater than 13 are rejected safely.

Named-control defaults apply during creation or explicit reset. Reconfiguring
a control preserves a compatible current value and rejects incompatible
settings atomically. Explicit clearing stores `null`; it is distinct from an
absent field, zero, false, and resetting to the default.

Opening legacy Markdown notes must not rewrite their bytes or modification
times merely to introduce these fields. The 12-to-13 IndexedDB migration
updates only its schema-version metadata, retaining the original stored page
and document records, including fields that current normalizers cannot
represent. Normalizers still run on reading. A migration path that contains
an older or future step without this record-preservation annotation retains
the existing internal record-rewrite behavior. These internal migrations are
separate from rewriting vault Markdown files.

## Verification required before publication

The delivery gate covers loading format 12 with defaults, format 13
round-trips, safe rejection of format 14 and later, preservation of unsupported
metadata, and unchanged legacy Markdown bytes and modification times on open.
The integration gate remains `npm run check`; UI acceptance and evidence are
recorded separately in the Scope 2 execution record. This note does not claim
that an unexecuted gate or UI scenario has passed.
