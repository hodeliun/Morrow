'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runGroup } = require('./verify-prior-deliveries-ui.cjs');
const { projectRelative, runPath } = require('./stabilization-1.1.1-audit-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const group = process.argv[2];
if (!['delivery1', 'delivery2', 'delivery3'].includes(group)) {
  throw new Error('Choose delivery1, delivery2, or delivery3.');
}

function sanitize(value, key = '') {
  if (typeof value === 'string') {
    if (/path|root|directory/i.test(key) && path.isAbsolute(value)) return path.basename(value);
    return value.replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>|]+/g, '[local path omitted]');
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }
  return value;
}

async function main() {
  const startedAt = new Date().toISOString();
  const evidence = await runGroup(group);
  const safeEvidence = sanitize(evidence);
  const outputPath = runPath(`audit/${group}-ui.json`, path.join(projectRoot, 'docs', 'evidence', `${group}-ui.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    audit: 'Gate #49 UI verification of prior delivery behavior',
    startedAt,
    finishedAt: new Date().toISOString(),
    projectHead: evidence.projectHead,
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    group,
    outcome: evidence.overall,
    hiddenWindows: evidence.allWindowsStayedHidden,
    pageErrorCount: evidence.pageErrors?.length ?? 0,
    compiledBuildStable: evidence.compiledBuildStableAcrossLaunches,
    compiledArtifactStable: evidence.compiledArtifactStableAcrossLaunches,
    buildFingerprint: evidence.buildFingerprint,
    evidence: safeEvidence,
  }, null, 2)}\n`, 'utf8');
  console.log(`Sanitized evidence: ${projectRelative(outputPath)}`);
  console.log(`Result ${group}: ${evidence.overall}; hidden=${evidence.allWindowsStayedHidden}; pageErrors=${evidence.pageErrors?.length ?? 0}`);
  if (evidence.overall !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
