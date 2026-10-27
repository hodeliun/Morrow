# Formula language

Formula columns and formula defaults use the same bounded expression language. Formula outputs are derived when read; they are not written into row values. The evaluator is pure: it has no network, file, command, or workspace-write access.

## References and lists

- `prop("Price")` remains supported for existing same-row formulas.
- `thisRow.Amount` reads a field from the current row. Bracket access such as `thisRow["Valor total"]` supports names with spaces or punctuation; backtick-quoted identifiers are also supported.
- A related row can be projected with `thisRow.Customer.Balance`. A blank single relation projects to blank, while a blank multi-row relation projects to an empty list. Single and multiple relations keep their typed projected values; missing targets, unavailable rows and invalid columns still produce diagnostics. Stable bindings keep the projection working after a table or column rename.
- A table can be queried by name: `Transactions.Filter(CurrentValue.Status = "Paid").Amount.Sum()`.
- Identifiers support Unicode. Backticks quote names containing spaces. Bracket access such as `thisRow["Valor total"]` is also supported.
- Lists use `[1, 2, 3]` or `List(1, 2, 3)`. `FormulaMap(list, expression)` and `ForEach(list, expression)` evaluate the expression with each item as `CurrentValue`.

The formula editor offers function, field, and table selectors plus name suggestions. It previews the first row when one exists and shows parse, reference, cycle, and type errors in the editor and calculated cell. A table or column selector stores a source-span binding to stable IDs. Renaming keeps the binding; deleting a referenced object leaves a visible missing-reference error. Duplicate names are reported as ambiguous unless the editor selected the intended ID. Binding works from the schema, including when a table has no rows.

## Functions

`If(test, yes, no)` evaluates only the selected branch. `IfError(expression, fallback)` evaluates the fallback only when evaluating the first expression raises an error, for example `IfError(thisRow.Amount / thisRow.Count, 0)`. Blank, `false` and `0` are returned unchanged, and an error in the fallback remains visible. `Switch(value, case1, result1, case2, result2, default)` compares in order; the final argument is an optional default. `WithName(value, name, expression)` binds `name` for the expression; the name can be an identifier (`WithName(5, amount, amount * 2)`) or quoted text. Nested scopes can refer to outer names.

| Function | Meaning |
| --- | --- |
| `IfError(expression, fallback)` | Uses the fallback only for an evaluation error in the first expression; blank, `false` and zero are ordinary results. |
| `Contains(text, part)` / `Contains(list, value)` | Case-insensitive text search, or typed list membership. |
| `Unique(list)` | Keeps the first occurrence of each typed value. |
| `List(value, ...)` | Creates a list. |
| `Sequence(count)` | Creates integers from 1 through count. `Sequence(start, end, step)` uses an inclusive end; step defaults to 1. |
| `FormulaMap(list, expression)` / `ForEach(list, expression)` | Returns one expression result per item, with `CurrentValue` set for each evaluation. These functions do not perform actions or writes. |
| `First(list)` | Returns the first item, or blank for an empty list. |
| `IsBlank(value)` | True for blank, empty text, or an empty list. `Empty` is a legacy alias. |
| `ToNumber(value)` / `ToText(value)` | Converts a finite numeric string to a number, or a scalar to text. Invalid numeric input is an error. |
| `Round(value, places)` | Rounds decimal places (0 by default, capped at 10) using decimal half-away-from-zero rounding. |
| `Floor(value)` / `Mod(value, divisor)` | Floors a number, or returns the remainder. A zero divisor is an error. |
| `Sum(list)`, `Average(list)`, `Count(list)`, `Min(list)`, `Max(list)` | Aggregates scalar lists. The equivalent list methods are `.Sum()`, `.Average()`, `.Count()`, `.Min()`, and `.Max()`. |

The earlier scalar helpers remain available: `Empty`, `Ceil`, `Abs`, `Sqrt`, `Length`, `Concat`, `Join`, `Upper`, `Lower`, `Replace`, `Slice`, `Now`, `Today`, `DateAdd`, `DateBetween`, `Year`, `Month`, and `Day`. `Today()` returns a `YYYY-MM-DD` key; `Now()` returns epoch milliseconds. Dates must be real calendar dates. Date-times require a valid timezone. Month and year additions clamp to the last valid day of the destination month. Date-time arithmetic preserves the represented instant.

## Types, defaults, and limits

Property reads return their stored typed value: numbers and currency stay numeric, checkboxes stay boolean, and dates stay date keys. Select and multi-select IDs remain the stored values, while formulas expose their configured option names so expressions such as `CurrentValue.Status = "Concluído"` and `Contains(thisRow.Tags, "Urgent")` are readable. Display formatting is applied by the UI after evaluation. Blank, false, and zero remain distinct. Invalid math, missing references, ambiguous names, unsupported types, cycles, division by zero, and invalid options produce errors instead of an implicit zero or empty value.

Calculated typed fields validate their output against the field type. Multi-select formulas accept a list of configured option names or IDs; any unknown option is an error. Formula columns can return typed scalar or mixed-value lists, rows, and tables; these results remain derived and are rendered without writing them into row data. Calculated relation fields accept row references or lists from their configured target table and resolve them to validated row IDs.

Creation defaults apply literal values first and resolve formula defaults by dependency, regardless of column order. Explicit values supplied during creation take precedence. A formula default is evaluated once and materialized as the row's initial value; later edits do not keep it synchronized. Cyclic defaults stop row creation with an error.

The parser accepts at most 2,000 source characters and 64 nested expression levels. Evaluation stops after 10,000 expression steps. `Sequence`, `FormulaMap`, and `ForEach` each return at most 2,000 items. Table filters inspect live rows only. Persisted formula results are cached against an immutable workspace snapshot for up to one second; unsaved rows and editor previews bypass the result cache. The evaluator context has a resolver seam for future named controls, but control binding and mutations belong to the controls/action feature.
