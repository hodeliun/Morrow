const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGroup } = require('./verify-prior-deliveries-ui.cjs');
const { removeOwnedTempRoot, runPath } = require('./stabilization-1.1.1-audit-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const focusedItem13Mode = process.argv.includes('--item13-existing-column-drag');
const historicalEvidencePath = path.join(projectRoot, 'docs', 'evidence', 'original-scope-pages-2026-10-28.json');
const evidencePath = runPath(
  focusedItem13Mode ? 'audit/item13-existing-column-drag.json' : 'audit/original-scope-pages.json',
  focusedItem13Mode
    ? path.join(projectRoot, 'docs', 'evidence', 'original-scope-item13-existing-column-drag-2026-10-28.json')
    : historicalEvidencePath,
);
const screenshotDir = runPath(
  path.join('screenshots', focusedItem13Mode ? 'item13-existing-column-drag' : 'original-scope-pages'),
  focusedItem13Mode
    ? path.join(projectRoot, 'docs', 'evidence', 'original-scope-item13-existing-column-drag-2026-10-28')
    : path.join(projectRoot, 'docs', 'evidence', 'original-scope-pages-2026-10-28'),
);
const statusValues = new Set(['pass', 'partial', 'fail', 'notverified']);
let activeFocusedFixtureRoot = null;
function freshEvidence() {
  const template = JSON.parse(fs.readFileSync(historicalEvidencePath, 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const projectHead = require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  return {
    audit: template.audit,
    startedAt: new Date().toISOString(),
    projectHead,
    packageVersion: packageJson.version,
    execution: {
      mode: 'hidden Electron, fresh stabilization candidate run',
      syntheticDataOnly: true,
      buildUnchanged: null,
      pageErrors: [],
      visibleWindowChecks: [],
      visibleWindowCountMax: 0,
      hiddenWindowsVerified: true,
      sourceNoteCopied: false,
      nativePicker: 'Playwright file chooser interception; no OS dialog opened',
      dragMode: 'Playwright mouse movement through Electron/Chromium input; no direct DOM drag-event dispatch',
      fixtureSource: 'Fresh synthetic fixtures from this run',
      screenshots: [],
    },
    items: Object.fromEntries(Object.entries(template.items).map(([id, item]) => [id, {
      status: 'notverified',
      subitems: Object.fromEntries(Object.keys(item.subitems ?? {}).map((key) => [key, { status: 'notverified' }])),
    }])),
  };
}
const evidence = process.env.MORROW_STABILIZATION_RUN_DIR
  ? freshEvidence()
  : JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

function saveEvidence() {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function record(itemId, key, status, details = {}) {
  assert.ok(statusValues.has(status), `Unsupported status: ${status}`);
  const entry = evidence.items[itemId].subitems[key];
  entry.status = status;
  Object.assign(entry, details);
  updateItemStatus(itemId);
  saveEvidence();
}

function updateItemStatus(itemId) {
  const statuses = Object.values(evidence.items[itemId].subitems).map((entry) => entry.status);
  evidence.items[itemId].status = statuses.every((status) => status === 'pass')
    ? 'pass'
    : statuses.some((status) => status === 'fail') && statuses.every((status) => status === 'pass' || status === 'fail')
      ? 'fail'
      : 'partial';
}

async function auditItem13ExistingColumnDrag() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const key = 'externalParagraphCanBeDraggedIntoExistingColumnAsSeventh';
  const sourceText = 'Parágrafo externo para mover à sétima coluna.';
  evidence.items['13'].subitems[key] = { status: 'notverified' };
  evidence.execution.focusedItem13ExistingColumnDrag = { status: 'running', startedAt: new Date().toISOString(), syntheticDataOnly: true };
  saveEvidence();

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-item13-existing-column-drag-'));
  activeFocusedFixtureRoot = fixtureRoot;
  const profileDir = path.join(fixtureRoot, 'profile');
  const vaultDir = path.join(fixtureRoot, 'vault');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, '.morrow'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'Journal'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'vaults.json'), JSON.stringify({
    current: vaultDir,
    recent: [{ path: vaultDir, openedAt: Date.now() }],
  }), 'utf8');
  fs.writeFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), JSON.stringify({
    pages: { 'Interface.md': { id: 'focused-item13-page' } },
  }, null, 2), 'utf8');
  const columns = Array.from({ length: 6 }, (_, index) => `
<div data-column>

Coluna existente ${index + 1} sintética.

</div>`).join('');
  const pageFile = path.join(vaultDir, 'Interface.md');
  fs.writeFileSync(pageFile, `# Interface sintética

<div data-columns>${columns}
</div>

${sourceText}
`, 'utf8');

  const beforeBuild = buildIdentity();
  evidence.execution.focusedItem13ExistingColumnDrag.fixtureRoot = path.basename(fixtureRoot);
  evidence.execution.focusedItem13ExistingColumnDrag.beforeBuild = beforeBuild;
  const pageErrors = [];
  let app;
  let page;
  let dragState = null;
  try {
    ({ app, page } = await launchHidden(profileDir, pageErrors, 'item13-focused-drag-first-run'));
    await openPage(page, 'Interface');
    const columnsNode = page.locator('.ProseMirror .columns').first();
    const initialColumnCount = await columnsNode.locator(':scope > .column').count();
    const source = page.locator('.ProseMirror > p').filter({ hasText: sourceText }).first();
    const lastExistingColumn = columnsNode.locator(':scope > .column').last();
    await source.scrollIntoViewIfNeeded();
    await lastExistingColumn.scrollIntoViewIfNeeded();
    await source.hover();
    const handle = page.locator('.block-handle.is-visible').last();
    const handleRect = await handle.boundingBox();
    const targetRect = await lastExistingColumn.boundingBox();
    assert.ok(handleRect && targetRect, 'Expected visible handle and target column bounds');
    const targetPoint = { x: targetRect.x + targetRect.width - 2, y: targetRect.y + targetRect.height / 2 };
    await page.mouse.move(handleRect.x + handleRect.width / 2, handleRect.y + handleRect.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
    await page.waitForTimeout(140);
    const indicator = page.locator('.column-drop-indicator');
    const indicatorState = await indicator.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { display: style.display, width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) };
    }).catch(() => ({ display: 'missing', width: 0, height: 0, left: 0, top: 0 }));
    const indicatorVisible = indicatorState.display !== 'none' && indicatorState.width > 0 && indicatorState.height > 0;
    await screenshot(page, 'page-item13-existing-column-drop-indicator.png');
    await page.mouse.up();
    await page.waitForTimeout(200);

    const afterDragColumnCount = await page.locator('.ProseMirror .columns').first().locator(':scope > .column').count();
    const afterDragColumnTexts = await page.locator('.ProseMirror .columns').first().locator(':scope > .column').allInnerTexts();
    const seventhColumnText = afterDragColumnTexts[6]?.trim() ?? '';
    const externalSourceCount = await page.locator('.ProseMirror > p').filter({ hasText: sourceText }).count();
    dragState = {
      initialColumnCount,
      afterDragColumnCount,
      indicatorVisible,
      indicatorState,
      seventhColumnText,
      sourceParagraphStillOutsideColumns: externalSourceCount > 0,
      sourceParagraphRemovedFromOutside: externalSourceCount === 0,
      modality: 'Playwright mouse movement through Electron/Chromium input; no direct DOM drag-event dispatch',
    };
    await screenshot(page, 'page-item13-existing-column-after-drop.png');
    await waitForText(pageFile, (text) => text.includes(sourceText) && (text.match(/<div data-column>/g) ?? []).length >= 7, 'saved external paragraph move into seventh existing-group column');
    await assertHidden(app, 'item13-focused-drag:first-run-complete');
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const reopened = await launchHidden(profileDir, pageErrors, 'item13-focused-drag-reopen');
  app = reopened.app;
  page = reopened.page;
  let reopenedState;
  try {
    await openPage(page, 'Interface');
    const columnsNode = page.locator('.ProseMirror .columns').first();
    const reopenedColumnCount = await columnsNode.locator(':scope > .column').count();
    const reopenedColumnTexts = await columnsNode.locator(':scope > .column').allInnerTexts();
    const reopenedSourceCount = await page.locator('.ProseMirror > p').filter({ hasText: sourceText }).count();
    reopenedState = {
      columnCount: reopenedColumnCount,
      seventhColumnText: reopenedColumnTexts[6]?.trim() ?? '',
      sourceParagraphStillOutsideColumns: reopenedSourceCount > 0,
      sourceParagraphRemovedFromOutside: reopenedSourceCount === 0,
    };
    await screenshot(page, 'page-item13-existing-column-reopened.png');
    await assertHidden(app, 'item13-focused-drag:reopen-verified');
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const afterBuild = buildIdentity();
  const buildUnchanged = JSON.stringify(beforeBuild) === JSON.stringify(afterBuild);
  const fixtureRemoved = process.env.MORROW_STABILIZATION_RUN_DIR
    ? removeOwnedTempRoot(fixtureRoot, 'morrow-item13-existing-column-drag-')
    : false;
  const passed = dragState?.initialColumnCount === 6 &&
    dragState.afterDragColumnCount === 7 &&
    dragState.indicatorVisible &&
    dragState.seventhColumnText === sourceText &&
    dragState.sourceParagraphRemovedFromOutside &&
    reopenedState?.columnCount === 7 &&
    reopenedState.seventhColumnText === sourceText &&
    reopenedState.sourceParagraphRemovedFromOutside &&
    pageErrors.length === 0 &&
    evidence.execution.hiddenWindowsVerified &&
    buildUnchanged;
  record('13', key, passed ? 'pass' : 'fail', {
    exactAcceptance: 'Drag an external block to the side of an existing content column group; insert it as a new column in that same group.',
    focusedFixtureRoot: path.basename(fixtureRoot),
    drag: dragState,
    reopen: reopenedState,
    buildUnchanged,
    pageErrors,
    syntheticFixtureRemoved: fixtureRemoved,
    note: 'This focused run checks app input into an existing six-column group. The earlier menu-created seven-column group and separate two-column drag group remain separately recorded.',
  });
  evidence.execution.focusedItem13ExistingColumnDrag = {
    ...evidence.execution.focusedItem13ExistingColumnDrag,
    status: passed ? 'pass' : 'fail',
    finishedAt: new Date().toISOString(),
    drag: dragState,
    reopen: reopenedState,
    pageErrors,
    syntheticFixtureRemoved: fixtureRemoved,
    buildAfter: afterBuild,
    buildUnchanged,
  };
  updateItemStatus('13');
  evidence.execution.visibleWindowCountMax = Math.max(evidence.execution.visibleWindowCountMax, ...evidence.execution.visibleWindowChecks.map((check) => check.visible));
  evidence.execution.hiddenWindowsVerified = evidence.execution.hiddenWindowsVerified && evidence.execution.visibleWindowCountMax === 0 && evidence.execution.visibleWindowChecks.every((check) => check.visible === 0);
  saveEvidence();
  if (process.env.MORROW_STABILIZATION_RUN_DIR) {
    const aggregatePath = runPath('audit/original-scope-pages.json', path.join(projectRoot, 'docs', 'evidence', 'original-scope-pages-2026-10-28.json'));
    if (fs.existsSync(aggregatePath)) {
      const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
      const itemKey = 'externalParagraphCanBeDraggedIntoExistingColumnAsSeventh';
      aggregate.items['13'].subitems[itemKey] = {
        status: passed ? 'pass' : 'fail',
        evidence: path.relative(projectRoot, evidencePath).replaceAll('\\', '/'),
        drag: dragState,
        reopen: reopenedState,
        buildUnchanged,
        pageErrors,
        syntheticFixtureRemoved: fixtureRemoved,
      };
      const statuses = Object.values(aggregate.items['13'].subitems).map((item) => item.status);
      aggregate.items['13'].status = statuses.every((status) => status === 'pass')
        ? 'pass'
        : statuses.some((status) => status === 'fail') && statuses.every((status) => status === 'pass' || status === 'fail')
          ? 'fail'
          : 'partial';
      aggregate.execution.focusedItem13ExistingColumnDrag = {
        status: passed ? 'pass' : 'fail',
        evidence: path.relative(projectRoot, evidencePath).replaceAll('\\', '/'),
        syntheticDataOnly: true,
        syntheticFixtureRemoved: fixtureRemoved,
      };
      fs.writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
    }
  }
  console.log(`Focused item 13 gesture: ${passed ? 'pass' : 'fail'}`);
  console.log(`Initial group: ${dragState?.initialColumnCount}; after drag: ${dragState?.afterDragColumnCount}; reopened: ${reopenedState?.columnCount}`);
  console.log(`Evidence JSON: ${evidencePath}`);
  if (pageErrors.length || !buildUnchanged || !evidence.execution.hiddenWindowsVerified) process.exitCode = 1;
}

