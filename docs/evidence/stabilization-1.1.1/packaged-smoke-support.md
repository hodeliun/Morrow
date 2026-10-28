# Packaged smoke support: source verification

Issue: https://github.com/hodeliun/Morrow/issues/50

The installed application previously ignored the development-only hidden/profile environment flags. Testing its executable that way could use the personal profile and show or focus a window. The new startup seam requires an explicit smoke flag, hidden opt-in and a dedicated absolute temporary profile. Invalid combinations or filesystem redirection fail before startup side effects; normal startup and development behavior remain supported. Smoke mode skips global capture shortcuts and second-instance focus behavior.

Source verification passed 17 focused startup tests, Electron typecheck, focused lint and diff checks. The tests cover normal/development/smoke decisions, incomplete combinations, containment, symlinks/junctions and failure before writes or Electron path setup. Independent Sol review approved both the startup implementation and the preparatory harness without blockers.

The harness accepts an explicit unpacked executable, confirms packaged status, effective paths, version and hidden windows, edits through the UI, checks the saved file and reopens the app. It cleans up only its own validated temporary root. Syntax and lint passed; **the packaged harness has not yet been executed** at this checkpoint. Actual packaged smoke, final source identity and distributable verification remain requirements of issue #49. This is not evidence of installer wizard execution or replacement of the user's installation.
