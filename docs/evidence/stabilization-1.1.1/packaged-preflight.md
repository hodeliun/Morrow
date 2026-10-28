# Artifact preflight: source verification for gate #49

An old packaged application ignores the development-only hidden/profile flags. A version check after launch would be too late to protect the personal profile, so the packaged smoke harness now inspects the candidate before loading Playwright, creating a fixture or starting an executable.

The preflight checks regular files and resolved containment, reads archive metadata without executing archive code, verifies the expected package version and entry point, and compares the archived main bundle with the trusted current compiled bundle and its smoke-guard markers. It records executable/archive/main SHA-256 values and rechecks the artifact before each launch. Missing, old, malformed, redirected or mismatched artifacts fail without falling back to normal startup.

Ten pure Node tests passed, with syntax/lint/diff checks. Independent Sol review found a false-positive mechanism in the first negative tests: a null expected snapshot could reject even an improperly accepted artifact. The corrected tests require the specific preflight rejection directly and separately verify zero Electron launches. A same-size mutation reaches the hash comparison. The final code, tests and harness were approved; CI includes these tests on Windows and Ubuntu.

**This checkpoint does not claim an actual packaged executable run.** That proof remains a release gate after the final build. No installer wizard, portable launcher or personal installation was opened for these tests.

A later final rerun caught a fixture race: the ASAR creation Promise resolved with a writable stream before its finish event. The tests now await `finished(stream)` before inspection. The failing 8/10 run was preserved locally; three concurrent worker runs and a fresh orchestrator run passed 10/10. Negative tests still require their specific rejection reason and zero launches. This was a test-fixture write-completion issue, not a relaxed artifact check.
