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
