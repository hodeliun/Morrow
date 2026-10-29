# Domain documentation

Single context: docs/SPEC.md, docs/RESEARCH.md, docs/GRILLING.md. Existing upstream ARCHITECTURE.md describes module boundaries. Read only affected modules and tests.

Page = Markdown document; database = authoritative schema and rows; row = page belonging to a database; relation = typed stable row reference; linked view = independent presentation/query configuration over one database; control = named input on a document; formula = pure calculation; action = explicit mutation through commands; default = initial value only; display format = rendering of typed value; OKF = knowledge format, not database runtime.


Resource = an existing file in the vault or an explicitly opened HTTP(S) URL, distinct from a Markdown Page. Visibility rule = sidebar filter, not a deletion or file capability. File handler = Morrow's per-extension opening choice, separate from OS defaults. Tab instance = a resource target with navigation/view state. Pane = one visible leaf/group of tabs; split layout = device-local arrangement of at most four panes. Multiple instances of a note share the WorkspaceSession but not scroll/focus. See the planning-only files/web/panes addendum.
