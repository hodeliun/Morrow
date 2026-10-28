'use strict';

const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRelative, removeOwnedTempRoot, runPath } = require('./stabilization-1.1.1-audit-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputPath = runPath(
  path.join('audit', 'item6-cell-keyboard-clipboard.json'),
  path.join(projectRoot, 'docs', 'evidence', 'item6-cell-keyboard-clipboard.json'),
);

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

async function assertHidden(app) {
  const visibleWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  assert.equal(visibleWindows, 0, 'The application must remain hidden during this audit.');
}

async function openPage(page, title) {
  const rows = page.locator('.tree-row, .link-row');
  let found = null;
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    if ((await row.innerText()).split('\n')[0].trim() === title) {
      found = row;
      break;
    }
  }
  assert.ok(found, `Synthetic page ${title} must appear in the navigation.`);
  await found.click();
  await page.waitForFunction((expected) => document.querySelector('main')?.innerText.includes(expected), title);
  await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
}

async function waitForMarkdown(vaultDir, relativePath, predicate, label) {
  const absolutePath = path.join(vaultDir, relativePath);
  const deadline = Date.now() + 8000;
  let contents = '';
  while (Date.now() < deadline) {
    contents = fs.readFileSync(absolutePath, 'utf8');
    if (predicate(contents)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.fail(`Timed out waiting for ${label} in synthetic Markdown.`);
}

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(sourceRoot.startsWith(`${tempRoot}${path.sep}`), 'The source fixture must be in the OS temporary directory.');
  assert.ok(fs.existsSync(path.join(sourceRoot, 'profile', 'vaults.json')) && fs.existsSync(path.join(sourceRoot, 'vault', 'Financeiro.md')),
    'Expected a retained synthetic delivery2 ticket-39 fixture.');
  assert.ok(process.env.MORROW_STABILIZATION_RUN_DIR, 'Set MORROW_STABILIZATION_RUN_DIR to the unique audit directory.');

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const projectHead = require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(projectHead, process.env.MORROW_AUDIT_EXPECTED_HEAD ?? projectHead);
  assert.equal(packageJson.version, process.env.MORROW_AUDIT_EXPECTED_VERSION ?? packageJson.version);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-cell-keyboard-clipboard-'));
  const profileDir = path.join(root, 'profile');
  const vaultDir = path.join(root, 'vault');
  fs.cpSync(path.join(sourceRoot, 'profile'), profileDir, { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'vault'), vaultDir, { recursive: true });
  const registryPath = path.join(profileDir, 'vaults.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.current = vaultDir;
  registry.recent = (registry.recent ?? []).map((entry) => ({ ...entry, path: vaultDir }));
  fs.writeFileSync(registryPath, JSON.stringify(registry));

  const databasePath = path.join(vaultDir, 'Financeiro.md');
  const originalProperty = '    - id: amount\n      name: Valor\n      type: number\n';
  let databaseMarkdown = fs.readFileSync(databasePath, 'utf8');
  assert.ok(databaseMarkdown.includes(originalProperty), 'Expected a synthetic number property named Valor.');
  databaseMarkdown = databaseMarkdown.replace(
    originalProperty,
    `${originalProperty}    - id: amount2\n      name: Segundo valor\n      type: number\n`,
  );
  fs.writeFileSync(databasePath, databaseMarkdown);

  const report = {
    audit: 'Original item 6 focused cell keyboard, edit, clipboard and undo smoke',
    runAt: new Date().toISOString(),
    projectHead,
    packageVersion: packageJson.version,
    fixture: 'synthetic-only',
    fixtureRoot: path.basename(root),
    rendererPageErrors: [],
    checks: {},
  };
  const buildBefore = buildIdentity();
  let app = null;
  let page = null;
  let stage = 'launch';
  const launch = async (phase) => {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => report.rendererPageErrors.push({ stage: phase, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await assertHidden(app);
  };

  try {
    await launch(stage);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const table = page.locator('.database .db-table').first();
    const row0 = table.locator('tbody tr').nth(0);
    const row1 = table.locator('tbody tr').nth(1);
    const amount0 = row0.locator('td[data-col-id="amount"]');
    const amount1 = row1.locator('td[data-col-id="amount"]');
    const amount2_0 = row0.locator('td[data-col-id="amount2"]');

    stage = 'arrow-and-tab-navigation';
    await amount0.click();
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount"]')?.classList.contains('is-grid-active'));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:nth-child(2) td[data-col-id="amount"]')?.classList.contains('is-grid-active'));
    const arrowDownMovedToNextRow = await amount1.evaluate((cell) => cell.classList.contains('is-grid-active'));
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount"]')?.classList.contains('is-grid-active'));
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount2"]')?.classList.contains('is-grid-active'));
    const tabMovedToNextCell = await amount2_0.evaluate((cell) => cell.classList.contains('is-grid-active'));
    report.checks.keyboardNavigation = { arrowDownMovedToNextRow, tabMovedToNextCell };

    stage = 'enter-edit-tab-commit';
    await amount0.click();
    await page.keyboard.press('Enter');
    const amountEditor = amount0.locator('input[type="number"]');
    await amountEditor.waitFor({ state: 'visible' });
    await amountEditor.fill('111');
    await amountEditor.press('Tab');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount"]')?.innerText.trim() === '111');
    const editedCellPersisted = (await amount0.innerText()).trim() === '111';
    const nextCellAfterCommit = await amount2_0.evaluate((cell) => cell.classList.contains('is-grid-active'));
    const alphaMarkdownAfterEdit = await waitForMarkdown(vaultDir, path.join('Financeiro', 'Alfa.md'),
      (contents) => /Valor:\s*111\b/.test(contents), 'cell edit persistence');
    report.checks.cellEdit = {
      enteredEditMode: true,
      committedWithTab: editedCellPersisted,
      tabMovedToNextCell: nextCellAfterCommit,
      markdownSaved: /Valor:\s*111\b/.test(alphaMarkdownAfterEdit),
    };

    stage = 'cell-copy-paste-undo';
    await amount0.click();
    await page.keyboard.press('Control+c');
    const clipboardText = await page.evaluate(async () => navigator.clipboard?.readText?.() ?? '');
    await amount2_0.click();
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount2"]')?.innerText.trim() === '111');
    const pastedCellValue = (await amount2_0.innerText()).trim();
    const rowCountAfterPaste = await table.locator('tbody tr').count();
    const alphaMarkdownAfterPaste = await waitForMarkdown(vaultDir, path.join('Financeiro', 'Alfa.md'),
      (contents) => /Segundo valor:\s*111\b/.test(contents), 'cell clipboard paste persistence');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr:first-child td[data-col-id="amount2"]')?.innerText.trim() !== '111');
    const clipboardUndoRestored = (await amount2_0.innerText()).trim() !== '111';
    const amountCellStillPreserved = (await amount0.innerText()).trim() === '111';
    await waitForMarkdown(vaultDir, path.join('Financeiro', 'Alfa.md'),
      (contents) => /Valor:\s*111\b/.test(contents) && !/Segundo valor:\s*111\b/.test(contents), 'undo preserves source cell');
    report.checks.cellClipboard = {
      copyProducedValue: clipboardText.trim() === '111',
      pastedValue: pastedCellValue,
      destinationSaveConfirmed: /Segundo valor:\s*111\b/.test(alphaMarkdownAfterPaste),
      rowsPreserved: rowCountAfterPaste === 3,
      undoRestoredDestination: clipboardUndoRestored,
      sourceValuePreserved: amountCellStillPreserved,
      status: clipboardText.trim() === '111' && pastedCellValue === '111' && clipboardUndoRestored && amountCellStillPreserved && rowCountAfterPaste === 3
        ? 'pass'
        : 'fail',
    };
    await assertHidden(app);
    await app.close();
    app = null;

    stage = 'reopen-persistence';
    await launch(stage);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const reopenedAmount = await page.locator('.database .db-table tbody tr').first().locator('td[data-col-id="amount"]').innerText();
    const reopenedAmount2 = await page.locator('.database .db-table tbody tr').first().locator('td[data-col-id="amount2"]').innerText();
    report.checks.reopenPersistedEditAndUndo = reopenedAmount.trim() === '111' && reopenedAmount2.trim() !== '111';
    await assertHidden(app);
  } catch (error) {
    report.error = { stage, message: error.stack ?? String(error) };
  } finally {
    if (app) await app.close().catch(() => {});
    report.buildBefore = buildBefore;
    report.buildAfter = buildIdentity();
    report.buildUnchanged = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
    report.hiddenWindowsVerified = report.checks.keyboardNavigation?.arrowDownMovedToNextRow === true &&
      report.rendererPageErrors.length === 0 && report.buildUnchanged;
    report.rendererPageErrorsVerified = report.rendererPageErrors.length === 0;
    report.syntheticFixtureRemoved = removeOwnedTempRoot(root, 'morrow-cell-keyboard-clipboard-');
    const checksPassed = report.checks.keyboardNavigation?.arrowDownMovedToNextRow === true &&
      report.checks.keyboardNavigation?.tabMovedToNextCell === true &&
      report.checks.cellEdit?.enteredEditMode === true &&
      report.checks.cellEdit?.committedWithTab === true &&
      report.checks.cellEdit?.markdownSaved === true &&
      report.checks.cellClipboard?.status === 'pass' &&
      report.checks.reopenPersistedEditAndUndo === true &&
      report.hiddenWindowsVerified && report.rendererPageErrorsVerified && report.syntheticFixtureRemoved;
    report.status = checksPassed ? 'pass' : 'partial';
    report.evidencePath = projectRelative(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