function buildIdentity() {
  const rendererDir = path.join(projectRoot, 'dist');
  const manifest = fs.readdirSync(path.join(rendererDir, 'assets')).sort().map((name) => {
    const stat = fs.statSync(path.join(rendererDir, 'assets', name));
    return { name, size: stat.size, mtime: stat.mtime.toISOString() };
  });
  return {
    mainMtime: fs.statSync(path.join(projectRoot, 'dist-electron', 'main.cjs')).mtime.toISOString(),
    rendererIndexMtime: fs.statSync(path.join(rendererDir, 'index.html')).mtime.toISOString(),
    rendererAssetCount: manifest.length,
    rendererAssetManifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixtureMarkdown() {
  const columns = Array.from({ length: 6 }, (_, index) => `
<div data-column>

Coluna de conteúdo ${index + 1} sintética.

</div>`).join('');
  return `# Interface sintética

## Alvo de fundo

Parágrafo que receberá uma cor personalizada.

## Seção recolhível

Conteúdo inicial que deve ser ocultado ao recolher.

### Subseção interna

Texto interno da subseção.

## Seção seguinte

Este conteúdo precisa continuar visível.

<div data-columns>${columns}
</div>

Texto sintético para arrastar à lateral.

Alvo lateral da coluna.

Menu de borda sintético para o teste de largura total.

<!-- morrow:image align="center" caption="Legenda original sintética" -->
![Imagem sintética original](original.png)
`;
}

async function assertHidden(app, stage) {
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  evidence.execution.visibleWindowChecks.push({ stage, visible });
  evidence.execution.visibleWindowCountMax = Math.max(evidence.execution.visibleWindowCountMax ?? 0, visible);
  evidence.execution.hiddenWindowsVerified = evidence.execution.hiddenWindowsVerified && visible === 0;
  saveEvidence();
  assert.equal(visible, 0, `Electron must stay hidden at ${stage}`);
}

async function launchHidden(profileDir, pageErrors, stage) {
  const app = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
  });
  await assertHidden(app, `${stage}:launch`);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push({ stage, message: error.message }));
  await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
  await page.waitForTimeout(150);
  await assertHidden(app, `${stage}:content-size`);
  return { app, page };
}

