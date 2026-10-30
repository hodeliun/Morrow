# Release policy

Every release must describe the usable product shipped to users, with two distinct sections:

1. **Official Morrow base:** exact base version and commit, with a link to the upstream release or comparison. Attribute upstream changes to upstream; do not claim a new upstream update when the base did not change.
2. **Fork improvements and fixes:** concrete user-visible changes since the **last published downloadable release**, including previously unreleased internal versions. Explain what changed, how to use material features, and relevant limitations. Internal commit titles alone are not release notes.

## Feature-level descriptions and cumulative fork overview

Release notes must explain individual usable capabilities, not just delivery groups,
ticket numbers or broad labels such as “database improvements”. For each material
feature, describe:

- Its name, the problem it solves and the resulting behavior.
- Where to find it and the steps needed to use it.
- A concrete synthetic example; for formulas, include input and expected output.
- Available options and relevant limits, compatibility or migration considerations.
- A captioned screenshot, GIF or short video when appearance or interaction matters,
  following the visual-evidence rules below.

For fixes, describe the trigger, previous symptom and corrected result. Group related
minor fixes when readable, but do not hide meaningful behavior behind generic summaries.
Use the official Morrow release notes as a reference for descriptive depth, while
writing descriptions of the actual verified fork behavior.

The release following completion of **all Aumento de Escopo 2 delivery groups** must
also provide a cumulative guide to the fork's capabilities across the project to date.
This is additional to the changes since the previous downloadable release. Keep these
two clearly labeled so existing capabilities are not presented as newly added.
Organize the guide by user workflow (editing and appearance, tables and views,
column types and formatting, relations and formulas, navigation and files, and other
verified areas), rather than by development group. Include inherited features only
when needed to explain a workflow and attribute their origin.

Build the cumulative inventory from the historical fork changelog, specifications,
closed tickets, reviewed code and current UI verification. Record each capability's
origin (official base, fork addition or fork enhancement), first known fork version
when verifiable, current availability, demonstration and evidence reference. Distinguish
implemented and verified behavior from planned, partially implemented or unavailable
behavior. Do not infer completion from a ticket title, commit or old release claim.
Explicitly identify relevant features that remain unchanged and any removed or
restricted behavior, without copying the entire official changelog into each release.

Keep the inventory and illustrated guide under `docs/releases/<fork-version>/`, with
links from the GitHub release. The release body itself must contain substantive
feature descriptions and representative visuals; it must not be only a list of links.
Use progressive sections and an index when long. Review the rendered GitHub notes,
media links and consistency with the final packaged application before publication.
Preparing this documentation does not authorize a release or imply that unfinished
groups have shipped. Interim releases still describe their actual delivered scope.

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
- Verify the feature-level descriptions and cumulative inventory required above;
  every advertised capability must be supported by the final release, with genuine
  demonstrations and clear attribution. The Scope 2 consolidated guide is mandatory
  for the release following completion of all its delivery groups.

## Release notes outline

```
Official base: version, commit, upstream notes link; changed or unchanged.
Fork: version and comparison with the last downloadable release.
New features: concrete behavior, entry point/how to use, visual demonstration.
Feature details: options, synthetic example, expected result and relevant limits.
Fork overview: cumulative capabilities, origins and verified availability; required
  after all Scope 2 groups, clearly separate from new changes in this release.
Corrections: user-visible trigger and resulting corrected behavior.
Downloads: platform, installer/portable, checksums and signing status.
Validation: tests, actual UI and packaged smoke coverage.
Known limitations: relevant unfinished or constrained behavior.
```

This policy applies to future releases as well as the stabilization release 1.1.1.
