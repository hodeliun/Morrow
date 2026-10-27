## Parent

#7

## What to build

Verify the combined interaction changes as one usable Morrow build with a synthetic two-table workspace, then produce a Windows portable artifact for user testing without changing installed Morrow or personal vaults.

## Acceptance criteria

- [ ] `npm run check` and Windows CI pass on the integrated `main` branch.
- [ ] In an isolated profile, create a page with custom colors and resized prose columns, create two related tables, project a related value, handle a real formula error, format a number, use a sequential default and filter a linked view.
- [ ] Close/reopen preserves intended values and appearance; original installation and vault are untouched.
- [ ] Publish a clearly versioned portable build with commit hash and known limitations; do not claim an installed update.

## Blocked by

#8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18 and #20.
