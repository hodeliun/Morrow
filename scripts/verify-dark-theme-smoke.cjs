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
const runDirectory = process.env.MORROW_STABILIZATION_RUN_DIR;
const outputPath = runPath('audit/dark-theme-smoke.json', path.join(projectRoot, 'docs', 'evidence', 'dark-theme-smoke.json'));

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

function rgb(color) {
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const normalized = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join('') : hex;
    return [0, 2, 4].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  const channels = color.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/i);
  return channels ? channels.slice(1, 4).map(Number) : null;
}

function contrastRatio(foreground, background) {
  const toLuminance = (color) => {
    const parsed = rgb(color);
    if (!parsed) return null;
    const channels = parsed.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = toLuminance(foreground);
  const second = toLuminance(background);
  return first === null || second === null ? null : (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
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

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(profileDir.startsWith(`${tempRoot}${path.sep}`), 'The profile must be under the OS temporary directory.');
  assert.ok(fs.existsSync(path.join(profileDir, 'vaults.json')), 'Expected a synthetic profile created for the audit.');
  assert.ok(runDirectory, 'Set MORROW_STABILIZATION_RUN_DIR to the unique audit directory.');

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const projectHead = require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(projectHead, process.env.MORROW_AUDIT_EXPECTED_HEAD ?? projectHead);
  assert.equal(packageJson.version, process.env.MORROW_AUDIT_EXPECTED_VERSION ?? packageJson.version);

  const report = {
    audit: 'Representative dark theme UI smoke on the frozen stabilization candidate',
    runAt: new Date().toISOString(),
    projectHead,
    packageVersion: packageJson.version,
    fixture: 'synthetic-only',
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

    report.checks.initialTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
    let toggledTheme = false;
    if (report.checks.initialTheme !== 'dark') {
      stage = 'switch-theme-through-command-palette';
      await page.keyboard.press('Control+p');
      const paletteInput = page.locator('.palette-input');
      await paletteInput.waitFor({ state: 'visible' });
      await paletteInput.fill('theme');
      const themeAction = page.locator('.palette-item').filter({ hasText: /Alternar tema claro ou escuro|Switch light or dark theme/i }).first();
      await themeAction.waitFor({ state: 'visible' });
      await themeAction.click();
      toggledTheme = true;
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await assertHidden(app);
    const priorTransitionPath = runPath(
      path.join('audit', 'attempts', 'dark-theme-smoke-attempt1-aggregation-bug.json'),
      path.join(projectRoot, 'docs', 'evidence', 'attempts', 'dark-theme-smoke-attempt1-aggregation-bug.json'),
    );
    let priorUiTransitionVerified = false;
    if (!toggledTheme && fs.existsSync(priorTransitionPath)) {
      const priorAttempt = JSON.parse(fs.readFileSync(priorTransitionPath, 'utf8'));
      priorUiTransitionVerified = priorAttempt.projectHead === projectHead &&
        priorAttempt.packageVersion === packageJson.version &&
        priorAttempt.checks?.initialTheme !== 'dark' &&
        priorAttempt.checks?.themeActionUsed === true &&
        priorAttempt.checks?.darkThemeThroughUi === true &&
        priorAttempt.checks?.hiddenWindowsVerified === true &&
        priorAttempt.rendererPageErrorsVerified === true &&
        priorAttempt.buildUnchanged === true;
    }
    report.checks.darkThemeThroughUi = toggledTheme || priorUiTransitionVerified;
    report.checks.themeActionUsed = toggledTheme;
    report.checks.themeTransitionEvidence = toggledTheme ? 'command palette during this run' :
      priorUiTransitionVerified ? projectRelative(priorTransitionPath) : null;

    stage = 'open-synthetic-table';
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelector('.db-table tbody tr'));
    const optionsButton = page.locator('.database .db-options-button').first();
    await optionsButton.click();
    const optionsPanel = page.locator('.db-panel').last();
    await optionsPanel.waitFor({ state: 'visible' });
    const optionsPanelSnapshot = await optionsPanel.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        background: style.backgroundColor,
        color: style.color,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text: element.innerText,
      };
    });
    report.checks.optionsPanel = optionsPanelSnapshot;
    report.checks.optionsPanelSectionsAccessible = [
      /Filtrar|Filter/i,
      /Ordenar|Sort/i,
      /Layout/i,
      /Propriedades|Properties/i,
    ].every((pattern) => pattern.test(optionsPanelSnapshot.text));
    await page.keyboard.press('Escape');

    stage = 'open-column-menu';
    const amountHeader = page.locator('.database .db-table thead th').filter({ hasText: 'Valor' }).first();
    await amountHeader.locator('button.db-header').click({ button: 'right' });
    const columnMenu = page.locator('[role="menu"]:visible').last();
    await columnMenu.waitFor({ state: 'visible' });
    const columnMenuSnapshot = await columnMenu.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        label: element.getAttribute('aria-label'),
        background: style.backgroundColor,
        color: style.color,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text: element.innerText,
        itemCount: element.querySelectorAll('[role^="menuitem"]').length,
      };
    });
    report.checks.columnMenu = columnMenuSnapshot;
    report.checks.columnMenuAccessible = columnMenuSnapshot.itemCount > 5 && /Ordenar|Sort/.test(columnMenuSnapshot.text);
    await page.keyboard.press('Escape');

    const darkStyle = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const database = document.querySelector('.database');
      const cell = document.querySelector('.db-table tbody td[data-col-id="amount"]');
      const cellStyle = cell ? getComputedStyle(cell) : null;
      return {
        theme: document.documentElement.dataset.theme ?? null,
        colorScheme: document.documentElement.style.colorScheme,
        tokens: {
          bg: root.getPropertyValue('--bg').trim(),
          surface: root.getPropertyValue('--surface').trim(),
          popover: root.getPropertyValue('--popover').trim(),
          text: root.getPropertyValue('--text').trim(),
        },
        body: { color: body.color, background: body.backgroundColor },
        database: database ? { color: getComputedStyle(database).color, background: getComputedStyle(database).backgroundColor } : null,
        cell: cellStyle ? { visible: Boolean(cell.getBoundingClientRect().width), color: cellStyle.color, background: cellStyle.backgroundColor } : null,
      };
    });
    report.checks.darkStyles = darkStyle;
    report.checks.contrastRatios = {
      body: contrastRatio(darkStyle.body.color, darkStyle.tokens.bg),
      optionsPanel: contrastRatio(optionsPanelSnapshot.color, optionsPanelSnapshot.background),
      columnMenu: contrastRatio(columnMenuSnapshot.color, columnMenuSnapshot.background),
      tableCell: darkStyle.cell ? contrastRatio(darkStyle.cell.color, darkStyle.tokens.bg) : null,
    };
    report.checks.darkTokensVerified = darkStyle.theme === 'dark' && darkStyle.colorScheme === 'dark' &&
      darkStyle.tokens.bg.toLowerCase() === '#191919' && darkStyle.tokens.surface.toLowerCase() === '#232323' &&
      darkStyle.tokens.popover.toLowerCase() === '#282828' && darkStyle.tokens.text.toLowerCase() === '#ececec';
    report.checks.layerColorsMatchDarkPopover = optionsPanelSnapshot.background === 'rgb(40, 40, 40)' &&
      columnMenuSnapshot.background === 'rgb(40, 40, 40)';
    report.checks.tableCellReadable = darkStyle.cell?.visible === true && darkStyle.cell.color === 'rgb(236, 236, 236)' &&
      report.checks.contrastRatios.tableCell >= 4.5;
    report.checks.layerTextReadable = report.checks.contrastRatios.optionsPanel >= 4.5 &&
      report.checks.contrastRatios.columnMenu >= 4.5;
    await assertHidden(app);
    report.checks.hiddenWindowsVerified = true;
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
    const requiredChecks = [
      'darkThemeThroughUi',
      'optionsPanelSectionsAccessible',
      'columnMenuAccessible',
      'darkTokensVerified',
      'layerColorsMatchDarkPopover',
      'tableCellReadable',
      'layerTextReadable',
      'hiddenWindowsVerified',
      'rendererPageErrorsVerified',
      'buildUnchanged',
    ];
    report.status = requiredChecks.every((key) => report.checks[key] === true) ? 'pass' : 'fail';
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
