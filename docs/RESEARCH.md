# Research — 2026-10-26

## Evidence and boundaries

Morrow v1.2.0 inspected locally at upstream 0e630ccea927174a655404b7769b793f0a64e403. React/Tiptap renderer, pure core, Electron disk adapter, commands/session/save queue. Existing nine property types, same-row scalar formula parser, five view layouts inside database pages, unknown YAML fields, emoji page icons, centered covers. Full upstream source and tests retained.

External product documentation informed the functional patterns described here. No account data, live records, private references, or opaque IDs are included in this repository; every fixture is synthetic.

## Observed use cases

- Entertainment: title, single selects for category/status/rating, author, completion date, link, created timestamp, media and progress. A linked card view filters one category, groups by status, sorts by rating; main table exposes search/category/status filters. A Google Books Pack-derived page count exists: external Pack behavior is separate from local database functionality.
- Finance current: transactions with BRL currency, false defaults for checkboxes, single relations to banks/invoices/payment/category/assets, emission date and calculated creation timestamp. Signed amount uses If/Switch. Related bank/invoice/category rows filter transactions by year/month/status/control and sum projected amounts. Asset balances and planned totals use aggregates. Controls include selections, text, relations and booleans. Multi-row creation examples use Sequence, FormulaMap, WithName and explicit AddRow actions; reset actions clear controls.
- Finance legacy: linked expense views, date/year defaults, image/file fields, self-relations for parent/subitems, monthly summary columns and totals in page text. Deleted controls produce broken filters. Preserve diagnostics rather than reproduce broken references. A description column with numeric format is a source anomaly, not intended target behavior.
- RPG: editable image/icon/cover/title; portrait, characteristics and navigation in columns; headings with full-width shaded rounded backgrounds; nested linked pages, long prose, media, lists/toggles, ordinary Markdown tables, editable database-backed information and formulas. All must be authorable from UI, not hardcoded HTML for one page.

## Primary sources

- https://github.com/Aarav2709/Morrow/tree/v1.2.0
- https://help.coda.io/hc/en-us/articles/39555851862925-Column-basics
- https://help.coda.io/hc/en-us/articles/39555878926861-Connect-tables-with-relation-columns
- https://help.coda.io/hc/en-us/articles/39555809935629-Create-two-way-table-connections-with-linked-relations
- https://help.coda.io/hc/en-us/articles/39555813909261-Use-the-Filter-formula
- https://help.coda.io/hc/en-us/articles/39555751409933-Use-FormulaMap-to-repeat-actions-across-a-list
- https://help.coda.io/hc/en-us/articles/39555713701645-Progress-bar-column-type
- https://help.coda.io/hc/en-us/articles/39555806187917-Canvas-column-type
- https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
- https://www.notion.com/help/guides/page-icons-and-covers
- https://lucide.dev/license

No private source-system handles, records, or account exports were copied. Repository documents record functional patterns only.

## Icons

Notion documentation confirms built-in icons, emoji and custom uploads, but no redistributable license for its proprietary icon collection was located. Do not describe an unrelated pack as the Notion pack or scrape/repackage unlicensed assets. Ship a licensed monochrome recolorable Lucide catalog (already a dependency, ISC with some Feather-derived MIT assets), retain notices, and support local custom icon uploads. Exact Notion collection import remains conditional on a compatible license supplied/verified, not silently claimed complete.

## OKF

OKF 0.2: Markdown, YAML `type` for concepts, reserved index.md/log.md, path-based identity and standard Markdown links. Morrow preserves many unknown fields but the generic editor flattens arrays of objects when committed. Fix structured editing, retain complex values and paths; do not auto-convert personal notes or invent verification metadata. Application metadata may coexist; linked-view/formula runtime is an application extension, not an OKF guarantee.
