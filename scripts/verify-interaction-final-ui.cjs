const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const projectRoot = path.resolve(__dirname, '..');
const evidencePath = path.join(projectRoot, 'docs', 'evidence', 'interaction-expansion-final-ui.json');
const rowCount = 1000;
const workspacePython = 'C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const popplerBin = 'C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin';
const pdfPreviewRelativePath = 'docs/evidence/interaction-expansion-final-page1.png';

function sanitizeDiagnostic(value) {
  const rootPrefix = `${projectRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/`.toLocaleLowerCase();
  return value
    .replace(/[A-Z]:\\[^\r\n)]*/g, (absolutePath) => {
      const normalized = absolutePath.replaceAll('\\', '/');
      const index = normalized.toLocaleLowerCase().indexOf(rootPrefix);
      return index >= 0 ? normalized.slice(index + rootPrefix.length) : '[local path]';
    })
    .replace(/morrow-(?:interaction-final-ui|delivery\d-ui)-[^\\/\s]*/g, '[synthetic-temp]');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walkFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? walkFiles(absolute, relative) : [absolute];
  });
}

function contentFingerprint(files, root) {
  const parts = files
    .map((file) => `${path.relative(root, file).replaceAll(path.sep, '/')}:${sha256(fs.readFileSync(file))}`)
    .sort();
  return { files: parts.length, sha256: sha256(Buffer.from(parts.join('\n'), 'utf8')) };
}

function sourceFingerprint() {
  const sourceFiles = ['src', 'electron', 'scripts']
    .flatMap((directory) => walkFiles(path.join(projectRoot, directory)));
  for (const name of [
    'package.json',
    'package-lock.json',
    'index.html',
    'vite.config.ts',
    'vite.electron.config.ts',
    'vite.config.mcp.ts',
    'tsconfig.json',
    'tsconfig.electron.json',
  ]) sourceFiles.push(path.join(projectRoot, name));
  return contentFingerprint(sourceFiles, projectRoot);
}

function bundleFingerprint() {
  const builtFiles = ['dist', 'dist-electron', 'dist-mcp']
    .flatMap((directory) => walkFiles(path.join(projectRoot, directory)));
  builtFiles.push(path.join(projectRoot, 'package.json'));
  return contentFingerprint(builtFiles, projectRoot);
}

function gitRevision() {
  return require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
}

function parsePriorEvidence(output) {
  const evidenceLine = output.split(/\r?\n/).find((line) => line.startsWith('Evidence JSON:'));
  if (!evidenceLine) return null;
  const file = evidenceLine.slice('Evidence JSON:'.length).trim();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function runChild(label, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', script)], {
      cwd: projectRoot,
      windowsHide: true,
      env: { ...process.env, MORROW_HIDDEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxOutput = 4 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < maxOutput) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < maxOutput) stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ label, code, signal, stdout, stderr }));
  });
}

function groupEvidence(label, childResult, stableBundle, startedAt) {
  let evidence = null;
  let report = null;
  if (label.startsWith('delivery') && Number(label.slice(-1)) <= 3) {
    evidence = parsePriorEvidence(childResult.stdout);
    report = evidence ? `temporary-evidence:${evidence.group ?? label}` : 'temporary-evidence-unavailable';
  } else {
    const file = path.join(projectRoot, 'docs', 'evidence', `interaction-expansion-${label}-ui.json`);
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= startedAt) {
      evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
      report = path.relative(projectRoot, file).replaceAll(path.sep, '/');
    }
  }

  const zeroPageErrors = label === 'delivery4'
    ? evidence?.rendererPageErrorsVerified === true
    : label === 'delivery5'
      ? Array.isArray(evidence?.rendererPageErrors) && evidence.rendererPageErrors.length === 0
      : Array.isArray(evidence?.pageErrors) && evidence.pageErrors.length === 0;
  const isPriorGroup = Number(label.slice(-1)) <= 3;
  const childPassed = childResult.code === 0 && (isPriorGroup
    ? Boolean(evidence && evidence.overall === 'passed')
    : Boolean(evidence && evidence.hiddenWindowVerified && evidence.cleanupVerified && zeroPageErrors));
  const failures = label.startsWith('delivery') && Number(label.slice(-1)) <= 3
    ? (evidence?.fatalFailures ?? []).length
    : childResult.code === 0 ? 0 : 1;

  return {
    group: label,
    script: `scripts/verify-${label}-ui.cjs`,
    result: childPassed && stableBundle ? 'passed' : 'failed',
    exitCode: childResult.code,
    processSignal: childResult.signal,
    hiddenWindowVerified: evidence?.allWindowsStayedHidden === true || evidence?.hiddenWindowVerified === true,
    zeroRendererPageErrors: zeroPageErrors,
    appCloseAttempted: isPriorGroup ? childPassed : evidence?.cleanupVerified === true ? true : null,
    appCloseVerified: isPriorGroup ? null : evidence?.cleanupVerified === true ? true : null,
    temporaryArtifactsRemoved: isPriorGroup ? false : evidence?.cleanupVerified === true ? true : null,
    cleanupVerified: evidence?.cleanupVerified === true,
    syntheticFixturesRetained: isPriorGroup && Boolean(evidence?.overall === 'passed'),
    buildStableDuringGroup: stableBundle,
    failureCount: failures,
    evidence: report,
    tickets: isPriorGroup
      ? Object.entries(evidence?.tickets ?? {}).map(([ticket, result]) => ({
          ticket,
          status: result.status ?? 'unknown',
          assertions: Object.entries(result.checks ?? {}).filter(([, value]) => typeof value === 'boolean'),
        }))
      : Object.entries(evidence ?? {})
          .filter(([key, value]) => /^ticket\d+$/.test(key) && value && typeof value === 'object')
          .map(([ticket, result]) => ({
            ticket: `#${ticket.slice('ticket'.length)}`,
            assertions: Object.entries(result).filter(([, value]) => typeof value === 'boolean'),
          })),
  };
}