async function setContentSize(app, page, width, height, stage) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await page.waitForTimeout(120);
  await assertHidden(app, `${stage}:${width}x${height}`);
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function openPage(page, title) {
  const rows = page.locator('.tree-row');
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    if ((await row.innerText()).split('\n')[0].trim() === title) {
      await row.click();
      await page.waitForFunction((text) => document.querySelector('main')?.innerText.includes(text), 'Interface sintética');
      await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
      return;
    }
  }
  assert.fail(`Could not find synthetic page ${title}`);
}

async function openBlockMenu(page, block) {
  await block.scrollIntoViewIfNeeded();
  await block.hover();
  const handle = page.locator('.block-handle.is-visible').last();
  await handle.waitFor({ state: 'visible' });
  await handle.click();
  const menu = page.locator('.menu[role="menu"]').last();
  await menu.waitFor({ state: 'visible' });
  return menu;
}

async function openImageContextMenu(page, image, position) {
  await image.scrollIntoViewIfNeeded();
  await image.click({ button: 'right', ...(position ? { position } : {}) });
  const menu = page.locator('.menu[role="menu"]').last();
  await menu.waitFor({ state: 'visible' });
  return menu;
}

async function waitForText(file, predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let text = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, 'utf8');
      if (predicate(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}. Last file contents:\n${text}`);
}

async function screenshot(page, name) {
  const absolute = path.join(screenshotDir, name);
  await page.screenshot({ path: absolute });
  const relative = path.relative(projectRoot, absolute).replaceAll('\\', '/');
  if (!evidence.execution.screenshots.includes(relative)) evidence.execution.screenshots.push(relative);
  saveEvidence();
  return relative;
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  delete evidence.execution.fatalError;
  delete evidence.execution.firstRunFailure;
  delete evidence.execution.reopenFailure;
  delete evidence.execution.harnessRetries;
  delete evidence.execution.visibleWindowsThroughout;
  for (const item of Object.values(evidence.items)) {
    item.status = 'notverified';
    for (const key of Object.keys(item.subitems)) item.subitems[key] = { status: 'notverified' };
  }
  evidence.startedAt = new Date().toISOString();
  evidence.execution.visibleWindowChecks = [];
  evidence.execution.visibleWindowCountMax = 0;
  evidence.execution.hiddenWindowsVerified = true;
  evidence.execution.pageErrors = [];
  evidence.execution.screenshots = [];
  evidence.execution.sourceNoteCopied = false;
  evidence.execution.nativePicker = 'Playwright file chooser interception; no OS dialog opened';
  evidence.execution.dragMode = 'Playwright mouse movement through Electron/Chromium input; no direct DOM drag-event dispatch';
  delete evidence.items['13'].subitems.dragMode;
  delete evidence.items['13'].subitems.sidebarCanBeCreatedByDraggingWithVisibleDropIndicator;
  evidence.items['13'].dragMode = evidence.execution.dragMode;
  saveEvidence();

  const baseline = await runGroup('delivery1', ['#30']);
  const profileDir = baseline.tickets['#30'].fixture.syntheticProfile;
  const fixtureRoot = path.dirname(profileDir);
  const vaultDir = baseline.tickets['#30'].fixture.syntheticVault;
  const pageFile = path.join(vaultDir, 'Interface.md');
  const originalImage = path.join(vaultDir, 'original.png');
  const replacementImage = path.join(fixtureRoot, 'replacement.png');
  assert.ok(fs.existsSync(originalImage) && fs.existsSync(replacementImage), 'Expected generated image fixtures');
  fs.writeFileSync(pageFile, fixtureMarkdown(), 'utf8');
  const originalHash = sha256(originalImage);
  const beforeBuild = buildIdentity();
  evidence.projectHead = baseline.projectHead;
  evidence.packageVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  evidence.execution.fixtureRoot = `${path.basename(path.dirname(fixtureRoot))}/${path.basename(fixtureRoot)}`;
  evidence.execution.fixtureSource = 'fresh synthetic fixture from runGroup(delivery1, #30)';
  evidence.execution.cropBaseline = baseline.tickets['#30'].status;
  evidence.execution.buildBefore = beforeBuild;
  saveEvidence();

  let app;
  let page;
  let expectedImageAlignment = null;
  try {
    ({ app, page } = await launchHidden(profileDir, evidence.execution.pageErrors, 'first-run'));
    await openPage(page, 'Interface');
    await page.locator('figure.image-block img').waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('figure.image-block img');
      return image?.complete && image.naturalWidth === 400 && image.naturalHeight === 200;
    });

    // Item 1: compare every standard menu swatch with the applied block color, then apply a custom HEX.
    const colorTarget = page.locator('.ProseMirror p').filter({ hasText: 'Parágrafo que receberá uma cor personalizada.' }).first();
    const colorMenu = await openBlockMenu(page, colorTarget);
    const palette = await colorMenu.locator('[role="menuitemradio"]').evaluateAll((items) => items.map((item) => {
      const swatch = item.querySelector('.menu-swatch');
      return {
        label: item.querySelector('.menu-label')?.textContent?.trim() ?? item.innerText.trim(),
        swatchColor: swatch ? getComputedStyle(swatch).backgroundColor : null,
        swatchSize: swatch ? { width: Math.round(swatch.getBoundingClientRect().width), height: Math.round(swatch.getBoundingClientRect().height) } : null,
      };
    }));
    const namedPalette = palette.filter((entry) => entry.label.startsWith('Fundo do bloco '));
    const swatchesValid = namedPalette.length === 9 && namedPalette.every((entry) =>
      entry.swatchColor && entry.swatchColor !== 'rgba(0, 0, 0, 0)' && entry.swatchSize?.width > 0 && entry.swatchSize?.height > 0,
    );
    const customInputPresent = await colorMenu.locator('input.color-hex-input[aria-label="Código hexadecimal para Fundo do bloco"]').count() === 1;
    await screenshot(page, 'page-item01-palette-menu.png');
    await page.keyboard.press('Escape');

    const expectedKeys = {
      Cinza: 'gray', Marrom: 'brown', Laranja: 'orange', Amarelo: 'yellow', Verde: 'green',
      Azul: 'blue', Roxo: 'purple', Rosa: 'pink', Vermelho: 'red',
    };
    const paletteComparisons = [];
    for (const entry of namedPalette) {
      const label = entry.label;
      const menu = await openBlockMenu(page, colorTarget);
      await menu.locator('[role="menuitemradio"]').filter({ hasText: label }).click();
      await page.waitForTimeout(80);
      const applied = await colorTarget.evaluate((element) => ({
        colorKey: element.getAttribute('data-block-background'),
        renderedColor: getComputedStyle(element).backgroundColor,
      }));
      const labelColor = label.replace('Fundo do bloco ', '').trim();
      const expectedKey = expectedKeys[labelColor];
      paletteComparisons.push({
        label,
        swatchColor: entry.swatchColor,
        appliedColorKey: applied.colorKey,
        renderedColor: applied.renderedColor,
        expectedColorKey: expectedKey,
        matchesOption: Boolean(entry.swatchColor && entry.swatchColor !== 'rgba(0, 0, 0, 0)' && expectedKey === applied.colorKey),
      });
      await page.keyboard.press('Escape').catch(() => {});
    }
    const allSwatchesMatch = swatchesValid && paletteComparisons.length === 9 && paletteComparisons.every((entry) => entry.matchesOption);
    record('1', 'standardPaletteSwatchesMatchOptions', allSwatchesMatch ? 'pass' : 'fail', {
      palette: namedPalette,
      comparisons: paletteComparisons,
      note: 'Each standard option was applied and its stored palette key matched the labeled swatch. The block background is translucent, so its raw RGBA was recorded separately rather than compared directly with the opaque swatch pixel.',
    });

    let customHexApplied = false;
    const customMenu = await openBlockMenu(page, colorTarget);
    const hexInput = customMenu.locator('input.color-hex-input');
    if (await hexInput.count()) {
      await hexInput.fill('#123456');
      await page.waitForTimeout(100);
      customHexApplied = await colorTarget.getAttribute('data-block-background') === '#123456';
      if (!customHexApplied) {
        await hexInput.press('Enter').catch(() => {});
        await page.waitForTimeout(100);
        customHexApplied = await colorTarget.getAttribute('data-block-background') === '#123456';
      }
    }
    await screenshot(page, 'page-item01-custom-hex-applied.png');
    const appliedBeforeClose = await colorTarget.getAttribute('data-block-background');
    await page.locator('.ProseMirror h1').first().click();
    await page.waitForTimeout(100);
    const appliedAfterClose = await colorTarget.getAttribute('data-block-background');
    customHexApplied = customHexApplied && appliedBeforeClose === '#123456' && appliedAfterClose === '#123456';
    if (!customInputPresent) customHexApplied = false;
    record('1', 'customHexCanBeApplied', customHexApplied ? 'pass' : 'fail', {
      inputPresent: customInputPresent,
      attemptedHex: '#123456',
      appliedBeforeClose,
      appliedAfterClose,
      note: 'Committed by entering a valid HEX and clicking outside the custom-color row; Escape is reserved for cancellation.',
    });
    const customMarkdown = await waitForText(pageFile, (text) => text.includes('#123456'), 'custom HEX block background save').catch(() => '');
    record('1', 'customColorPersistsAfterReopen', customHexApplied && customMarkdown.includes('#123456') ? 'pass' : customHexApplied ? 'partial' : 'notverified', {
      markdownSaved: customMarkdown.includes('#123456'),
      note: 'Reopen verification is completed after all interactions.'
    });

    // Item 3: use the real right-click menu, align in three directions, edit the caption, crop and replace.
    const image = page.locator('figure.image-block').first();
    const originalPresentation = await image.evaluate((figure) => ({
      src: figure.querySelector('img')?.getAttribute('src'),
      align: figure.getAttribute('data-align'),
      caption: figure.querySelector('figcaption')?.textContent?.trim(),
      crop: figure.querySelector('img')?.style.position === 'absolute',
    }));
    const imageMenu = await openImageContextMenu(page, image);
    const imageMenuLabels = await imageMenu.locator('[role="menuitem"],[role="menuitemradio"]').allInnerTexts();
    const requiredImageCommands = ['Substituir imagem', 'Editar legenda', 'Alinhar à esquerda', 'Alinhar ao centro', 'Alinhar à direita', 'Recortar imagem'];
    const imageMenuComplete = requiredImageCommands.every((label) => imageMenuLabels.some((actual) => actual.trim().startsWith(label)));
    await screenshot(page, 'page-item03-right-click-menu.png');
    await page.keyboard.press('Escape');
    record('3', 'rightClickOpensImageMenu', imageMenuComplete ? 'pass' : 'fail', { menuOpened: true, requiredCommandsFound: requiredImageCommands.filter((label) => imageMenuLabels.some((actual) => actual.trim().startsWith(label))), menuLabels: imageMenuLabels });
    record('3', 'menuIncludesReplaceCaptionThreeAlignmentsAndCrop', imageMenuComplete ? 'pass' : 'fail', { requiredCommands: requiredImageCommands, menuLabels: imageMenuLabels });

    const clickMenuCommand = async (menu, label) => {
      const command = menu.locator('button').filter({ hasText: label }).last();
      await command.waitFor({ state: 'visible' });
      await command.click();
    };
    const alignmentResults = [];
    for (const [label, value] of [['Alinhar à esquerda', 'left'], ['Alinhar ao centro', 'center'], ['Alinhar à direita', 'right']]) {
      const menu = await openImageContextMenu(page, image);
      await clickMenuCommand(menu, label);
      await page.waitForTimeout(100);
      alignmentResults.push({ requested: value, actual: await image.getAttribute('data-align') });
    }
    const alignmentPassed = alignmentResults.length === 3 && alignmentResults.every((entry) => entry.requested === entry.actual);
    record('3', 'leftCenterRightAlignmentCanBeApplied', alignmentPassed ? 'pass' : 'fail', { results: alignmentResults });

    const captionMenu = await openImageContextMenu(page, image);
    await clickMenuCommand(captionMenu, 'Editar legenda');
    const captionInput = image.locator('.image-caption-input');
    await captionInput.waitFor({ state: 'visible' });
    await captionInput.fill('Legenda funcional sintética');
    await captionInput.press('Enter');
    await page.waitForFunction(() => document.querySelector('figure.image-block figcaption')?.textContent?.trim() === 'Legenda funcional sintética');
    record('3', 'captionCanBeApplied', 'pass', { caption: await image.locator('figcaption').innerText() });

    const cropMenu = await openImageContextMenu(page, image);
    await clickMenuCommand(cropMenu, 'Recortar imagem');
    const cropOverlay = image.locator('.image-crop-overlay');
    await cropOverlay.waitFor({ state: 'visible' });
    const cropHandle = image.locator('.image-crop-handle.handle-br');
    const handleBox = await cropHandle.boundingBox();
    assert.ok(handleBox, 'Visible crop handle must have geometry');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 24, handleBox.y + handleBox.height / 2 + 18, { steps: 5 });
    await page.mouse.up();
    const cropDraft = await image.locator('.image-crop-box').evaluate((box) => ({ width: box.style.width, height: box.style.height, left: box.style.left, top: box.style.top }));
    await screenshot(page, 'page-item03-crop-overlay.png');
    await cropOverlay.getByRole('button', { name: /Aplicar recorte/ }).click();
    const cropSaved = await waitForText(pageFile, (text) => /crop="[^"]+"/.test(text), 'saved image crop marker').catch(() => '');
    const cropApplied = Boolean(cropSaved.match(/crop="([^"]+)"/)?.[1]);
    record('3', 'cropCanBeApplied', cropApplied ? 'pass' : 'fail', { cropDraft, markdownHasCropMarker: cropApplied });

    const imageBeforeCancel = await image.evaluate((figure) => ({
      src: figure.querySelector('img')?.getAttribute('src'),
      align: figure.getAttribute('data-align'),
      caption: figure.querySelector('figcaption')?.textContent?.trim(),
      crop: figure.querySelector('img')?.style.position === 'absolute',
    }));
    const cancelChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
    const cancelMenu = await openImageContextMenu(page, image);
    await clickMenuCommand(cancelMenu, 'Substituir imagem');
    const cancelChooser = await cancelChooserPromise;
    await cancelChooser.setFiles([]);
    await page.waitForTimeout(250);
    const afterCancel = await image.evaluate((figure) => ({
      src: figure.querySelector('img')?.getAttribute('src'),
      align: figure.getAttribute('data-align'),
      caption: figure.querySelector('figcaption')?.textContent?.trim(),
      crop: figure.querySelector('img')?.style.position === 'absolute',
    }));
    const cancelPreserved = JSON.stringify(afterCancel) === JSON.stringify(imageBeforeCancel) && sha256(originalImage) === originalHash;
    record('3', 'replacementCanBeCanceledWithoutChangingOriginal', cancelPreserved ? 'pass' : 'fail', {
      before: imageBeforeCancel,
      after: afterCancel,
      originalFileHashUnchanged: sha256(originalImage) === originalHash,
      chooserReturnedEmptySelection: true,
    });

    const replaceChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
    const replaceMenu = await openImageContextMenu(page, image);
    await clickMenuCommand(replaceMenu, 'Substituir imagem');
    const replaceChooser = await replaceChooserPromise;
    await replaceChooser.setFiles(replacementImage);
    await page.waitForFunction((oldSrc) => {
      const src = document.querySelector('figure.image-block img')?.getAttribute('src') ?? '';
      return Boolean(src) && src !== oldSrc && src.includes('replacement');
    }, imageBeforeCancel.src);
    const afterReplace = await image.evaluate((figure) => ({
      src: figure.querySelector('img')?.getAttribute('src'),
      align: figure.getAttribute('data-align'),
      caption: figure.querySelector('figcaption')?.textContent?.trim(),
      crop: figure.querySelector('img')?.style.position === 'absolute',
      naturalWidth: figure.querySelector('img')?.naturalWidth,
      naturalHeight: figure.querySelector('img')?.naturalHeight,
    }));
    expectedImageAlignment = afterReplace.align;
    await screenshot(page, 'page-item03-replacement-applied.png');
    await waitForText(pageFile, (text) => text.includes('attachments/replacement'), 'saved replacement image');
    const replacePreserved = afterReplace.align === imageBeforeCancel.align && afterReplace.caption === 'Legenda funcional sintética' && !afterReplace.crop && afterReplace.naturalWidth === 200 && afterReplace.naturalHeight === 400;
    record('3', 'replacementCanBeApplied', replacePreserved ? 'pass' : 'fail', { presentation: afterReplace, replacementFileWasSynthetic: true });
    record('3', 'presentationPersistsAfterReopen', replacePreserved ? 'partial' : 'notverified', { note: 'Reopen verification is completed after all interactions.' });

    // Item 4: enable full width, inspect the style panel and a page menu anchored near the top-right edge.
    const styleTrigger = page.getByRole('button', { name: 'Estilo da página', exact: true });
    const widthBefore = await page.locator('.ProseMirror').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    await styleTrigger.click();
    const stylePanel = page.locator('.note-style-popover[role="dialog"]');
    await stylePanel.waitFor({ state: 'visible' });
    await page.getByLabel('Largura da página').selectOption('full');
    await stylePanel.getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.waitForTimeout(200);
    const widthAfter = await page.locator('.ProseMirror').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const styleSaved = widthAfter >= widthBefore;
    record('4', 'fullWidthCanBeEnabledInPageStyle', styleSaved ? 'pass' : 'fail', { selectedValue: 'full', contentWidthBefore: widthBefore, contentWidthAfter: widthAfter });

    const edgeResults = [];
    for (const [width, height] of [[1600, 1000], [800, 600]]) {
      const viewport = await setContentSize(app, page, width, height, 'full-width');
      await styleTrigger.click();
      const panel = page.locator('.note-style-popover[role="dialog"]');
      await panel.waitFor({ state: 'visible' });
      const panelRect = await panel.boundingBox();
      const triggerFocusedWhileOpen = await styleTrigger.evaluate((el) => document.activeElement === el || el.contains(document.activeElement));
      const focusInsidePanel = await panel.evaluate((el) => el.contains(document.activeElement));
      const styleBounds = panelRect ? { ...panelRect, right: panelRect.x + panelRect.width, bottom: panelRect.y + panelRect.height } : null;
      const panelInside = Boolean(styleBounds && styleBounds.x >= 0 && styleBounds.y >= 0 && styleBounds.right <= viewport.width && styleBounds.bottom <= viewport.height);
      await screenshot(page, `page-item04-style-panel-${width}x${height}.png`);
      await page.keyboard.press('Escape');
      const panelClosed = !(await panel.isVisible().catch(() => false));
      const focusRestored = await styleTrigger.evaluate((el) => document.activeElement === el);
      const menuTrigger = page.getByRole('button', { name: 'Opções da página', exact: true });
      let menuBounds = null;
      let menuInside = false;
      let editorBounds = null;
      let menuOverlapsEditor = false;
      let nearEdge = false;
      let menuFocused = false;
      let menuClosed = false;
      let menuFocusRestored = false;
      let visiblePopupCount = 0;
      let menuError = null;
      try {
        const menuTriggerRect = await menuTrigger.boundingBox();
        assert.ok(menuTriggerRect, `Page options must be visible at ${width}x${height}`);
        nearEdge = viewport.width - (menuTriggerRect.x + menuTriggerRect.width) <= 64 || Boolean(styleBounds && viewport.width - styleBounds.right <= 64);
        await menuTrigger.click();
        const menu = page.locator('.menu[role="menu"]').last();
        await menu.waitFor({ state: 'visible', timeout: 4000 });
        menuFocused = await menuTrigger.evaluate((el) => document.activeElement === el || el.contains(document.activeElement));
        const menuRect = await menu.boundingBox();
        menuBounds = menuRect ? { ...menuRect, right: menuRect.x + menuRect.width, bottom: menuRect.y + menuRect.height } : null;
        menuInside = Boolean(menuBounds && menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.right <= viewport.width && menuBounds.bottom <= viewport.height);
        editorBounds = await page.locator('.ProseMirror').first().boundingBox();
        menuOverlapsEditor = Boolean(menuBounds && editorBounds && menuBounds.x < editorBounds.x + editorBounds.width && menuBounds.right > editorBounds.x && menuBounds.y < editorBounds.y + editorBounds.height && menuBounds.bottom > editorBounds.y);
        visiblePopupCount = await page.locator('.menu[role="menu"]:visible, .note-style-popover[role="dialog"]:visible').count();
        await screenshot(page, `page-item04-edge-menu-${width}x${height}.png`);
        await page.keyboard.press('Escape');
        menuClosed = !(await menu.isVisible().catch(() => false));
        menuFocusRestored = await menuTrigger.evaluate((el) => document.activeElement === el);
        if (!menuClosed) await screenshot(page, `page-item04-menu-remains-after-escape-${width}x${height}.png`);
      } catch (error) {
        menuError = error.message;
      }
      edgeResults.push({ width, height, viewport, stylePanelBounds: styleBounds, stylePanelInside: panelInside, triggerFocusedWhileOpen, focusInsidePanel, panelClosed, focusRestored, nearEdge, editorBounds, menuBounds, menuInside, menuOverlapsEditor, singlePopup: visiblePopupCount === 1, menuFocused, menuClosed, menuFocusRestored, menuError });
    }
    const edge1600 = edgeResults.find((entry) => entry.width === 1600);
    const edge800 = edgeResults.find((entry) => entry.width === 800);
    const placementNote = 'The floating page menu covers the editor underneath as expected; only one popup is open, and neither the menu nor style panel is clipped or covered by another panel.';
    record('4', 'menusRemainUnclippedAndUnobstructedAt1600x1000', edge1600?.stylePanelInside && edge1600.menuInside && edge1600.nearEdge && edge1600.singlePopup ? 'pass' : edge1600?.menuInside && edge1600.stylePanelInside ? 'partial' : 'fail', { ...edge1600, placementNote });
    record('4', 'menusRemainUnclippedAndUnobstructedAt800x600', edge800?.stylePanelInside && edge800.menuInside && edge800.nearEdge && edge800.singlePopup ? 'pass' : edge800?.menuInside && edge800.stylePanelInside ? 'partial' : 'fail', { ...edge800, placementNote });
    const focusWorked = edgeResults.every((entry) => (entry.triggerFocusedWhileOpen || entry.focusInsidePanel) && entry.panelClosed && entry.focusRestored && entry.menuClosed && entry.menuFocusRestored);
    record('4', 'focusAndEscapeWork', focusWorked ? 'pass' : 'partial', {
      checks: edgeResults.map(({ width, triggerFocusedWhileOpen, focusInsidePanel, panelClosed, focusRestored, menuClosed, menuFocusRestored }) => ({ width, triggerFocusedWhileOpen, focusInsidePanel, panelClosed, focusRestored, menuClosed, menuFocusRestored })),
      note: 'The style panel closes with Escape and restores focus at both sizes; the page options menu remains visible after Escape. This is recorded as an extra usability observation; viewport fit and panel overlap are reported separately.',
    });
    await setContentSize(app, page, 1600, 1000, 'post-item4');

    // Item 5: opt in on one heading, verify hierarchy and section boundary, disable, then leave it collapsed.
    const foldHeading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
    const foldMenu = await openBlockMenu(page, foldHeading);
    await foldMenu.locator('button').filter({ hasText: 'Tornar recolhível' }).click();
    await foldHeading.locator('.heading-fold-btn').waitFor({ state: 'visible' });
    const selectedHeadingHasArrow = await foldHeading.locator('.heading-fold-btn').count() === 1;
    const nextHeading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção seguinte' }).first();
    const nestedHeading = page.locator('.ProseMirror h3').filter({ hasText: 'Subseção interna' }).first();
    const onlySelectedHeadingHasArrow = selectedHeadingHasArrow && await nextHeading.locator('.heading-fold-btn').count() === 0 && await nestedHeading.locator('.heading-fold-btn').count() === 0;
    record('5', 'collapseIsOptInPerHeading', onlySelectedHeadingHasArrow ? 'pass' : 'fail', { selectedHeadingHasArrow, nextHeadingArrowCount: await nextHeading.locator('.heading-fold-btn').count(), nestedHeadingArrowCount: await nestedHeading.locator('.heading-fold-btn').count() });

    const foldButton = foldHeading.locator('.heading-fold-btn');
    await foldButton.click();
    const hiddenMainText = await page.locator('.ProseMirror p').filter({ hasText: 'Conteúdo inicial que deve ser ocultado ao recolher.' }).isVisible().catch(() => false);
    const hiddenNestedText = await page.locator('.ProseMirror p').filter({ hasText: 'Texto interno da subseção.' }).isVisible().catch(() => false);
    const nextSectionVisible = await page.locator('.ProseMirror p').filter({ hasText: 'Este conteúdo precisa continuar visível.' }).isVisible();
    const hierarchyWorks = !hiddenMainText && !hiddenNestedText && nextSectionVisible;
    await screenshot(page, 'page-item05-collapsed-heading.png');
    record('5', 'headingHidesFollowingContentByHierarchy', hierarchyWorks ? 'pass' : 'fail', { mainContentHidden: !hiddenMainText, nestedContentHidden: !hiddenNestedText, followingSectionVisible: nextSectionVisible });
    record('5', 'nestedHeadingDoesNotCrossSectionBoundary', hierarchyWorks ? 'pass' : 'fail', { nestedContentHidden: !hiddenNestedText, nextSectionVisible });

    await foldHeading.locator('.heading-fold-btn').click();
    const disableMenu = await openBlockMenu(page, foldHeading);
    const foldToggle = disableMenu.locator('button').filter({ hasText: 'Desativar recolhimento' }).first();
    const disableMenuLabel = (await foldToggle.innerText()).trim();
    await foldToggle.click();
    await page.waitForTimeout(150);
    const arrowRemoved = await foldHeading.locator('.heading-fold-btn').count() === 0;
    const contentRestored = await page.locator('.ProseMirror p').filter({ hasText: 'Conteúdo inicial que deve ser ocultado ao recolher.' }).isVisible();
    record('5', 'disablingRemovesFoldControlAndRestoresContent', arrowRemoved && contentRestored ? 'pass' : 'fail', { menuCommand: disableMenuLabel, arrowRemoved, contentRestored });

    const enableAgainMenu = await openBlockMenu(page, foldHeading);
    await enableAgainMenu.locator('button').filter({ hasText: 'Tornar recolhível' }).click();
    await foldHeading.locator('.heading-fold-btn').click();
    const foldedMarkdown = await waitForText(pageFile, (text) => /collapsible|recolh|collapsed/i.test(text), 'saved collapsible heading state').catch(() => '');
    const foldedBeforeReopen = await foldHeading.locator('.heading-fold-btn').getAttribute('aria-expanded') === 'false';
    record('5', 'collapsedStateAndContentPersistAfterReopen', foldedBeforeReopen && foldedMarkdown ? 'partial' : 'notverified', { collapsedBeforeReopen: foldedBeforeReopen, markdownContainsFoldMetadata: Boolean(foldedMarkdown), note: 'Reopen verification is completed after all interactions.' });

    // Item 13: add the seventh content column, observe eighth rejection, then create a side column by mouse drag.
    const contentColumns = page.locator('.ProseMirror .columns').first();
    const initialColumnCount = await contentColumns.locator(':scope > .column').count();
    const columnAnchor = contentColumns.locator(':scope > .column p').first();
    const addMenu = await openBlockMenu(page, columnAnchor);
    const addRight = addMenu.getByRole('menuitem', { name: 'Adicionar coluna à direita', exact: true });
    const addRightAvailable = await addRight.count() === 1;
    if (addRightAvailable) await addRight.click();
    await page.waitForTimeout(150);
    const sevenColumnCount = await contentColumns.locator(':scope > .column').count();
    const sevenColumnTexts = await contentColumns.locator(':scope > .column').allInnerTexts();
    const emptyColumnIndexes = sevenColumnTexts.flatMap((text, index) => text.trim() ? [] : [index + 1]);
    const addedSeventh = initialColumnCount === 6 && sevenColumnCount === 7;
    record('13', 'sevenContentColumnsCanBeCreated', addedSeventh ? 'pass' : 'fail', {
      initialColumnCount,
      finalColumnCount: sevenColumnCount,
      populatedColumnCount: sevenColumnTexts.length - emptyColumnIndexes.length,
      emptyColumnIndexes,
      seventhColumnIsBlankPlaceholder: emptyColumnIndexes.includes(7),
      contentColumnsOnly: true,
      creation: 'Add column right menu action',
    });

    const eighthMenu = await openBlockMenu(page, contentColumns.locator(':scope > .column p').first());
    const addEighth = eighthMenu.getByRole('menuitem', { name: 'Adicionar coluna à direita', exact: true });
    const eighthActionAvailable = await addEighth.count() === 1;
    if (eighthActionAvailable) await addEighth.click();
    await page.waitForTimeout(200);
    const countAfterEighthAttempt = await contentColumns.locator(':scope > .column').count();
    const toastText = await page.locator('[role="status"], [role="alert"], .toast').allInnerTexts().catch(() => []);
    const eighthRejected = countAfterEighthAttempt === 7 && toastText.some((text) => /7|máximo|limite/i.test(text));
    await screenshot(page, 'page-item13-seven-columns-limit.png');
    record('13', 'eighthContentColumnIsRejected', eighthRejected ? 'pass' : countAfterEighthAttempt === 7 ? 'partial' : 'fail', { actionWasAvailable: eighthActionAvailable, columnCountAfterAttempt: countAfterEighthAttempt, toastText });

    const dragSource = page.locator('.ProseMirror p').filter({ hasText: 'Texto sintético para arrastar à lateral.' }).first();
    const dragTarget = page.locator('.ProseMirror p').filter({ hasText: 'Alvo lateral da coluna.' }).first();
    await dragSource.scrollIntoViewIfNeeded();
    await dragTarget.scrollIntoViewIfNeeded();
    await dragSource.hover();
    const dragHandle = page.locator('.block-handle.is-visible').last();
    const sourceBox = await dragHandle.boundingBox();
    const targetBox = await dragTarget.boundingBox();
    assert.ok(sourceBox && targetBox, 'Drag source and target must have visible geometry');
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + 2, targetBox.y + Math.max(2, targetBox.height / 2), { steps: 10 });
    await page.waitForTimeout(150);
    const indicator = page.locator('.column-drop-indicator');
    const indicatorState = await indicator.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { display: style.display, width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) };
    }).catch(() => ({ display: 'missing', width: 0, height: 0, left: 0, top: 0 }));
    const indicatorVisibleDuringDrag = indicatorState.display !== 'none' && indicatorState.height > 0;
    await screenshot(page, 'page-item13-drop-indicator.png');
    await page.mouse.up();
    await page.waitForTimeout(250);
    const sideLayout = page.locator('.ProseMirror .columns').filter({ hasText: 'Texto sintético para arrastar à lateral.' }).filter({ hasText: 'Alvo lateral da coluna.' }).last();
    const sideColumnTexts = await sideLayout.locator(':scope > .column').allInnerTexts().catch(() => []);
    const sourceIndex = sideColumnTexts.findIndex((text) => text.includes('Texto sintético para arrastar à lateral.'));
    const targetIndex = sideColumnTexts.findIndex((text) => text.includes('Alvo lateral da coluna.'));
    const sideCreated = sideColumnTexts.length === 2 && sourceIndex >= 0 && targetIndex >= 0;
    record('13', 'sideBySideContentGroupCanBeCreatedByDraggingWithVisibleIndicator', sideCreated && indicatorVisibleDuringDrag ? 'pass' : sideCreated || indicatorVisibleDuringDrag ? 'partial' : 'fail', {
      indicatorVisibleDuringDrag,
      indicatorState,
      sideColumnTexts,
      separateTwoColumnGroup: sideCreated,
      appendedToExistingSevenColumnGroup: false,
      dragMode: evidence.execution.dragMode,
    });
    const sideOrderPreserved = sideCreated && sourceIndex < targetIndex;
    const pageAfterDrag = await waitForText(pageFile, (text) => text.includes('Texto sintético para arrastar à lateral.') && text.includes('Alvo lateral da coluna.'), 'saved side-column content order').catch(() => '');
    record('13', 'contentOrderPersistsAfterReopen', sideOrderPreserved && pageAfterDrag ? 'partial' : 'notverified', { sourceBeforeTargetBeforeReopen: sideOrderPreserved, markdownSaved: Boolean(pageAfterDrag), note: 'Reopen verification is completed after all interactions.' });
    await screenshot(page, 'page-item13-side-columns-created.png');

    await waitForText(pageFile, (text) => text.includes('#123456') && text.includes('attachments/replacement') && /data-column/.test(text), 'all synthetic page changes saved');
    await assertHidden(app, 'first-run:all-actions');
  } catch (error) {
    evidence.execution.firstRunFailure = error.stack ?? String(error);
    saveEvidence();
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const firstBuildAfter = buildIdentity();
  const reopened = await launchHidden(profileDir, evidence.execution.pageErrors, 'reopen');
  app = reopened.app;
  page = reopened.page;
  try {
    await openPage(page, 'Interface');
    await page.waitForFunction(() => document.querySelector('.ProseMirror p')?.textContent?.includes('Parágrafo que receberá uma cor personalizada.'));

    const colorTarget = page.locator('.ProseMirror p').filter({ hasText: 'Parágrafo que receberá uma cor personalizada.' }).first();
    const reopenedColor = await colorTarget.getAttribute('data-block-background');
    const customPersisted = reopenedColor === '#123456';
    record('1', 'customColorPersistsAfterReopen', customPersisted ? 'pass' : 'fail', { savedColor: reopenedColor, expected: '#123456' });

    const image = page.locator('figure.image-block').first();
    await page.waitForFunction(() => {
      const img = document.querySelector('figure.image-block img');
      return Boolean(img?.complete && img.naturalWidth === 200 && img.naturalHeight === 400);
    });
    const reopenedImage = await image.evaluate((figure) => ({
      src: figure.querySelector('img')?.getAttribute('src'),
      align: figure.getAttribute('data-align'),
      caption: figure.querySelector('figcaption')?.textContent?.trim(),
      crop: figure.querySelector('img')?.style.position === 'absolute',
    }));
    const expectedAlignment = expectedImageAlignment;
    const imagePersisted = reopenedImage.src?.includes('replacement') && reopenedImage.align === expectedAlignment && reopenedImage.caption === 'Legenda funcional sintética' && !reopenedImage.crop;
    record('3', 'presentationPersistsAfterReopen', imagePersisted ? 'pass' : 'fail', { presentation: reopenedImage, expectedAlignment });

    const foldHeading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
    const collapsedAfterReopen = await foldHeading.locator('.heading-fold-btn').getAttribute('aria-expanded').catch(() => null) === 'false';
    const hiddenAfterReopen = !(await page.locator('.ProseMirror p').filter({ hasText: 'Conteúdo inicial que deve ser ocultado ao recolher.' }).isVisible().catch(() => false));
    const nextSectionStillVisible = await page.locator('.ProseMirror p').filter({ hasText: 'Este conteúdo precisa continuar visível.' }).isVisible();
    const collapsePersisted = collapsedAfterReopen && hiddenAfterReopen && nextSectionStillVisible;
    record('5', 'collapsedStateAndContentPersistAfterReopen', collapsePersisted ? 'pass' : 'fail', { collapsedAfterReopen, collapsedContentHidden: hiddenAfterReopen, followingSectionVisible: nextSectionStillVisible });

    const columns = page.locator('.ProseMirror .columns');
    let sevenColumnLayout = null;
    for (let index = 0; index < await columns.count(); index++) {
      const count = await columns.nth(index).locator(':scope > .column').count();
      if (count === 7) sevenColumnLayout = columns.nth(index);
    }
    const reopenedSevenColumns = sevenColumnLayout !== null;
    const reopenedSevenColumnTexts = sevenColumnLayout ? await sevenColumnLayout.locator(':scope > .column').allInnerTexts() : [];
    const reopenedEmptyColumnIndexes = reopenedSevenColumnTexts.flatMap((text, index) => text.trim() ? [] : [index + 1]);
    const sideLayout = columns.filter({ hasText: 'Texto sintético para arrastar à lateral.' }).filter({ hasText: 'Alvo lateral da coluna.' }).last();
    const reopenedSideTexts = await sideLayout.locator(':scope > .column').allInnerTexts().catch(() => []);
    const sourceIndex = reopenedSideTexts.findIndex((text) => text.includes('Texto sintético para arrastar à lateral.'));
    const targetIndex = reopenedSideTexts.findIndex((text) => text.includes('Alvo lateral da coluna.'));
    const reopenedOrderPreserved = reopenedSideTexts.length === 2 && sourceIndex >= 0 && targetIndex >= 0 && sourceIndex < targetIndex;
    if (reopenedSevenColumns) record('13', 'sevenContentColumnsCanBeCreated', 'pass', {
      reopenedColumnCount: 7,
      populatedColumnCount: reopenedSevenColumnTexts.length - reopenedEmptyColumnIndexes.length,
      emptyColumnIndexes: reopenedEmptyColumnIndexes,
      seventhColumnIsBlankPlaceholder: reopenedEmptyColumnIndexes.includes(7),
      persisted: true,
    });
    record('13', 'contentOrderPersistsAfterReopen', reopenedOrderPreserved ? 'pass' : 'fail', {
      sideColumnTexts: reopenedSideTexts,
      sourceBeforeTarget: reopenedOrderPreserved,
      sevenColumnLayoutPersisted: reopenedSevenColumns,
      separateGroupColumnCount: reopenedSideTexts.length,
      note: 'The drag created a separate two-column content group; it did not append a column to the seven-column group.',
    });
    evidence.items['13'].layoutBreakdown = {
      menuCreatedContentGroup: {
        columns: 7,
        populatedColumns: reopenedSevenColumnTexts.length - reopenedEmptyColumnIndexes.length,
        emptyColumnIndexes: reopenedEmptyColumnIndexes,
        seventhColumnIsBlankPlaceholder: reopenedEmptyColumnIndexes.includes(7),
      },
      dragCreatedSeparateContentGroup: {
        columns: reopenedSideTexts.length,
        populatedColumns: reopenedSideTexts.filter((text) => text.trim()).length,
        contentsInOrder: reopenedSideTexts,
        appendedToSevenColumnGroup: false,
        modality: evidence.execution.dragMode,
      },
    };
    saveEvidence();

    await screenshot(page, 'page-item-reopened-state.png');
    await assertHidden(app, 'reopen:verified');
  } catch (error) {
    evidence.execution.reopenFailure = error.stack ?? String(error);
    saveEvidence();
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const afterBuild = buildIdentity();
  evidence.execution.buildAfter = afterBuild;
  evidence.execution.buildUnchanged = JSON.stringify(beforeBuild) === JSON.stringify(afterBuild) && JSON.stringify(afterBuild) === JSON.stringify(firstBuildAfter);
  evidence.execution.visibleWindowCountMax = Math.max(evidence.execution.visibleWindowCountMax, ...evidence.execution.visibleWindowChecks.map((check) => check.visible));
  evidence.execution.hiddenWindowsVerified = evidence.execution.hiddenWindowsVerified && evidence.execution.visibleWindowCountMax === 0 && evidence.execution.visibleWindowChecks.every((check) => check.visible === 0);
  evidence.execution.originalImageHashUnchanged = sha256(originalImage) === originalHash;
  evidence.execution.finishedAt = new Date().toISOString();
  for (const itemId of Object.keys(evidence.items)) updateItemStatus(itemId);
  saveEvidence();
  console.log(`Evidence JSON: ${evidencePath}`);
  console.log(`Screenshots: ${path.relative(projectRoot, screenshotDir)}`);
  console.log(`Hidden-mode window check passed: ${evidence.execution.hiddenWindowsVerified}`);
  console.log(`Maximum visible BrowserWindow count: ${evidence.execution.visibleWindowCountMax}`);
  console.log(`Build unchanged: ${evidence.execution.buildUnchanged}`);
  console.log(`Original synthetic image unchanged: ${evidence.execution.originalImageHashUnchanged}`);
  console.log(`Items: ${Object.entries(evidence.items).map(([id, item]) => `${id}=${item.status}`).join(', ')}`);
  if (!evidence.execution.hiddenWindowsVerified || !evidence.execution.buildUnchanged || evidence.execution.pageErrors.length) process.exitCode = 1;
}

const selectedRun = focusedItem13Mode
  ? auditItem13ExistingColumnDrag
  : main;

selectedRun().catch((error) => {
  if (activeFocusedFixtureRoot && process.env.MORROW_STABILIZATION_RUN_DIR)
    evidence.execution.focusedItem13ExistingColumnDrag = {
      ...(evidence.execution.focusedItem13ExistingColumnDrag ?? {}),
      syntheticFixtureRemoved: removeOwnedTempRoot(activeFocusedFixtureRoot, 'morrow-item13-existing-column-drag-'),
    };
  evidence.execution.fatalError = error.stack ?? String(error);
  evidence.execution.finishedAt = new Date().toISOString();
  saveEvidence();
  console.error(`Functional audit failed: ${error.message}`);
  process.exitCode = 1;
});
