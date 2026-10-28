# Release policy

Every release must describe the usable product shipped to users, with two distinct sections:

1. **Official Morrow base:** exact base version and commit, with a link to the upstream release or comparison. Attribute upstream changes to upstream; do not claim a new upstream update when the base did not change.
2. **Fork improvements and fixes:** concrete user-visible changes since the **last published downloadable release**, including previously unreleased internal versions. Explain what changed, how to use material features, and relevant limitations. Internal commit titles alone are not release notes.

## Visual demonstrations

For material interface changes, include genuine screenshots and, where interaction matters, short GIFs or videos demonstrating the feature in the actual application. Use synthetic data and isolated profiles only. Do not publish personal vaults, screenshots, attachments or account information.

Keep compact media under `docs/releases/<fork-version>/assets/` or as release assets. Record the tested version/build and reproducible scenario. Include captions or alt text and a textual explanation so the notes remain useful without media. State when a GIF uses captured interaction states rather than a continuous recording. Link media using the immutable release tag or release asset URL. Do not use mockups or generated images as evidence of implemented behavior.

## Publication gate

- Follow the coherent-delivery groups in `COMMIT-POLICY.md`; consolidate unpublished development fixes into their functional delivery.
- Track official base version/commit separately from fork version. Update the package metadata, fork changelog and release notes consistently.
- Verify acceptance criteria against the final source and actual UI. Run the repository check, relevant regression tests, independent review and CI. Preserve failures and limitations honestly.
- Build installers and portable artifacts from the reviewed release commit. Smoke-test the packaged application with a synthetic vault and isolated profile. Never replace or launch the user's personal installation as a release test.
- Report exactly which platforms and artifacts were built and tested. Testing an unpacked application is not evidence of completing an installer wizard. Report signing status accurately.
- Publish SHA-256 checksums, downloadable artifact names, validation scope and known limitations. Verify uploaded assets, tag target and published release state.
- Do not move existing tags, rewrite published history, or describe outstanding acceptance work as completed.

## Release notes outline

```
Official base: version, commit, upstream notes link; changed or unchanged.
Fork: version and comparison with the last downloadable release.
New features: concrete behavior, entry point/how to use, visual demonstration.
Corrections: user-visible trigger and resulting corrected behavior.
Downloads: platform, installer/portable, checksums and signing status.
Validation: tests, actual UI and packaged smoke coverage.
Known limitations: relevant unfinished or constrained behavior.
```

This policy applies to future releases as well as the stabilization release 1.1.1.