async function runExistingGroups(initialBundle) {
  const groups = [
    ['delivery1', 'verify-delivery1-ui.cjs'],
    ['delivery2', 'verify-delivery2-ui.cjs'],
    ['delivery3', 'verify-delivery3-ui.cjs'],
    ['delivery4', 'verify-delivery4-ui.cjs'],
    ['delivery5', 'verify-delivery5-ui.cjs'],
  ];
  const results = [];
  for (const [label, script] of groups) {
    const startedAt = Date.now();
    const before = bundleFingerprint();
    console.log(`START ${label}: ${script}`);
    const start = performance.now();
    const child = await runChild(label, script);
    const durationMs = Math.round(performance.now() - start);
    const after = bundleFingerprint();
    const stableBundle = before.sha256 === after.sha256 && after.sha256 === initialBundle.sha256;
    const result = groupEvidence(label, child, stableBundle, startedAt);
    result.durationMs = durationMs;
    if (result.result !== 'passed') {
      const sanitizeTail = (value) => sanitizeDiagnostic(value.trim().split(/\r?\n/).slice(-8).join('\n')).slice(0, 1200);
      result.stderrTail = child.stderr.trim() ? sanitizeTail(child.stderr) : '';
      result.stdoutTail = child.stdout.trim() ? sanitizeTail(child.stdout) : '';
      result.diagnosticTail = result.stderrTail || result.stdoutTail || 'The child process produced no captured output.';
    }
    results.push(result);
    console.log(`DONE ${label}: ${result.result}, ${durationMs} ms, exit ${child.code}`);
  }
  return results;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function syntheticPng(width, height, color) {
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 3 + 1);
    pixels[offset] = 0;
    for (let x = 0; x < width; x++) {
      pixels[offset + 1 + x * 3] = color[0];
      pixels[offset + 2 + x * 3] = color[1];
      pixels[offset + 3 + x * 3] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', require('node:zlib').deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function linkedViewMarker(blockId, viewId, name) {
  const view = {
    id: viewId,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    widths: { title: 190, amount: 130, category: 130 },
    summaries: {},
  };
  const payload = encodeURIComponent(JSON.stringify({ sourceDatabaseId: 'finance-db', blockId, view }));
  return `<!-- morrow:linked-view:v1:${payload} -->\n\n**Linked database view:** [[Financeiro]] — synthetic view.`;
}

function writeFixture(root) {
  const profileDir = path.join(root, 'profile');
  const vaultDir = path.join(root, 'vault');
  const financeDir = path.join(vaultDir, 'Financeiro');
  const scaleDir = path.join(vaultDir, 'Escala');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(financeDir, { recursive: true });
  fs.mkdirSync(scaleDir, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, '.morrow'), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'vaults.json'),
    JSON.stringify({ current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] }),
  );

  const ids = {
    'Interface.md': { id: 'interface-page' },
    'Financeiro.md': { id: 'finance-db' },
    'Financeiro/Alfa.md': { id: 'finance-alpha' },
    'Financeiro/Beta.md': { id: 'finance-beta' },
    'Financeiro/Gama.md': { id: 'finance-gamma' },
    'Escala.md': { id: 'scale-db' },
  };

  const columns = Array.from({ length: 7 }, (_, index) => `\n<div data-column>\n\nColuna sintética ${index + 1}.\n\n</div>`).join('');
  const interfaceMarkdown = `# Interface integrada\n\n## Seção recolhível\n\nConteúdo sintético desta seção.\n\n### Subseção interna\n\nTexto da subseção.\n\n## Seção seguinte\n\nEsta seção permanece visível.\n\nTexto de edição para desfazer.\n\n<div data-columns data-widths="14,14,14,14,14,15,15">${columns}\n</div>\n\n<!-- morrow:image align="center" caption="Legenda integrada sintética" crop="0.1,0.1,0.8,0.8" -->\n![Imagem integrada sintética](original.png)\n\n${linkedViewMarker('view-alpha-block', 'view-alpha', 'Visão inicial Alfa')}\n\n${linkedViewMarker('view-beta-block', 'view-beta', 'Visão inicial Beta')}\n`;
  fs.writeFileSync(path.join(vaultDir, 'Interface.md'), interfaceMarkdown, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'original.png'), syntheticPng(400, 200, [44, 113, 168]));

  fs.writeFileSync(path.join(vaultDir, 'Financeiro.md'), `---\nkind: database\ndatabase:\n  properties:\n    - id: amount\n      name: Valor\n      type: number\n    - id: category\n      name: Categoria\n      type: text\n  views:\n    - id: finance-main\n      name: Principal\n      type: table\n      filters: []\n      sorts: []\n      groupBy: null\n      dateProp: null\n      hidden: []\n---\n# Financeiro\n`, 'utf8');
  for (const [name, amount, category] of [['Alfa', 100, 'Infra'], ['Beta', 200, 'Dados'], ['Gama', 300, 'Infra']]) {
    fs.writeFileSync(path.join(financeDir, `${name}.md`), `---\nValor: ${amount}\nCategoria: ${category}\n---\n# ${name}\n`, 'utf8');
  }

  const scaleProperties = `    - id: amount\n      name: Quantidade\n      type: number`;
  fs.writeFileSync(path.join(vaultDir, 'Escala.md'), `---\nkind: database\ndatabase:\n  properties:\n${scaleProperties}\n  views:\n    - id: scale-main\n      name: Principal\n      type: table\n      filters: []\n      sorts: []\n      groupBy: null\n      dateProp: null\n      hidden: []\n---\n# Escala sintética\n`, 'utf8');

  const rows = [];
  for (let index = 1; index <= rowCount; index++) {
    const title = `Registro ${String(index).padStart(4, '0')}`;
    const relative = `Escala/${title}.md`;
    const id = `scale-row-${String(index).padStart(4, '0')}`;
    ids[relative] = { id };
    const file = path.join(scaleDir, `${title}.md`);
    fs.writeFileSync(file, `---\nQuantidade: 0\n---\n# ${title}\n`, 'utf8');
    rows.push({ title, file, id });
  }
  fs.writeFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), JSON.stringify({ pages: ids }, null, 2), 'utf8');
  return { profileDir, vaultDir, scaleDir, rows, interfaceMarkdown };
}

