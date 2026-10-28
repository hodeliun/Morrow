## Parent

https://github.com/hodeliun/Morrow/issues/45

## What to build

Allow automated verification of the actual packaged application without touching an installed user's profile, showing windows or registering the normal global capture shortcut. Existing development-only environment flags are ignored by packaged builds, so the release gate needs an explicit, constrained smoke-test mode.

## Acceptance criteria

- [ ] Normal installed startup and existing development behavior remain unchanged.
- [ ] Packaged smoke requires an explicit smoke-test command-line flag, hidden-mode opt-in and an absolute synthetic profile under a new dedicated temporary root. Incomplete or invalid combinations fail before filesystem writes, path configuration, single-instance lock or window creation, with no fallback to the personal profile.
- [ ] Validate path containment by segments and real filesystem resolution; reject symlinks, junctions, escapes, relative paths and ambiguous sibling prefixes. Do not redirect global APPDATA or relax the generic packaged environment override.
- [ ] The test profile and session paths are set before locking; no window is shown and the global capture shortcut is not registered in smoke mode.
- [ ] Meaningful tests cover pure startup decisions, invalid combinations, filesystem guards and no-side-effect failure ordering.
- [ ] The release gate can demonstrate actual packaged status, version, effective isolated paths, zero visible windows and synthetic persistence/reopen. This support ticket need not build or publish release artifacts itself.

## Blocked by

None — can start immediately. The release gate depends on this support as well as the three correction deliveries.

## Local source checkpoint — 28/10/2026

The startup seam is implemented locally in `electron/main.cts` with mode and
filesystem decisions in `electron/startup.cjs`. Packaged smoke mode requires
`--smoke-test`, `MORROW_HIDDEN=1`, and an existing absolute
`MORROW_USER_DATA=<os.tmpdir>/morrow-smoke-<id>/profile`. It checks the temporary
directory, dedicated root, profile and existing session directory with `lstat`
and `realpath` before creating directories, setting Electron paths, registering
the protocol, or acquiring the single-instance lock. Invalid input exits before
those effects. Packaged smoke mode is hidden, skips the normal second-instance
focus handler, and does not register or unregister the global capture shortcut.

The focused unit suite `npm test -- electron/startup.test.ts` passed 17 tests;
`npx tsc -p tsconfig.electron.json --noEmit` passed. Sol independently reviewed
the source seam with no blockers. These checks cover source logic only; no
packaged executable was launched or built.

The future Windows release gate has a prepared harness at
`scripts/verify-packaged-smoke.cjs`. It accepts only the real
`win-unpacked/Morrow.exe`, an expected version, and an optional evidence
subdirectory under `docs/evidence/stabilization-1.1.1/`. It creates its own
`morrow-smoke-*` profile and synthetic vault, launches twice with the explicit
smoke switch and isolated environment, checks packaged status/version/effective
paths/hidden windows, edits and reopens a synthetic note with disk assertions,
then closes only its app instances and removes only its validated temp root.
The harness has not been run; issue #49 still owns the build and packaged
execution, with release evidence recorded under the parameterized evidence
directory.

Example for the later release-gate run:

```powershell
node scripts/verify-packaged-smoke.cjs "C:\path\to\win-unpacked\Morrow.exe" "<expected-version>" --evidence-dir "packaged-smoke\<run-id>"
```
