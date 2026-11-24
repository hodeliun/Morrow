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
const usage =
  'Usage: node scripts/pilot/create-polaris-dados-fixture.mjs [--checkbox-demo] [--documento-demo] [--arquivos-demo] <new-or-empty-origin-vault> [new-or-empty-destination-vault]\n';
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage);
  process.exit(0);
}
const options = new Set();
const supportedOptions = new Set(['--checkbox-demo', '--documento-demo', '--arquivos-demo']);
while (args[0]?.startsWith('--')) {
  const option = args.shift();
  if (!supportedOptions.has(option)) {
    throw new Error(`Unknown fixture option: ${option}`);
  }
  if (options.has(option)) throw new Error(`Fixture option was supplied more than once: ${option}`);
  options.add(option);
}
const includeCheckboxDemo = options.has('--checkbox-demo');
const includeDocumentoDemo = options.has('--documento-demo');
const includeArquivosDemo = options.has('--arquivos-demo');

if (args.length < 1 || args.length > 2) {
  process.stderr.write(usage);
  process.exit(2);
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
if (includeDocumentoDemo) {
  const documentoSource = resolve(repositoryRoot, 'plugins/polaris-documento');
  sourceFiles.documento = {
    bundle: await readFile(resolve(repositoryRoot, 'dist/polaris-documento/main.js')),
    manifest: await readFile(resolve(documentoSource, 'manifest.json')),
    readme: await readFile(resolve(documentoSource, 'README.md')),
  };
  if (sourceFiles.documento.bundle.length === 0) {
    throw new Error('The Documento plugin bundle is empty. Run npm run build:polaris-documento first.');
  }
  const documentoManifest = JSON.parse(sourceFiles.documento.manifest.toString('utf8'));
  if (documentoManifest.id !== 'polaris-documento') {
    throw new Error('The Documento plugin manifest id must be polaris-documento.');
  }
}
if (includeArquivosDemo) {
  const arquivosSource = resolve(repositoryRoot, 'plugins/polaris-arquivos');
  sourceFiles.arquivos = {
    'main.js': await readFile(resolve(repositoryRoot, 'dist/polaris-arquivos/main.js')),
    'manifest.json': await readFile(resolve(arquivosSource, 'manifest.json')),
    'README.md': await readFile(resolve(arquivosSource, 'README.md')),
    LICENSE: sourceFiles.license,
  };
  if (!sourceFiles.arquivos['main.js'].length) {
    throw new Error('The Arquivos plugin bundle is empty. Run npm run build:polaris-arquivos first.');
  }
  if (JSON.parse(sourceFiles.arquivos['manifest.json'].toString('utf8')).id !== 'polaris-arquivos') {
    throw new Error('The Arquivos plugin manifest id must be polaris-arquivos.');
  }
}

const targetStates = await Promise.all(targets.map(inspectTarget));
const firstId = process.hrtime.bigint();
let idSequence = 0n;
const now = Date.now();
const allocateId = (kind) => `${kind}-${firstId + idSequence++}`;
const destinations = [];
const pagesPerVault = 3 + (includeCheckboxDemo ? 5 : 0) + (includeDocumentoDemo ? 5 : 0);
for (let index = 0; index < targets.length; index += 1) {
  const marker = index === 0 ? 'OPEN-OLD' : 'OPEN-DESTINATION';
  destinations.push(
    await createVault(
      targets[index],
      targetStates[index],
      marker,
      index,
      allocateId,
      now + index * pagesPerVault,
      sourceFiles,
      { includeCheckboxDemo, includeDocumentoDemo },
    ),
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      idSeed: firstId.toString(),
      options: {
        checkboxDemo: includeCheckboxDemo,
        documentoDemo: includeDocumentoDemo,
        ...(includeArquivosDemo ? { arquivosDemo: true } : {}),
      },
      vaults: destinations,
    },
    null,
    2,
  )}\n`,
);

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

async function createVault(target, targetState, openMarker, vaultIndex, allocateId, createdAt, files, options) {
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
  const checkboxFiles = options.includeCheckboxDemo
    ? await createCheckboxDemo(target, workspace.pages, allocateId, createdAt + 3)
    : [];
  const documentoDemo = options.includeDocumentoDemo
    ? await createDocumentoDemo(
        target,
        workspace.pages,
        allocateId,
        createdAt + 3 + checkboxFiles.length,
        3 + checkboxFiles.length,
        files.documento,
      )
    : null;
  await writeExclusive(resolve(target, '.morrow/workspace.json'), `${JSON.stringify(workspace, null, 1)}\n`);
  const enabledPlugins = ['polaris-dados'];
  if (options.includeDocumentoDemo) enabledPlugins.push('polaris-documento');
  const arquivosFiles = files.arquivos ? await createArquivosDemo(target, files.arquivos, openMarker) : [];
  if (arquivosFiles.length) enabledPlugins.push('polaris-arquivos');
  await writeExclusive(resolve(target, '.morrow/plugins.json'), `${JSON.stringify({ enabled: enabledPlugins }, null, 2)}\n`);
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
    ...(documentoDemo ? { documentoDemo } : {}),
    files: [
      'Inventory.md',
      'Inventory/Widget.md',
      'Views.md',
      ...checkboxFiles,
      ...(documentoDemo?.files ?? []),
      ...arquivosFiles,
      '.morrow/workspace.json',
      '.morrow/plugins.json',
      '.morrow/plugins/polaris-dados/main.js',
      '.morrow/plugins/polaris-dados/manifest.json',
      '.morrow/plugins/polaris-dados/README.md',
      '.morrow/plugins/polaris-dados/LICENSE',
      ...(options.includeDocumentoDemo
        ? [
            '.morrow/plugins/polaris-documento/main.js',
            '.morrow/plugins/polaris-documento/manifest.json',
            '.morrow/plugins/polaris-documento/README.md',
            '.morrow/plugins/polaris-documento/LICENSE',
          ]
        : []),
    ],
  };
}

async function createArquivosDemo(target, pluginAssets, marker) {
  const pluginDirectory = '.morrow/plugins/polaris-arquivos';
  await mkdir(resolve(target, pluginDirectory));
  await mkdir(resolve(target, 'Material/Subpasta'), { recursive: true });
  const files = [
    ...Object.entries(pluginAssets).map(([name, bytes]) => [`${pluginDirectory}/${name}`, bytes]),
    ['Material/LEIAME', `Arquivo sintético do piloto. ${marker}\n`],
    ['Material/Inventario.txt', 'Material de demonstração\n'],
    ['Material/Subpasta/Planilha.csv', 'produto,quantidade\nExemplo,2\n'],
  ];
  for (const [path, content] of files) await writeExclusive(resolve(target, path), content);
  return files.map(([path]) => path);
}

async function createDocumentoDemo(target, pages, allocateId, createdAt, orderBase, documentoFiles) {
  const ids = {
    links: allocateId('polaris-note'),
    relations: allocateId('polaris-source'),
    relationRow: allocateId('polaris-row'),
    relationView: allocateId('polaris-table-view'),
    resolved: allocateId('polaris-note'),
    gone: allocateId('polaris-note'),
  };
  const pluginDirectory = resolve(target, '.morrow/plugins/polaris-documento');
  await mkdir(pluginDirectory);
  await mkdir(resolve(target, 'Relations'));
  await mkdir(resolve(target, '.trash'));

  const legacyFormula = encodeURIComponent(JSON.stringify({
    resultId: 'demo-legacy-result',
    pageId: ids.resolved,
    name: 'Legacy total',
    formula: '2 + 3',
    bindings: [],
    outputType: 'auto',
    format: {},
  }));
  const markdownFiles = [
    {
      path: 'Links.md',
      id: ids.links,
      order: orderBase,
      text: [
        '# Link states',
        '',
        'Resolved: [[Resolved target|Resolved: live]]',
        '',
        'Missing: [[Gone target|Missing: gone]]',
        '',
        'Unresolved: [[Never existed|Unresolved: unknown]]',
        '',
        'External: [External documentation](https://example.com/docs)',
        '',
        '<!-- morrow:block-background:#a1b2c3 -->',
        'Legacy HEX background.',
        '',
        'Plain neighbor.',
        '',
        '- List item with native background <!-- background: yellow -->',
        '',
        '  <!-- morrow:block-background:#2f80ed -->',
        '',
        '  Legacy list paragraph.',
        '',
        '  - [x] Nested task',
        '',
        '    <!-- morrow:block-background:#2f80ed -->',
        '',
        '    Legacy task paragraph.',
        '',
        '- Section',
        '  - Nested section',
        '    - <!-- morrow:block-background:#3867b3 -->',
        '      Old nested list paragraph.',
        '',
        '1. ',
        '   <!-- morrow:block-background:#7c40ab -->',
        '',
        '   Legacy numbered paragraph.',
        '',
        '<details open>',
        '<summary data-block-background="#2f80ed"><h3>Legacy **collapsible** title</h3></summary>',
        '',
        'Collapse this paragraph with the arrow beside its title.',
        '',
        '</details>',
        '',
      ].join('\n'),
    },
    {
      path: 'Relations.md',
      id: ids.relations,
      order: orderBase + 1,
      text: [
        '---',
        'kind: database',
        'database:',
        '  properties:',
        '    - id: related',
        '      name: Related',
        '      type: relation',
        '      options: []',
        '  views:',
        `    - id: ${ids.relationView}`,
        '      name: Table',
        '      type: table',
        '      filters: []',
        '      sorts: []',
        '      groupBy: null',
        '      dateProp: null',
        '      hidden: []',
        '---',
        '# Relations',
        '',
      ].join('\n'),
    },
    {
      path: 'Relations/Relation sample.md',
      id: ids.relationRow,
      order: 0,
      text: [
        '---',
        'Related:',
        '  - "[[Resolved target]]"',
        '  - "[[Gone target]]"',
        '---',
        'Synthetic relation row for the Documento visual demo.',
        '',
      ].join('\n'),
    },
    {
      path: 'Resolved target.md',
      id: ids.resolved,
      order: orderBase + 2,
      text: [
        '# Resolved target',
        '',
        'Synthetic target for the Documento visual demo.',
        '',
        'Saved formula: <span data-morrow-result="' + legacyFormula + '">Legacy total</span>.',
        '',
        'Editable neighbor.',
        '',
      ].join('\n'),
    },
    {
      path: '.trash/Gone target.md',
      id: ids.gone,
      order: orderBase + 3,
      trashed: createdAt + 4,
      text: '# Gone target\n\nSynthetic trashed target for the Documento visual demo.\n',
    },
  ];
  for (const [index, file] of markdownFiles.entries()) {
    await writeExclusive(resolve(target, file.path), file.text);
    pages[file.path] = {
      id: file.id,
      created: createdAt + index,
      order: file.order,
      ...(file.trashed ? { trashed: file.trashed } : {}),
    };
  }

  await writeExclusive(resolve(pluginDirectory, 'main.js'), documentoFiles.bundle);
  await writeExclusive(resolve(pluginDirectory, 'manifest.json'), documentoFiles.manifest);
  await writeExclusive(resolve(pluginDirectory, 'README.md'), documentoFiles.readme);
  await writeExclusive(
    resolve(pluginDirectory, 'LICENSE'),
    await readFile(resolve(repositoryRoot, 'LICENSE')),
  );

  return {
    ids,
    files: markdownFiles.map((file) => file.path),
    bundleSha256: createHashFor(documentoFiles.bundle),
  };
}

async function createCheckboxDemo(target, pages, allocateId, createdAt) {
  const sourceId = allocateId('polaris-source');
  const viewId = allocateId('polaris-table-view');
  const bank = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: sample
      name: Sample
      type: text
    - id: reviewed
      name: Reviewed
      type: checkbox
  views:
    - id: ${viewId}
      name: Table
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Checklist
`;
  const views = ['Review queue', 'Review summary'].map((title) => encodeViewMarker({
    viewId: allocateId('polaris-linked-view'),
    sourceDatabaseId: sourceId,
    title,
    columnOrder: ['reviewed'],
    filter: null,
  }));
  const note = ['# Checklist Views', '', ...views.flatMap((view) => [view, ''])].join('\n');
  const files = [
    { path: 'Checklist.md', id: sourceId, order: 2, text: bank },
    { path: 'Checklist/Unchecked.md', id: allocateId('polaris-row'), order: 0, text: '---\nSample: Unchecked\nReviewed: false\n---\nStarts unchecked.\n' },
    { path: 'Checklist/Null.md', id: allocateId('polaris-row'), order: 1, text: '---\nSample: "Null"\nReviewed: null\n---\nStarts with an explicit null.\n' },
    { path: 'Checklist/Missing.md', id: allocateId('polaris-row'), order: 2, text: '---\nSample: Missing\n---\nStarts without a Reviewed property.\n' },
    { path: 'Checklist Views.md', id: allocateId('polaris-note'), order: 3, text: note },
  ];
  await mkdir(resolve(target, 'Checklist'));
  for (const [index, file] of files.entries()) {
    await writeExclusive(resolve(target, file.path), file.text);
    pages[file.path] = { id: file.id, created: createdAt + index, order: file.order };
  }
  return files.map((file) => file.path);
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