async function assertHidden(app) {
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length);
  assert.equal(visible, 0, 'Every Electron window must remain invisible with MORROW_HIDDEN=1.');
}

async function launchHidden(profileDir, pdfPath, pageErrors) {
  const app = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    // Passing the application directory makes Electron load its package.json and report the app version.
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      MORROW_HIDDEN: '1',
      MORROW_USER_DATA: profileDir,
      MORROW_TEST_PDF: pdfPath,
    },
  });
  await app.evaluate(({ dialog }, testPdfPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: testPdfPath });
  }, pdfPath);
  await assertHidden(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  const page = await app.firstWindow();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
  await page.waitForSelector('.tree-row, .link-row', { timeout: 30000 });
  return { app, page };
}

async function openPage(page, title) {
  const rows = page.locator('.tree-row, .link-row');
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    const label = (await row.innerText()).split(/\r?\n/)[0].trim();
    if (label === title) {
      await row.click();
      if (title === 'Escala') {
        await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1000, null, { timeout: 60000 });
      } else if (title === 'Interface') {
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('Seção recolhível') ?? false, null, { timeout: 30000 });
      } else {
        await page.waitForSelector('.db-table', { timeout: 30000 });
      }
      return;
    }
  }
  throw new Error(`Synthetic page “${title}” is missing from the visible navigation.`);
}

