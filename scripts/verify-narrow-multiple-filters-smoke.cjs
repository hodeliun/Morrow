'use strict';

const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRelative, runPath } = require('./stabilization-1.1.1-audit-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const profileDir = path.resolve(process.argv[2] ?? '');
const outputPath = runPath(
  path.join('audit', 'narrow-multiple-filters-smoke.json'),
  path.join(projectRoot, 'docs', 'evidence', 'narrow-multiple-filters-smoke.json'),
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

async function switchTheme(page, desiredTheme) {
  const current = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  let changedByUi = false;
  if (current !== desiredTheme) {
    await page.keyboard.press('Control+p');
    const paletteInput = page.locator('.palette-input');
    await paletteInput.waitFor({ state: 'visible' });
    await paletteInput.fill('theme');
    const themeAction = page.locator('.palette-item').filter({ hasText: /Alternar tema claro ou escuro|Switch light or dark theme/i }).first();
    await themeAction.waitFor({ state: 'visible' });
    await themeAction.click();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, desiredTheme);
    changedByUi = true;
  }
  const finalTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  return { initialTheme: current, finalTheme, changedByUi };
}

async function main() {
  assert.ok(profileDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'The profile must be under the OS temporary directory.');
  assert.ok(fs.existsSync(path.join(profileDir, 'vaults.json')), 'Expected an isolated synthetic profile.');
  assert.ok(process.env.MORROW_STABILIZATION_RUN_DIR, 'Set MORROW_STABILIZATION_RUN_DIR to the unique audit directory.');

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const projectHead = require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(projectHead, process.env.MORROW_AUDIT_EXPECTED_HEAD ?? projectHead);
  assert.equal(packageJson.version, process.env.MORROW_AUDIT_EXPECTED_VERSION ?? packageJson.version);

  const report = {
    audit: 'Narrow viewport quick-filter interaction with two simultaneous filters',
    runAt: new Date().toISOString(),
    projectHead,
    packageVersion: packageJson.version,
    fixture: 'synthetic-only',
    viewport: { width: 800, height: 600 },
    checks: {},
    rendererPageErrors: [],
  };
  const buildBefore = buildIdentity();
  let app = null;
  let stage = 'launch';
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => report.rendererPageErrors.push({ stage, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await assertHidden(app);
    report.checks.theme = await switchTheme(page, 'light');

    stage = 'open-table-and-first-filter';
    await openPage(page, 'Financeiro');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
    await assertHidden(app);
    report.checks.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const database = page.locator('.database').first();
    await database.locator('.db-filter-chip-add').click();
    await database.locator('.db-filter-chip').nth(0).click();
    let popover = page.locator('.db-panel').last();
    await popover.waitFor({ state: 'visible' });
    await popover.getByLabel(/Propriedade|Property/i).selectOption('category');
    await popover.getByLabel(/Condição|Condition/i).selectOption('is');
    await popover.getByLabel(/^Valor|^Value/i).selectOption('opt-infra');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 2);
    const firstFilterRows = await database.locator('.db-table tbody tr').allInnerTexts();

    stage = 'add-second-filter';
    await database.locator('.db-filter-chip-add').click();
    await database.locator('.db-filter-chip').nth(1).click();
    popover = page.locator('.db-panel').last();
    await popover.waitFor({ state: 'visible' });
    await popover.getByLabel(/Propriedade|Property/i).selectOption('title');
    await popover.getByLabel(/^Valor|^Value/i).fill('Gama');
    const secondPopover = await popover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    const matchingRows = await database.locator('.db-table tbody tr').allInnerTexts();
    const filterBar = await database.locator('.db-filter-bar').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const chips = [...element.querySelectorAll('.db-filter-chip')].map((chip) => {
        const box = chip.getBoundingClientRect();
        return {
          text: chip.innerText,
          x: Math.round(box.x),
          y: Math.round(box.y),
          right: Math.round(box.right),
          bottom: Math.round(box.bottom),
          insideBar: box.left >= rect.left - 1 && box.right <= rect.right + 1 && box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1,
        };
      });
      const state = element.parentElement?.querySelector('.db-filter-state');
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        chips,
        filterStateVisible: Boolean(state && state.getBoundingClientRect().width),
        filterStateText: state?.innerText ?? '',
      };
    });
    const activeOptionsButton = database.locator('.db-options-button');
    report.checks.activeOptionsLabel = await activeOptionsButton.getAttribute('aria-label');
    report.checks.twoQuickFiltersMatchExpectedRows = firstFilterRows.length === 2 &&
      firstFilterRows.some((row) => row.includes('Alfa')) && firstFilterRows.some((row) => row.includes('Gama')) &&
      matchingRows.length === 1 && matchingRows[0].includes('Gama') && !matchingRows[0].includes('Alfa');
    report.checks.narrowFilterControls = {
      filterCount: await database.locator('.db-filter-chip').count(),
      filterBar,
      secondPopover,
      rowsAfterOneFilter: firstFilterRows.length,
      rowsAfterTwoFilters: matchingRows.length,
      filtersFitWithoutOverflow: filterBar.clientWidth > 0 && filterBar.scrollWidth <= filterBar.clientWidth + 2 &&
        filterBar.chips.length === 2 && filterBar.chips.every((chip) => chip.insideBar),
      filterStateVisible: filterBar.filterStateVisible && /ativos|active/i.test(filterBar.filterStateText),
      filterPopoverInsideViewport: secondPopover.insideViewport,
    };
    report.checks.filterResetRestoresAllRows = false;
    const resetButton = database.locator('.db-filter-reset');
    await resetButton.waitFor({ state: 'visible' });
    await resetButton.click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    report.checks.filterResetRestoresAllRows = await database.locator('.db-table tbody tr').count() === 3 &&
      await database.locator('.db-filter-chip').count() === 0;
    report.checks.hiddenWindowsVerified = true;
    await assertHidden(app);
  } catch (error) {
    report.error = { stage, message: error.stack ?? String(error) };
  } finally {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
    report.buildBefore = buildBefore;
    report.buildAfter = buildIdentity();
    report.buildUnchanged = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter);
    report.rendererPageErrorsVerified = report.rendererPageErrors.length === 0;
    report.checks.buildUnchanged = report.buildUnchanged;
    report.checks.rendererPageErrorsVerified = report.rendererPageErrorsVerified;
    const narrowChecks = report.checks.narrowFilterControls ?? {};
    const requiredChecks = [
      report.checks.theme?.finalTheme === 'light',
      report.checks.viewport?.width === 800 && report.checks.viewport?.height === 600,
      report.checks.twoQuickFiltersMatchExpectedRows === true,
      narrowChecks.filterCount === 2 && narrowChecks.filtersFitWithoutOverflow && narrowChecks.filterStateVisible && narrowChecks.filterPopoverInsideViewport,
      report.checks.filterResetRestoresAllRows === true,
      report.checks.hiddenWindowsVerified === true,
      report.checks.buildUnchanged === true,
      report.checks.rendererPageErrorsVerified === true,
    ];
    report.status = requiredChecks.every(Boolean) ? 'pass' : 'partial';
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
