#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const pluginSource = resolve(repositoryRoot, 'plugins/polaris-dados');
const bundleSource = resolve(repositoryRoot, 'dist/polaris-dados/main.js');
const args = process.argv.slice(2);

if (args.length < 1 || args.length > 2 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: node scripts/pilot/create-polaris-dados-fixture.mjs <new-or-empty-origin-vault> [new-or-empty-destination-vault]\n');
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2);
}

const targets = args.map((item) => resolve(item));
if (new Set(targets).size !== targets.length) throw new Error('Synthetic vault destinations must be distinct.');
for (const target of targets) {
  if (isWithin(repositoryRoot, target) || isWithin(target, repositoryRoot)) {
    throw new Error('Choose synthetic vault paths outside the Morrow checkout.');
  }
}

const sourceFiles = {
  bundle: await readFile(bundleSource),
  manifest: await readFile(resolve(pluginSource, 'manifest.json')),
  readme: await readFile(resolve(pluginSource, 'README.md')),
  license: await readFile(resolve(repositoryRoot, 'LICENSE')),
  inventory: await readFile(resolve(pluginSource, 'fixture/Inventory.md'), 'utf8'),
  widget: await readFile(resolve(pluginSource, 'fixture/Inventory/Widget.md'), 'utf8'),
};
if (sourceFiles.bundle.length === 0) throw new Error('The plugin bundle is empty. Run npm run build:polaris-dados first.');
const manifest = JSON.parse(sourceFiles.manifest.toString('utf8'));
if (manifest.id !== 'polaris-dados') throw new Error('The plugin manifest id must be polaris-dados.');

const targetStates = await Promise.all(targets.map(inspectTarget));
const firstId = process.hrtime.bigint();
let idSequence = 0n;
const now = Date.now();
const allocateId = (kind) => `${kind}-${firstId + idSequence++}`;
const destinations = [];
for (let index = 0; index < targets.length; index += 1) {
  const marker = index === 0 ? 'OPEN-OLD' : 'OPEN-DESTINATION';
  destinations.push(await createVault(targets[index], targetStates[index], marker, index, allocateId, now + index * 3, sourceFiles));
}

process.stdout.write(`${JSON.stringify({
  createdAt: new Date().toISOString(),
  idSeed: firstId.toString(),
  vaults: destinations,
}, null, 2)}\n`);

async function inspectTarget(target) {
  let exists = false;
  try {
    const info = await lstat(target);
    exists = true;
    if (info.isSymbolicLink()) throw new Error('Use a real directory, not a symbolic link, for a synthetic vault.');
    if (!info.isDirectory()) throw new Error('The fixture destination exists and is not a directory.');
    if ((await readdir(target)).length > 0) throw new Error('The fixture destination is not empty; refusing to overwrite it.');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return { exists };
}

async function createVault(target, targetState, openMarker, vaultIndex, allocateId, createdAt, files) {
  if (!targetState.exists) await mkdir(target, { recursive: false });
  const sourceId = allocateId('polaris-source');
  const rowId = allocateId('polaris-row');
  const noteId = allocateId('polaris-note');
  const sourceViewId = allocateId('polaris-table-view');
  const firstLinkedViewId = allocateId('polaris-linked-view');
  const secondLinkedViewId = allocateId('polaris-linked-view');
  const profileMarker = vaultIndex === 0 ? 'Origin' : 'Destination';
  const pluginDirectory = resolve(target, '.morrow/plugins/polaris-dados');
  const bankDirectory = resolve(target, 'Inventory');
  await mkdir(bankDirectory, { recursive: true });
  await mkdir(pluginDirectory, { recursive: true });

  const inventory = files.inventory.replace('id: inventory-table-v1', `id: ${sourceViewId}`);
  const row = files.widget
    .replace('Name: Widget', `Name: ${vaultIndex === 0 ? 'Widget' : 'Destination Widget'}`)
    .replace('Quantity: 2', `Quantity: ${vaultIndex === 0 ? '2' : '5'}`);
  const linkedViews = [
    {
      version: 1,
      viewId: firstLinkedViewId,
      sourceDatabaseId: sourceId,
      title: `${profileMarker} primary stock`,
      columnOrder: ['price', 'quantity'],
      filter: { propertyId: 'quantity', op: 'gte', value: 1 },
    },
    {
      version: 1,
      viewId: secondLinkedViewId,
      sourceDatabaseId: sourceId,
      title: `${profileMarker} low stock`,
      columnOrder: ['name'],
      filter: { propertyId: 'quantity', op: 'gte', value: vaultIndex === 0 ? 3 : 6 },
    },
  ];
  const note = [
    `# ${profileMarker} Views`,
    '',
    `Synthetic vault marker: ${openMarker}`,
    'The two linked views below share Inventory.md and keep independent configuration.',
    '',
    encodeViewMarker(linkedViews[0]),
    '',
    `View boundary ${profileMarker}-BETWEEN`,
    '',
    encodeViewMarker(linkedViews[1]),
    '',
  ].join('\n');
  const workspace = {
    version: 1,
    pages: {
      'Inventory.md': { id: sourceId, created: createdAt, order: 0 },
      'Inventory/Widget.md': { id: rowId, created: createdAt + 1, order: 0 },
      'Views.md': { id: noteId, created: createdAt + 2, order: 1 },
    },
  };
  await writeExclusive(resolve(target, 'Inventory.md'), inventory);
  await writeExclusive(resolve(target, 'Inventory/Widget.md'), row);
  await writeExclusive(resolve(target, 'Views.md'), note);
  await writeExclusive(resolve(target, '.morrow/workspace.json'), `${JSON.stringify(workspace, null, 1)}\n`);
  await writeExclusive(resolve(target, '.morrow/plugins.json'), `${JSON.stringify({ enabled: ['polaris-dados'] }, null, 2)}\n`);
  await writeExclusive(resolve(pluginDirectory, 'main.js'), files.bundle);
  await writeExclusive(resolve(pluginDirectory, 'manifest.json'), files.manifest);
  await writeExclusive(resolve(pluginDirectory, 'README.md'), files.readme);
  await writeExclusive(resolve(pluginDirectory, 'LICENSE'), files.license);

  return {
    path: target,
    marker: openMarker,
    sourceDatabaseId: sourceId,
    rowId,
    noteId,
    sourceViewId,
    linkedViewIds: linkedViews.map((view) => view.viewId),
    linkedViewTitles: linkedViews.map((view) => view.title),
    bundleSha256: createHashFor(files.bundle),
    files: [
      'Inventory.md',
      'Inventory/Widget.md',
      'Views.md',
      '.morrow/workspace.json',
      '.morrow/plugins.json',
      '.morrow/plugins/polaris-dados/main.js',
      '.morrow/plugins/polaris-dados/manifest.json',
      '.morrow/plugins/polaris-dados/README.md',
      '.morrow/plugins/polaris-dados/LICENSE',
    ],
  };
}

function encodeViewMarker(value) {
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    viewId: value.viewId,
    sourceDatabaseId: value.sourceDatabaseId,
    title: value.title,
    columnOrder: [...value.columnOrder],
    filter: value.filter === null ? null : { ...value.filter },
  }), 'utf8');
  if (bytes.length > 64 * 1024) throw new Error('Linked view fixture exceeds the canonical 64 KiB payload limit.');
  return `<!-- morrow:polaris-dados-view:v1:${bytes.toString('base64url')} -->`;
}

async function writeExclusive(filePath, contents) {
  await writeFile(filePath, contents, { flag: 'wx' });
}

function createHashFor(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}