async function waitForMarkdown(vaultDir, relativePath, predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const file = path.join(vaultDir, relativePath);
    if (fs.existsSync(file)) {
      last = fs.readFileSync(file, 'utf8');
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Timed out waiting for saved ${description} in ${relativePath}.`);
}

function linkedViewPayloads(markdown) {
  return [...markdown.matchAll(/<!--\s*morrow:linked-view:v1:([^\s]+)\s*-->/g)].map((match) =>
    JSON.parse(decodeURIComponent(match[1])),
  );
}

async function verifyAboutVersions(page, observations) {
  await page.locator('.sidebar-footer .nav-item').last().click();
  const dialog = page.locator('.settings-dialog');
  await dialog.waitFor({ state: 'visible' });
  const locales = [
    { id: 'en', option: 'English', title: 'Settings', about: 'About', forkLabel: 'Fork changes' },
    { id: 'es', option: 'Español', title: 'Ajustes', about: 'Acerca de', forkLabel: 'Cambios del fork' },
    { id: 'pt', option: 'Português', title: 'Configurações', about: 'Sobre', forkLabel: 'Modificações do fork' },
  ];
  const versions = [];
  for (const locale of locales) {
    await dialog.locator('.settings-nav-item').first().click();
    await dialog.locator('.settings-page .select-button').first().click();
    await page.getByRole('option', { name: locale.option, exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector('.settings-nav-title')?.textContent?.trim() === expected, locale.title);
    await dialog.locator('.settings-nav-item').last().click();
    const aboutText = await dialog.locator('.settings-about').innerText();
    const aboutHeading = await dialog.locator('.settings-page-head h3').innerText();
    const rendererVersion = await page.evaluate(() => window.morrow?.version ?? null);
    const observed = { locale: locale.id, aboutHeading, aboutText: aboutText.replace(/\s+/g, ' ').trim(), rendererVersion };
    observations.push(observed);
    const diagnostic = `Observed About text: ${JSON.stringify(observed.aboutText)}; renderer bridge version: ${JSON.stringify(rendererVersion)}.`;
    assert.ok(aboutText.includes('1.2.1'), `${locale.id}: About must show base version 1.2.1. ${diagnostic}`);
    assert.ok(aboutText.includes('1.1.0'), `${locale.id}: About must show fork version 1.1.0. ${diagnostic}`);
    assert.ok(aboutText.includes('5e6392b'), `${locale.id}: About must show official base revision 5e6392b. ${diagnostic}`);
    assert.ok(aboutText.includes('1.2.1-fork.1.1.0'), `${locale.id}: About must show package version 1.2.1-fork.1.1.0. ${diagnostic}`);
    assert.ok(aboutText.includes(locale.forkLabel), `${locale.id}: fork-version label must be localized. ${diagnostic}`);
    assert.equal(aboutHeading, locale.about, `${locale.id}: About heading must be localized.`);
    versions.push({ ...observed, settingsTitle: locale.title });
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  return versions;
}

async function makeHeadingCollapsible(page) {
  const heading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
  await heading.scrollIntoViewIfNeeded();
  if (!(await heading.locator('button.heading-fold-btn').count())) {
    await heading.hover();
    await page.locator('.block-handle').click();
    const menu = page.locator('.menu[role="menu"]').last();
    await menu.waitFor({ state: 'visible' });
    const actions = menu.locator('[role="menuitem"]');
    let action = null;
    for (let index = 0; index < await actions.count(); index++) {
      const candidate = actions.nth(index);
      if (/make collapsible|tornar recolhível|hacer plegable/i.test(await candidate.innerText())) {
        action = candidate;
        break;
      }
    }
    assert.ok(action, 'The heading menu must offer its collapsible-section action.');
    await action.click();
  }
  const fold = heading.locator('button.heading-fold-btn');
  await fold.waitFor({ state: 'visible' });
  if (await fold.getAttribute('aria-expanded') !== 'false') await fold.click();
  await page.waitForFunction(() => document.querySelector('.heading-fold-btn')?.getAttribute('aria-expanded') === 'false');
  const hiddenContent = await page.locator('.is-collapsed-hidden').evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
  assert.ok(hiddenContent.some((text) => text.includes('Conteúdo sintético desta seção')));
  assert.ok(await page.locator('.ProseMirror h2').filter({ hasText: 'Seção seguinte' }).isVisible());
}

async function verifyIntegratedPage(page, vaultDir, { editViews }) {
  await openPage(page, 'Interface');
  const columns = page.locator('.ProseMirror .columns > .column');
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .columns > .column').length === 7);
  assert.equal(await columns.count(), 7, 'The integrated note must show seven content columns.');
  const image = page.locator('.ProseMirror img').first();
  await image.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const candidate = document.querySelector('.ProseMirror img');
    return candidate instanceof HTMLImageElement && candidate.complete && candidate.naturalWidth === 400;
  });
  const imageState = await image.evaluate((img) => ({
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    alt: img.getAttribute('alt'),
  }));
  assert.deepEqual(imageState, { complete: true, naturalWidth: 400, naturalHeight: 200, alt: 'Imagem integrada sintética' });
  const heading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
  if (editViews) {
    const paragraph = page.locator('.ProseMirror > p').filter({ hasText: 'Texto de edição para desfazer.' }).first();
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' transient');
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('transient') ?? false);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].some((item) => item.textContent === 'Texto de edição para desfazer.'));
    await makeHeadingCollapsible(page);

    const views = page.locator('.linked-database-view');
    assert.equal(await views.count(), 2, 'The integrated note must contain two linked views of one database.');
    const names = ['Visão independente Alfa', 'Visão independente Beta'];
    const terms = ['Alfa', 'Beta'];
    for (let index = 0; index < 2; index++) {
      const view = views.nth(index);
      const name = view.locator('input.linked-database-name');
      await name.fill(names[index]);
      await name.press('Enter');
      await view.locator('.db-search input').fill(terms[index]);
    }
    await page.waitForFunction(() => {
      const viewsInPage = [...document.querySelectorAll('.linked-database-view')];
      return viewsInPage.length === 2 && viewsInPage.every((view) => view.querySelectorAll('.db-table tbody tr').length === 1);
    });
    const rows = [];
    for (let index = 0; index < 2; index++) {
      const viewRows = await views.nth(index).locator('.db-table tbody tr').allInnerTexts();
      assert.equal(viewRows.length, 1);
      assert.ok(viewRows[0].includes(terms[index]), `Linked view ${index} must show only ${terms[index]}.`);
      rows.push(viewRows[0].trim());
    }
    const markdown = await waitForMarkdown(vaultDir, 'Interface.md', (text) => {
      const saved = linkedViewPayloads(text);
      return saved.length === 2 && saved.every((item, index) => item.view.name === names[index] && item.view.search === terms[index]);
    }, 'independent linked-view state');
    const savedViews = linkedViewPayloads(markdown).map((item) => ({ name: item.view.name, search: item.view.search }));
    return {
      columns: 7,
      image: imageState,
      sectionUndo: 'text edit was undone through the editor shortcut',
      collapsedHeading: true,
      linkedViews: savedViews,
      independentlyFilteredRows: rows,
      markdownPersisted: true,
    };
  }

  assert.equal(await columns.count(), 7);
  assert.equal(await heading.locator('button.heading-fold-btn').getAttribute('aria-expanded'), 'false');
  const views = page.locator('.linked-database-view');
  assert.equal(await views.count(), 2);
  const expected = [
    { name: 'Visão independente Alfa', search: 'Alfa' },
    { name: 'Visão independente Beta', search: 'Beta' },
  ];
  const rows = [];
  for (let index = 0; index < expected.length; index++) {
    assert.equal(await views.nth(index).locator('input.linked-database-name').inputValue(), expected[index].name);
    assert.equal(await views.nth(index).locator('.db-search input').inputValue(), expected[index].search);
    const texts = await views.nth(index).locator('.db-table tbody tr').allInnerTexts();
    assert.equal(texts.length, 1);
    assert.ok(texts[0].includes(expected[index].search));
    rows.push(texts[0].trim());
  }
  return { columns: 7, image: imageState, collapsedHeading: true, linkedViews: expected, independentlyFilteredRows: rows, reopened: true };
}

async function exportCurrentPageAsPdf(page, pdfPath) {
  const root = path.dirname(pdfPath);
  const markerScript = 'C:/Users/clove/.codex/plugins/cache/openai-primary-runtime/pdf/26.1026.10807/skills/pdf/container_tools/mark_artifact_operation_started.mjs';
  execFileSync(process.execPath, [markerScript, '--operation-kind', 'create', '--expected-output-count', '1', '--output-format', 'pdf'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  const pageOptions = page.locator('button[aria-label="Opções da página"], button[aria-label="Page options"], button[aria-label="Opciones de página"]').first();
  await pageOptions.click();
  const action = page.locator('[role="menuitem"], .menu-item').filter({ hasText: /Exportar como PDF|Export as PDF/i }).last();
  await action.waitFor({ state: 'visible' });
  await action.click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 1000)) await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(fs.existsSync(pdfPath), 'The page PDF export must write into the synthetic temporary directory.');
  const bytes = fs.readFileSync(pdfPath);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), '%PDF', 'The exported artifact must be a PDF.');
  assert.ok(bytes.length > 1000, 'The exported PDF must contain page content.');
  const python = [
    'import json, sys',
    'import logging, warnings',
    'logging.getLogger("pdfminer").setLevel(logging.ERROR)',
    'warnings.filterwarnings("ignore")',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'stdout_encoding = sys.stdout.encoding',
    'pypdf_text = "\\n".join((page.extract_text() or "") for page in reader.pages)',
    'import pdfplumber',
    'with pdfplumber.open(sys.argv[1]) as pdf:',
    '  pdfplumber_text = "\\n".join((page.extract_text(layout=True) or "") for page in pdf.pages)',
    'image_count = 0',
    'for page in reader.pages:',
    '  resources = page.get("/Resources")',
    '  xobjects = resources.get("/XObject") if resources else None',
    '  if xobjects:',
    '    for ref in xobjects.get_object().values():',
    '      if ref.get_object().get("/Subtype") == "/Image": image_count += 1',
    'print(json.dumps({"pageCount": len(reader.pages), "pypdfText": pypdf_text, "pdfplumberText": pdfplumber_text, "imageCount": image_count, "stdoutEncoding": stdout_encoding}, ensure_ascii=True))',
  ].join('\n');
  const parsedPdf = JSON.parse(execFileSync(workspacePython, ['-c', python, pdfPath], { encoding: 'utf8', cwd: projectRoot }));
  const normalizedText = parsedPdf.pdfplumberText.normalize('NFC').replace(/\s+/g, ' ').trim();
  const requiredText = [
    'Interface integrada',
    'Seção recolhível',
    'Coluna sintética 1',
    'Coluna sintética 7',
    'Legenda integrada sintética',
    'Visão independente Alfa',
    'Visão independente Beta',
  ];
  const extractedTextChecks = Object.fromEntries(requiredText.map((text) => [text, normalizedText.includes(text)]));
  const previewPath = path.join(projectRoot, pdfPreviewRelativePath);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  const pageCountLine = execFileSync(path.join(popplerBin, 'pdfinfo.exe'), [pdfPath], { encoding: 'utf8', cwd: projectRoot })
    .split(/\r?\n/)
    .find((line) => /^Pages:\s+/.test(line));
  const popplerPageCount = Number(pageCountLine?.replace(/^Pages:\s+/, ''));
  assert.equal(popplerPageCount, parsedPdf.pageCount, 'Poppler and pypdf must agree on the PDF page count.');
  assert.ok(popplerPageCount > 0, 'The exported PDF must have at least one page.');
  const renderPrefix = path.join(root, 'rendered-page');
  execFileSync(path.join(popplerBin, 'pdftoppm.exe'), ['-f', '1', '-l', String(popplerPageCount), '-png', '-r', '144', pdfPath, renderPrefix], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  const previewPages = [];
  for (let pageNumber = 1; pageNumber <= popplerPageCount; pageNumber++) {
    const renderedPath = [`${renderPrefix}-${pageNumber}.png`, `${renderPrefix}-${String(pageNumber).padStart(2, '0')}.png`]
      .find((candidate) => fs.existsSync(candidate));
    assert.ok(renderedPath, `PDF page ${pageNumber} must render through Poppler.`);
    const destination = pageNumber === 1
      ? previewPath
      : path.join(path.dirname(previewPath), `interaction-expansion-final-page${pageNumber}.png`);
    fs.copyFileSync(renderedPath, destination);
    previewPages.push(path.relative(projectRoot, destination).replaceAll(path.sep, '/'));
  }
  assert.ok(fs.existsSync(previewPath), 'The first exported PDF page must render to the durable synthetic preview.');
  assert.ok(parsedPdf.imageCount > 0, 'The exported PDF must contain the synthetic page image.');
  assert.ok(Object.values(extractedTextChecks).every(Boolean), `The PDF must contain the integrated page content: ${JSON.stringify(extractedTextChecks)}; pdfplumber layout text preview: ${JSON.stringify(normalizedText.slice(0, 1800))}`);
  return {
    result: 'passed',
    signature: '%PDF',
    bytes: bytes.length,
    pages: parsedPdf.pageCount,
    embeddedImages: parsedPdf.imageCount,
    extractedTextChecks,
    textExtractor: 'pdfplumber extract_text(layout=True) with whitespace normalization',
    pypdfTextLength: parsedPdf.pypdfText.length,
    pythonStdoutEncoding: parsedPdf.stdoutEncoding,
    previewPages,
  };
}

function displayNumber(text) {
  const cleaned = text.trim().replace(/[^\d-]/g, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

async function readVisibleAmounts(page) {
  return page.locator('.db-table tbody td[data-col-id="amount"]').evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
}

function assertUiAmounts(actual, expected, context) {
  assert.equal(actual.length, expected.length, `${context}: expected ${expected.length} visible amount cells.`);
  for (let index = 0; index < expected.length; index++) {
    assert.equal(displayNumber(actual[index]), expected[index], `${context}: incorrect value in row ${index + 1}.`);
  }
}

function checkSavedValues(rows, expected) {
  let bad = null;
  for (let index = 0; index < rows.length; index++) {
    const text = fs.readFileSync(rows[index].file, 'utf8');
    const line = text.split(/\r?\n/).find((candidate) => /^Quantidade:\s*/.test(candidate));
    const raw = line?.replace(/^Quantidade:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
    if (Number(raw) !== expected[index]) {
      bad = { row: index + 1, expected: expected[index], found: raw ?? null };
      break;
    }
  }
  return bad;
}

async function waitForSavedValues(rows, expected, description, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bad = checkSavedValues(rows, expected);
    if (!bad) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`Timed out waiting for ${description}; first mismatch: ${JSON.stringify(checkSavedValues(rows, expected))}`);
}

async function measureScale(page, app, fixture, timings) {
  let started = performance.now();
  await openPage(page, 'Escala');
  await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1000, null, { timeout: 60000 });
  timings.render1000RowsMs = Math.round(performance.now() - started);
  const rowElements = await page.locator('.db-table tbody tr').count();
  assert.equal(rowElements, rowCount, 'The database must render all 1,000 synthetic rows.');
  const amountCells = page.locator('.db-table tbody td[data-col-id="amount"]');
  assert.equal(await amountCells.count(), rowCount);

  started = performance.now();
  await page.locator('.db-filter-chip-add').click();
  await page.locator('.db-filter-chip').last().click();
  const filter = page.locator('.popover.db-panel').last();
  await filter.locator('.db-filter-popover-content input[type="text"]').fill('Registro 1000');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.db-table tbody tr')];
    return rows.length === 1 && rows[0]?.textContent?.includes('Registro 1000');
  }, null, { timeout: 30000 });
  timings.filterToOneRowMs = Math.round(performance.now() - started);
  await page.locator('.db-filter-reset').click();
  await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1000, null, { timeout: 30000 });

  started = performance.now();
  const firstCell = amountCells.first();
  const lastCell = amountCells.last();
  await firstCell.scrollIntoViewIfNeeded();
  const firstBox = await firstCell.boundingBox();
  assert.ok(firstBox);
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await lastCell.scrollIntoViewIfNeeded();
  const lastBox = await lastCell.boundingBox();
  assert.ok(lastBox);
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.db-table tbody td[data-col-id="amount"].is-grid-selected').length === 1000, null, { timeout: 30000 });
  timings.select1000CellsMs = Math.round(performance.now() - started);
  assert.equal(await page.locator('.db-table tbody td[data-col-id="amount"].is-grid-selected').count(), 1000);

  const values = Array.from({ length: rowCount }, (_, index) => index + 1);
  const clipboard = values.join('\n');
  const applyClipboard = async () => {
    await page.evaluate((text) => navigator.clipboard.writeText(text), clipboard);
    await page.keyboard.press('Control+V');
    await page.waitForFunction((expectedValues) => {
      const cells = [...document.querySelectorAll('.db-table tbody td[data-col-id="amount"]')];
      if (cells.length !== expectedValues.length) return false;
      const numberAt = (index) => {
        const digits = (cells[index]?.textContent ?? '').trim().replace(/[^\d-]/g, '');
        return digits === '' ? Number.NaN : Number(digits);
      };
      return numberAt(0) === expectedValues[0] && numberAt(499) === expectedValues[499] && numberAt(999) === expectedValues[999];
    }, values, { timeout: 90000 });
  };

  started = performance.now();
  await applyClipboard();
  const firstBatchMs = Math.round(performance.now() - started);
  assertUiAmounts(await readVisibleAmounts(page), values, 'first 1,000-cell paste');
  started = performance.now();
  await waitForSavedValues(fixture.rows, values, 'the first 1,000-cell save');
  timings.persistFirst1000CellsMs = Math.round(performance.now() - started);

  await amountCells.first().click();
  started = performance.now();
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('.db-table tbody td[data-col-id="amount"]')];
    return cells.length === 1000 && cells.every((cell) => cell.textContent?.trim() === '0');
  }, null, { timeout: 60000 });
  timings.undo1000CellsMs = Math.round(performance.now() - started);
  assertUiAmounts(await readVisibleAmounts(page), Array(rowCount).fill(0), 'undo of the saved 1,000-cell paste');
  started = performance.now();
  await waitForSavedValues(fixture.rows, Array(rowCount).fill(0), 'persistence of the undo restoring initial values');
  timings.persistUndo1000CellsMs = Math.round(performance.now() - started);

  started = performance.now();
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForFunction((expectedValues) => {
    const cells = [...document.querySelectorAll('.db-table tbody td[data-col-id="amount"]')];
    if (cells.length !== expectedValues.length) return false;
    const numberAt = (index) => {
      const digits = (cells[index]?.textContent ?? '').trim().replace(/[^\d-]/g, '');
      return digits === '' ? Number.NaN : Number(digits);
    };
    return numberAt(0) === expectedValues[0] && numberAt(499) === expectedValues[499] && numberAt(999) === expectedValues[999];
  }, values, { timeout: 90000 });
  timings.redo1000CellsMs = Math.round(performance.now() - started);
  assertUiAmounts(await readVisibleAmounts(page), values, 'redo of the undone 1,000-cell paste');
  started = performance.now();
  await waitForSavedValues(fixture.rows, values, 'persistence of the redone 1,000-cell paste');
  timings.persistFinal1000CellsMs = Math.round(performance.now() - started);

  const beforeLimitAttempt = await readVisibleAmounts(page);
  assertUiAmounts(beforeLimitAttempt, values, 'before 1,001-cell rejection');
  const overLimitClipboard = Array.from({ length: rowCount + 1 }, (_, index) => 90000 + index).join('\n');
  await amountCells.first().click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), overLimitClipboard);
  started = performance.now();
  await page.keyboard.press('Control+V');
  const limitToast = page.locator('.toast.is-error').last();
  await limitToast.waitFor({ state: 'visible', timeout: 15000 });
  const limitError = await limitToast.innerText();
  assert.ok(/1000|1,000|1\.000/.test(limitError), `The 1,001-cell action must report the 1,000-cell cap: ${limitError}`);
  const afterLimitAttempt = await readVisibleAmounts(page);
  assertUiAmounts(afterLimitAttempt, values, 'after rejected 1,001-cell paste');
  assert.equal(await page.locator('.db-table tbody tr').count(), rowCount, 'The rejected paste must not create partial rows.');
  timings.reject1001CellsMs = Math.round(performance.now() - started);
  assert.equal(checkSavedValues(fixture.rows, values), null, 'The rejected paste must not partially change persisted data.');

  return {
    renderedRows: rowElements,
    selectableAmountCells: rowCount,
    operation: { kind: 'clipboard TSV paste', cells: rowCount, observedMs: firstBatchMs },
    limitAttempt: { cells: rowCount + 1, rejected: true, error: limitError.replace(/\s+/g, ' ').trim(), rowsAfter: rowCount },
    allCellsPersisted: true,
    undoRestoredInitialValues: true,
    redoRestoredFinalValues: true,
    persistenceVerifiedAfterFinalRedo: true,
    valuesAfterReopenExpected: { first: values[0], middle: values[499], last: values[999] },
  };
}

async function runIntegratedUi() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-interaction-final-ui-'));
  const resolvedRoot = path.resolve(root);
  assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'The synthetic profile must be inside the OS temporary directory.');
  const fixture = writeFixture(root);
  const pdfPath = path.join(root, 'interface-integrated.pdf');
  const pageErrors = [];
  const timings = {};
  let app = null;
  let launchedApps = 0;
  let closedApps = 0;
  let tempRootRemoved = false;
  let cleanupError = null;
  let stage = 'launch-first-window';
  const aboutObservations = [];
  let interfaceBeforeRestart = null;
  let interfaceAfterRestart = null;
  let pdf = null;
  let pdfValidationError = null;
  let scale = { allCellsPersisted: false };
  let result;
  let hiddenWindowVerified = false;

  try {
    const launchStarted = performance.now();
    hiddenWindowVerified = false;
    let runtime = await launchHidden(fixture.profileDir, pdfPath, pageErrors);
    app = runtime.app;
    launchedApps++;
    hiddenWindowVerified = true;
    const page = runtime.page;
    timings.firstLaunchReadyMs = Math.round(performance.now() - launchStarted);
    stage = 'about-versions-en-es-pt';
    const aboutVersions = await verifyAboutVersions(page, aboutObservations);
    assert.ok(aboutVersions.every((item) => ['en', 'es', 'pt'].includes(item.locale)));
    stage = 'integrated-page-edit-and-persistence';
    interfaceBeforeRestart = await verifyIntegratedPage(page, fixture.vaultDir, { editViews: true });
    await assertHidden(app);
    hiddenWindowVerified = true;

    await app.close();
    closedApps++;
    app = null;
    stage = 'reopen-integrated-page';
    const reopenStarted = performance.now();
    hiddenWindowVerified = false;
    runtime = await launchHidden(fixture.profileDir, pdfPath, pageErrors);
    app = runtime.app;
    launchedApps++;
    hiddenWindowVerified = true;
    const reopenedPage = runtime.page;
    interfaceAfterRestart = await verifyIntegratedPage(reopenedPage, fixture.vaultDir, { editViews: false });
    stage = 'pdf-export-and-content-check';
    try {
      pdf = await exportCurrentPageAsPdf(reopenedPage, pdfPath);
    } catch (error) {
      pdfValidationError = sanitizeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1800);
      pdf = { result: 'failed', error: pdfValidationError };
    }
    timings.reopenPageAndExportMs = Math.round(performance.now() - reopenStarted);
    await assertHidden(app);
    hiddenWindowVerified = true;

    stage = '1000-row-interaction-persistence';
    scale = await measureScale(reopenedPage, app, fixture, timings);
    await assertHidden(app);
    hiddenWindowVerified = true;
    await app.close();
    closedApps++;
    app = null;

    stage = 'reopen-1000-row-values';
    const dataReopenStarted = performance.now();
    hiddenWindowVerified = false;
    runtime = await launchHidden(fixture.profileDir, pdfPath, pageErrors);
    app = runtime.app;
    launchedApps++;
    hiddenWindowVerified = true;
    const finalPage = runtime.page;
    await openPage(finalPage, 'Escala');
    await finalPage.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1000, null, { timeout: 60000 });
    const reopenedAmounts = await readVisibleAmounts(finalPage);
    const expected = Array.from({ length: rowCount }, (_, index) => index + 1);
    assertUiAmounts(reopenedAmounts, expected, 'all saved values after restarting the app');
    timings.reopen1000RowsAndValuesMs = Math.round(performance.now() - dataReopenStarted);
    await assertHidden(app);
    hiddenWindowVerified = true;
    assert.deepEqual(pageErrors, [], 'The renderer must report no page errors across all hidden launches.');
    result = {
      result: pdfValidationError ? 'failed' : 'passed',
      ...(pdfValidationError ? { failedStage: 'pdf-export-and-content-check', error: pdfValidationError } : {}),
      profile: 'synthetic-only',
      hiddenWindowVerified: true,
      pageErrors,
      aboutVersions,
      integratedPage: interfaceBeforeRestart,
      reopenedIntegratedPage: interfaceAfterRestart,
      pdf,
      scale,
      timings,
      launchCount: launchedApps,
    };
  } catch (error) {
    const diagnostic = sanitizeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1800);
    result = {
      result: 'failed',
      stage,
      error: diagnostic,
      aboutObservations,
      integratedPage: interfaceBeforeRestart,
      reopenedIntegratedPage: interfaceAfterRestart,
      pdf,
      scale,
      timings,
      pageErrors,
      launchCount: launchedApps,
      hiddenWindowVerified,
    };
  } finally {
    if (app) {
      try {
        await app.close();
        closedApps++;
      } catch (error) {
        cleanupError = `Electron close failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
      tempRootRemoved = !fs.existsSync(root);
    } catch (error) {
      cleanupError = [cleanupError, `Temporary root removal failed: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
    }
    result ??= { result: 'failed', stage, error: 'Integrated UI ended without a result.', pageErrors, scale };
    result.appCloseVerified = launchedApps > 0 && closedApps === launchedApps;
    result.tempRootRemovedVerified = tempRootRemoved;
    result.integratedFixtureCleanupVerified = result.appCloseVerified && result.tempRootRemovedVerified;
    if (cleanupError) result.cleanupError = sanitizeDiagnostic(cleanupError).slice(0, 500);
  }
  return result;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.morrowBaseVersion, '1.2.1');
  assert.equal(pkg.morrowBaseCommit, '5e6392bb6425924abd30eec8a99b42aa8c953577');
  assert.equal(pkg.forkVersion, '1.1.0');
  assert.equal(pkg.version, '1.2.1-fork.1.1.0');
  const revision = gitRevision();
  const source = sourceFingerprint();
  const initialBundle = bundleFingerprint();
  assert.ok(initialBundle.files > 0, 'Run npm run check to build the final app before UI verification.');

  const groups = await runExistingGroups(initialBundle);
  const integratedUi = await runIntegratedUi();
  const finalBundle = bundleFingerprint();
  const finalSource = sourceFingerprint();
  const bundleStableAcrossAllGroups = initialBundle.sha256 === finalBundle.sha256 && groups.every((group) => group.buildStableDuringGroup);
  const sourceStableDuringRun = source.sha256 === finalSource.sha256;
  const overall = groups.every((group) => group.result === 'passed') &&
    bundleStableAcrossAllGroups && sourceStableDuringRun && integratedUi.result !== 'failed' && integratedUi.hiddenWindowVerified &&
    integratedUi.pageErrors.length === 0 && integratedUi.scale.allCellsPersisted && integratedUi.integratedFixtureCleanupVerified;

  const report = {
    timestamp: new Date().toISOString(),
    sourceRevision: revision,
    sourceHash: source.sha256,
    sourceFileCount: source.files,
    bundleFingerprint: initialBundle.sha256,
    bundleFileCount: initialBundle.files,
    bundleStableAcrossAllGroups,
    sourceStableDuringRun,
    version: {
      officialBase: pkg.morrowBaseVersion,
      officialBaseCommit: pkg.morrowBaseCommit,
      fork: pkg.forkVersion,
      package: pkg.version,
    },
    groups,
    integratedUi,
    cleanup: {
      integratedFixtureCleanupVerified: integratedUi.integratedFixtureCleanupVerified,
      appCloseAttemptedInPriorGroups: groups.filter((group) => ['delivery1', 'delivery2', 'delivery3'].includes(group.group)).every((group) => group.appCloseAttempted === true),
      appCloseVerifiedForEveryGroup: groups.every((group) => group.appCloseVerified === true),
      priorSyntheticFixturesRetained: groups.some((group) => group.syntheticFixturesRetained),
      temporaryArtifactsRemovedForEveryGroup: groups.every((group) => group.temporaryArtifactsRemoved === true),
    },
    overall: overall ? 'passed' : 'failed',
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(os.tmpdir()), 'Durable evidence must not contain temporary absolute paths.');
  fs.writeFileSync(evidencePath, serialized, 'utf8');
  console.log(`Evidence JSON: ${path.relative(projectRoot, evidencePath).replaceAll(path.sep, '/')}`);
  console.log(`SOURCE ${revision} ${source.sha256}`);
  console.log(`BUNDLE ${initialBundle.sha256}`);
  console.log(`RESULT interaction-expansion-final: ${report.overall}`);
  if (report.overall !== 'passed') process.exitCode = 1;
}

if (process.argv.includes('--integrated-only-diagnostic')) {
  const revision = gitRevision();
  const sourceBefore = sourceFingerprint();
  const bundleBefore = bundleFingerprint();
  runIntegratedUi().then((integratedUi) => {
    const sourceAfter = sourceFingerprint();
    const bundleAfter = bundleFingerprint();
    const report = {
      mode: 'integrated-only-diagnostic',
      sourceRevision: revision,
      sourceHash: sourceBefore.sha256,
      sourceStable: sourceBefore.sha256 === sourceAfter.sha256,
      bundleFingerprint: bundleBefore.sha256,
      bundleStable: bundleBefore.sha256 === bundleAfter.sha256,
      integratedUi,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.sourceStable || !report.bundleStable || integratedUi.result !== 'passed' || !integratedUi.integratedFixtureCleanupVerified)
      process.exitCode = 1;
  }).catch((error) => {
    console.error('Integrated-only UI diagnostic failed:', error.stack ?? error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error('Final interaction UI verification failed:', error.stack ?? error);
    process.exitCode = 1;
  });
}
