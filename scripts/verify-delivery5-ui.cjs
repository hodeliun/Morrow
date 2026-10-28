const {
  _electron,
} = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROW_CLIPBOARD_PREFIX = 'morrow-row-clipboard:v1\n';
const diagnosticMode = process.env.MORROW_DELIVERY5_DIAGNOSTIC === '1';
const propertyLimitGuardIncludedInTestedBuild =
  process.env.MORROW_DELIVERY5_PROPERTY_LIMIT_GUARD_BUILT === '1';
const evidenceDirectory = path.resolve(
  process.env.MORROW_EVIDENCE_DIR ?? path.join(process.cwd(), 'docs', 'evidence', 'stabilization-1.1.1'),
);

let currentStage = 'fixture-setup';
let currentStageStartedAt = Date.now();

function markStage(name) {
  currentStage = name;
  currentStageStartedAt = Date.now();
  console.log(`Delivery 5 stage: ${name}`);
}

function relativeStack(error) {
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const repoRoot = path.resolve(process.cwd());
  return stack
    .replaceAll(`${repoRoot}${path.sep}`, '')
    .replaceAll(`${repoRoot}/`, '')
    .replaceAll(`${repoRoot}\\`, '')
    .replaceAll('\\', '/');
}

function relativeStackLocation(error) {
  const stack = relativeStack(error);
  return stack
    .split(/\r?\n/)
    .find((line) => line.includes('verify-delivery5-ui.cjs:'))
    ?.trim();
}

async function captureFailureState(page, vaultDir) {
  let ui = null;
  if (page) {
    try {
      ui = await page.evaluate(() => {
        return {
          url: location.href,
          activeElement:
            document.activeElement instanceof HTMLElement
              ? `${document.activeElement.tagName.toLowerCase()}.${String(document.activeElement.className)}`
              : null,
          tables: [...document.querySelectorAll('.db-table')].map((table) => ({
            rows: table.querySelectorAll('tbody tr').length,
            titles: [...table.querySelectorAll('tbody tr .db-col-title')]
              .map((cell) => cell.textContent?.trim() ?? '')
              .slice(0, 8),
          })),
          dialogs: [...document.querySelectorAll('.db-row-dialog, [role="alertdialog"]')]
            .map((element) => element.textContent?.trim().slice(0, 120) ?? '')
            .slice(0, 3),
          recovery: [...document.querySelectorAll('.table-action-recovery')]
            .map((element) => element.textContent?.trim().slice(0, 120) ?? '')
            .slice(0, 3),
          toasts: [...document.querySelectorAll('.toast')]
            .map((element) => element.textContent?.trim().slice(0, 120) ?? '')
            .slice(0, 5),
          actionObservations: Array.isArray(window.__delivery5ActionObservations)
            ? window.__delivery5ActionObservations.slice(-12)
            : [],
        };
      });
    } catch {
      ui = { readFailed: true };
    }
  }

  const journalPath = path.join(vaultDir, '.morrow', 'table-action-journal.json');
  let journal = null;
  if (fs.existsSync(journalPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal = {
        status: raw.status,
        databaseId: raw.databaseId,
        rowId: raw.rowId,
        label: raw.label,
        createdAt: raw.createdAt,
        recordCount: Array.isArray(raw.records) ? raw.records.length : null,
        commandCount: Array.isArray(raw.commands) ? raw.commands.length : null,
        conflictCount: Array.isArray(raw.conflicts) ? raw.conflicts.length : null,
        error: raw.error,
      };
    } catch {
      journal = { readFailed: true };
    }
  }

  return {
    stage: currentStage,
    stageElapsedMs: Date.now() - currentStageStartedAt,
    ui,
    journal,
  };
}

function databaseMarkdown(properties, viewId, hidden = [], title = null) {
  const hiddenLines = hidden.length
    ? `      hidden:\n${hidden.map((id) => `        - ${id}`).join('\n')}\n`
    : '';
  const pageTitle = title ?? (viewId === 'source-grid' ? 'Source' : viewId === 'destination-grid' ? 'Destination' : 'Empty');
  return `---
kind: database
database:
  properties:
${properties}
  views:
    - id: ${viewId}
      name: Tabela
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
${hiddenLines}---
# ${pageTitle}
`;
}

function sourceRow({ title, amount, notes, active, secret }) {
  const frontmatter = [
    '---',
    ...(amount === null ? [] : [`Quantidade: ${amount}`]),
    `Notas: "${notes}"`,
    `Ativo: ${active}`,
    `Segredo: "${secret}"`,
    '---',
  ];
  return `${frontmatter.join('\n')}\n# ${title}\n\nCorpo de conteúdo completo da ${title}.\n`;
}

async function launchHidden(profileDir) {
  return _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['dist-electron/main.cjs'],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      MORROW_HIDDEN: '1',
      MORROW_USER_DATA: profileDir,
    },
  });
}

async function visibleRows(page) {
  return page
    .locator('.db-table tbody tr')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('.db-col-title')?.textContent?.trim() ?? ''));
}

function readActionJournal(vaultDir) {
  const journalPath = path.join(vaultDir, '.morrow', 'table-action-journal.json');
  if (!fs.existsSync(journalPath)) return null;
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  return {
    id: journal.id,
    status: journal.status,
    label: journal.label,
    error: journal.error,
  };
}

function buildIdentity() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const rendererDir = path.join(process.cwd(), 'dist', 'assets');
  const rendererAssets = fs
    .readdirSync(rendererDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => ({
      name,
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(rendererDir, name)))
          .digest('hex'),
    }));
  let source = null;
  try {
    source = {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
      worktreeDirty:
        execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8' }).trim() !== '',
    };
  } catch {
    source = { revision: null, worktreeDirty: null };
  }
  return {
    version: packageJson.version,
    source,
    electronMainSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(process.cwd(), 'dist-electron', 'main.cjs')))
      .digest('hex'),
    rendererAssets,
  };
}

function waitForFileText(filePath, predicate, description, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(text);
    };
    const check = () => {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        if (predicate(text)) finish(null, text);
      } catch {
        // The directory watcher will check again when the save creates or replaces the file.
      }
    };
    const watcher = fs.watch(path.dirname(filePath), (_event, changedName) => {
      if (
        !changedName ||
        changedName.toString().toLowerCase() === path.basename(filePath).toLowerCase()
      )
        check();
    });
    timer = setTimeout(
      () => finish(new Error(`${description} was not saved within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    check();
  });
}

function databasePropertyBlock(markdown, propertyId) {
  const lines = markdown.split(/\r?\n/);
  const idLine = /^\s{4}- id:\s*(.+?)\s*$/;
  const start = lines.findIndex((line) => idLine.exec(line)?.[1] === propertyId);
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s{4}- id:\s/.test(lines[index]) || /^\s{2}views:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

async function openTable(page, title) {
  await page.evaluate((target) => {
    const link = [...document.querySelectorAll('.tree-row, .link-row')].find((item) =>
      item.textContent?.includes(target),
    );
    if (!link) throw new Error(`Could not find the synthetic database “${target}”.`);
    link.click();
  }, title);
  await page.waitForSelector('.db-table', { timeout: 15000 });
  await page.waitForTimeout(200);
}

async function clickMenuItem(page, pattern) {
  const menu = page.locator('[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  const items = menu.locator('[role="menuitem"]');
  for (let index = 0; index < (await items.count()); index++) {
    const item = items.nth(index);
    const text = (await item.innerText()).trim();
    if (pattern.test(text)) {
      await item.click();
      return text;
    }
  }
  throw new Error(`Could not find a matching row-menu item: ${pattern}`);
}

async function focusPrimaryByTab(page, dialog) {
  const primary = dialog.locator('.db-row-dialog-actions .button.primary');
  for (let index = 0; index < 20; index++) {
    if (await primary.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
    assert.equal(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
      'Tab must stay inside the row dialog.',
    );
  }
  throw new Error('Keyboard navigation did not reach the row dialog confirmation button.');
}

async function main() {
  const currentBuildIdentity = buildIdentity();
  const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-delivery5-ui-'));
  const tempRoot = path.resolve(root);
  assert.ok(
    tempRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) &&
      path.basename(tempRoot).startsWith('morrow-delivery5-ui-'),
    'Temporary profile and vault must stay in the unique synthetic test directory.',
  );
  const profileDir = path.join(root, 'profile');
  const vaultDir = path.join(root, 'vault');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(vaultDir);
  fs.writeFileSync(
    path.join(profileDir, 'vaults.json'),
    JSON.stringify({ current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] }),
  );

  const properties = `    - id: amount
      name: Quantidade
      type: number
    - id: notes
      name: Notas
      type: text
    - id: active
      name: Ativo
      type: checkbox
    - id: secret
      name: Segredo
      type: text
`;
  const destinationProperties = `    - id: notes-destination
      name: Notas
      type: text
    - id: amount-destination
      name: Quantidade
      type: number
      defaultValue: 5
`;
  const emptyProperties = `    - id: amount-empty
      name: Quantidade
      type: number
      defaultValue: 7
    - id: notes-empty
      name: Notas
      type: text
`;
  const relationSourceProperties = `    - id: author
      name: Author
      type: relation
      relation:
        targetDatabaseId: null
        multiple: false
        isInverse: false
        displayPropertyId: null
        inversePropertyId: null
        filters: []
`;
  const relationTargetProperties = `    - id: author-name
      name: Name
      type: text
`;
  fs.mkdirSync(path.join(vaultDir, '.morrow'));
  fs.mkdirSync(path.join(vaultDir, 'Source', 'Alpha'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'Destination'));
  fs.mkdirSync(path.join(vaultDir, 'Books'));
  fs.mkdirSync(path.join(vaultDir, 'Authors'));
  fs.writeFileSync(
    path.join(vaultDir, '.morrow', 'workspace.json'),
    JSON.stringify({
      pages: {
        'Source.md': { id: 'source-db' },
        'Source/Alpha.md': { id: 'source-alpha' },
        'Source/Beta.md': { id: 'source-beta' },
        'Source/Gamma.md': { id: 'source-gamma' },
        'Source/Alpha/Details.md': { id: 'alpha-details' },
        'Destination.md': { id: 'destination-db' },
        'Destination/Existing.md': { id: 'destination-existing' },
        'Empty.md': { id: 'empty-db' },
        'Books.md': { id: 'books-db' },
        'Books/Earthsea.md': { id: 'book-earthsea' },
        'Authors.md': { id: 'authors-db' },
        'Authors/Le Guin.md': { id: 'author-le-guin' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Source.md'),
    databaseMarkdown(properties, 'source-grid', ['secret']),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Destination.md'),
    databaseMarkdown(destinationProperties, 'destination-grid'),
    'utf8',
  );
  fs.writeFileSync(path.join(vaultDir, 'Empty.md'), databaseMarkdown(emptyProperties, 'empty-grid'), 'utf8');
  fs.writeFileSync(
    path.join(vaultDir, 'Books.md'),
    databaseMarkdown(relationSourceProperties, 'books-grid', [], 'Books'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Authors.md'),
    databaseMarkdown(relationTargetProperties, 'authors-grid', [], 'Authors'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Source', 'Alpha.md'),
    sourceRow({ title: 'Alpha', amount: 10, notes: 'Nota Alpha', active: false, secret: 'segredo alpha' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Source', 'Beta.md'),
    sourceRow({ title: 'Beta', amount: 0, notes: 'Nota Beta', active: true, secret: 'segredo beta' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Source', 'Gamma.md'),
    sourceRow({ title: 'Gamma', amount: null, notes: 'Nota Gamma', active: false, secret: 'segredo gamma' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Source', 'Alpha', 'Details.md'),
    '---\n---\n# Details\n\nConteúdo aninhado sintético.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Destination', 'Existing.md'),
    '---\nNotas: existente\nQuantidade: 100\n---\n# Existing\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Books', 'Earthsea.md'),
    '---\nAuthor: "Le Guin"\n---\n# Earthsea\n\nExisting legacy relation link.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Authors', 'Le Guin.md'),
    '---\n---\n# Le Guin\n',
    'utf8',
  );

  let app = null;
  let page = null;
  const pageErrors = [];
  let evidencePath = null;
  let evidenceSaved = false;
  let runSucceeded = false;
  const evidence = {
    timestamp: new Date().toISOString(),
    runId,
    fixture: 'synthetic-only',
    buildIdentity: currentBuildIdentity,
    hiddenWindowVerified: false,
    ticket35: {},
    ticket36: {},
    ticket46: {
      maxPropertyGuardIncludedInTestedBuild: propertyLimitGuardIncludedInTestedBuild,
    },
    rendererPageErrors: [],
    cleanupVerified: false,
  };
  console.log(`Delivery 5 build identity: ${JSON.stringify(evidence.buildIdentity)}`);

  try {
    markStage('initial-launch');
    console.log('1. Launching hidden Electron app with synthetic profile and vault...');
    app = await launchHidden(profileDir);
    const initiallyHidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(initiallyHidden, true, 'No Electron window may be visible.');
    evidence.hiddenWindowVerified = true;

    markStage('initial-fixture-load');
    page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
    await page.waitForTimeout(2500);
    await openTable(page, 'Source');

    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const initialOrder = await visibleRows(page);
    assert.equal(initialOrder.length, 3, 'The source fixture must have three visible rows.');
    const names = ['Alpha', 'Beta', 'Gamma'];
    for (const name of names) assert.ok(initialOrder.some((title) => title.includes(name)));

    const search = page.locator('.db-search input[type="search"]');
    const headerSelect = page.locator('.db-table thead .db-row-select');
    await search.fill('Gamma');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    await headerSelect.click();
    assert.equal(await page.locator('.db-row-selection-count').count(), 1);
    await search.fill('');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    await page.waitForFunction(() => document.querySelector('.db-row-selection-count') === null);
    evidence.ticket35.filteredSelectionClearsWhenVisibleRowsChange = true;

    const firstSelector = page.locator('.db-table tbody tr').first().locator('.db-row-select');
    await firstSelector.click();
    await page
      .locator('.db-table tbody tr')
      .nth(2)
      .locator('.db-row-select')
      .click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 3);
    evidence.ticket35.shiftRangeSelectionVerified = true;
    await firstSelector.focus();
    await page.keyboard.press('Control+A');
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 3);
    evidence.ticket35.keyboardSelectAllVerified = true;
    await headerSelect.click();
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 0);

    const amountCell = page
      .locator('.db-table tbody tr')
      .filter({ hasText: 'Alpha' })
      .locator('td[data-col-id="amount"]');
    await amountCell.click();
    await page.keyboard.press('Control+C');
    const cellClipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(cellClipboard.includes('10'), 'Grid Ctrl+C must continue copying the active cell value.');
    assert.ok(!cellClipboard.startsWith(ROW_CLIPBOARD_PREFIX));
    evidence.ticket36.cellClipboardRemainsDistinct = true;

    await headerSelect.click();
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 3);
    await page
      .locator('.db-table tbody tr')
      .nth(1)
      .locator('.db-row-select')
      .click({ modifiers: ['Control'] });
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 2);
    await page.waitForFunction(
      () => document.querySelector('.db-table thead .db-row-select')?.indeterminate === true,
    );
    assert.equal(
      await headerSelect.evaluate((element) => element.indeterminate),
      true,
      'The visible-row selector must expose its mixed state.',
    );
    await page
      .locator('.db-table tbody tr')
      .nth(1)
      .locator('.db-row-select')
      .click({ modifiers: ['Control'] });
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 3);
    assert.ok((await page.locator('.db-row-selection-count').innerText()).includes('3'));
    evidence.ticket35.visibleSelectAllAndTriStateVerified = true;

    await page.keyboard.press('Control+C');
    await page.waitForFunction(
      async (prefix) => (await navigator.clipboard.readText()).startsWith(prefix),
      ROW_CLIPBOARD_PREFIX,
    );
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    const payload = JSON.parse(clipboardText.slice(ROW_CLIPBOARD_PREFIX.length));
    const originalRowIds = payload.rows.map((entry) => entry.page.id);
    assert.equal(payload.rows.length, 3, 'Row Ctrl+C must copy all explicitly selected rows.');
    assert.ok(payload.rows.every((entry) => Object.hasOwn(entry.page.properties, 'secret')));
    assert.ok(
      payload.rows.some((entry) => entry.page.properties.amount === 0),
      'Zero must survive row copy.',
    );
    assert.ok(
      payload.rows.some((entry) => entry.page.properties.active === false),
      'False must survive row copy.',
    );
    assert.ok(payload.rows.some((entry) => JSON.stringify(entry.doc).includes('Corpo de conteúdo completo')));
    evidence.ticket36.fullRowClipboardVerified = true;

    const sourceHeaderCount = await page.locator('.db-table thead th').count();
    await page.locator('.db-table .db-col-add button').click();
    const propertyPopover = page.locator('.popover form');
    await propertyPopover.waitFor({ state: 'visible' });
    const propertyName = propertyPopover.locator('input[aria-label]');
    await propertyName.fill('Keyboard paste focus probe');
    const addPropertyButton = propertyPopover.locator('button[type="submit"]');
    await addPropertyButton.focus();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.db-row-dialog').count(), 0);
    assert.equal(await page.locator('.db-table tbody tr').count(), 3);
    assert.equal(await page.locator('.db-table thead th').count(), sourceHeaderCount);
    assert.equal(await propertyName.inputValue(), 'Keyboard paste focus probe');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clipboardText);
    await page.keyboard.press('Escape');
    await propertyPopover.waitFor({ state: 'detached' });
    evidence.ticket36.keyboardPasteIgnoredFromPortaledPropertyPopoverVerified = true;

    await openTable(page, 'Destination');
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 0);
    const destinationCell = page
      .locator('.db-table tbody tr')
      .first()
      .locator('td[data-col-id="amount-destination"]');
    await destinationCell.click();
    assert.equal(
      await destinationCell.evaluate((element) => element === document.activeElement),
      true,
      'Cross-table row paste starts with an active cell and no selected destination rows.',
    );
    await page.keyboard.press('Control+V');
    let dialog = page.locator('.db-row-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await dialog.locator('select[data-autofocus]').inputValue(), 'destination-db');
    const destinationSelect = dialog.locator('select[data-autofocus]');
    assert.equal(await destinationSelect.evaluate((element) => element === document.activeElement), true);
    const destinationMappings = dialog.locator('.db-row-mapping-item select');
    assert.equal(await destinationMappings.nth(0).inputValue(), 'amount-destination');
    assert.equal(await destinationMappings.nth(1).inputValue(), 'notes-destination');
    await destinationSelect.selectOption('empty-db');
    const emptyMappings = dialog.locator('.db-row-mapping-item select');
    assert.equal(await emptyMappings.nth(0).inputValue(), 'amount-empty');
    assert.equal(await emptyMappings.nth(1).inputValue(), 'notes-empty');
    assert.ok((await dialog.locator('.db-row-mapping-source').first().innerText()).includes('7'));
    const secretMapping = dialog
      .locator('.db-row-mapping-item')
      .filter({ hasText: 'Segredo' })
      .locator('select');
    await secretMapping.selectOption('__preserve_as_frontmatter__');
    evidence.ticket36.destinationChangeRecomputesMappings = true;
    evidence.ticket36.emptyDestinationDefaultPreviewVerified = true;

    const primary = dialog.locator('.db-row-dialog-actions .button.primary');
    await primary.focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await dialog.locator('.dialog-close').evaluate((element) => element === document.activeElement),
      true,
      'Tab from the final action must wrap to the first dialog control.',
    );
    await page.keyboard.press('Shift+Tab');
    assert.equal(await primary.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-col-id') === 'amount-destination',
    );
    assert.equal(
      (await visibleRows(page)).length,
      1,
      'Escape must cancel without changing destination rows.',
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clipboardText);
    evidence.ticket36.mappingCancelAndFocusRestoreVerified = true;
    evidence.ticket36.dialogTabContainmentVerified = true;

    await openTable(page, 'Empty');
    assert.equal(await page.locator('.db-table tbody tr').count(), 0);
    const emptyPasteTarget = page.locator('.db-table-view');
    assert.equal(await emptyPasteTarget.getAttribute('role'), 'group');
    await emptyPasteTarget.focus();
    assert.equal(
      await emptyPasteTarget.evaluate((element) => element === document.activeElement),
      true,
      'An empty database must expose a focusable Ctrl+V target.',
    );
    await page.keyboard.press('Control+V');
    dialog = page.locator('.db-row-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await dialog.locator('select[data-autofocus]').inputValue(), 'empty-db');
    assert.equal(await dialog.locator('.db-row-mapping-item select').nth(0).inputValue(), 'amount-empty');
    assert.equal(await dialog.locator('.db-row-mapping-item select').nth(1).inputValue(), 'notes-empty');
    await dialog
      .locator('.db-row-mapping-item')
      .filter({ hasText: 'Segredo' })
      .locator('select')
      .selectOption('__preserve_as_frontmatter__');
    await focusPrimaryByTab(page, dialog);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    evidence.ticket36.keyboardConfirmVerified = true;
    evidence.ticket36.keyboardPasteWithoutDestinationSelectionVerified = true;
    evidence.ticket36.keyboardPasteIntoEmptyTableVerified = true;

    await openTable(page, 'Source');
    await page.locator('.db-table thead .db-row-select').click();
    assert.equal(await page.locator('.db-table tbody tr.is-row-selected').count(), 3);
    await page.keyboard.press('Control+C');
    await page.waitForFunction(
      async (prefix) => (await navigator.clipboard.readText()).startsWith(prefix),
      ROW_CLIPBOARD_PREFIX,
    );
    const sameTableClipboard = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Control+V');
    dialog = page.locator('.db-row-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('.db-row-mapping-item select').nth(0).inputValue(), 'amount');
    await focusPrimaryByTab(page, dialog);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 6);
    const sameTableIds = await page
      .locator('.db-table tbody tr')
      .evaluateAll((items) =>
        items.map((item) => item.querySelector('.db-col-title')?.getAttribute('data-row-id') ?? null),
      );
    const sameTableCopies = sameTableIds.filter((id) => id && !originalRowIds.includes(id));
    assert.equal(sameTableCopies.length, 3, 'Pasting within one table must create fresh row IDs.');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sameTableClipboard);
    const sameTableUndo = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    await sameTableUndo.waitFor({ state: 'visible' });
    await sameTableUndo.click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    evidence.ticket36.sameTablePasteCreatesFreshIdsAndUndoVerified = true;

    await openTable(page, 'Empty');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const copiedTitles = await visibleRows(page);
    for (const name of names) assert.ok(copiedTitles.some((title) => title.includes(name)));
    const emptyFiles = fs.readdirSync(path.join(vaultDir, 'Empty')).filter((name) => name.endsWith('.md'));
    assert.equal(
      emptyFiles.length,
      3,
      'Pasting three rows into the empty database must persist three row files.',
    );
    const copiedMarkdown = emptyFiles.map((file) =>
      fs.readFileSync(path.join(vaultDir, 'Empty', file), 'utf8'),
    );
    assert.ok(copiedMarkdown.some((text) => text.includes('Corpo de conteúdo completo da Alpha.')));
    assert.ok(copiedMarkdown.some((text) => text.includes('Segredo:') && text.includes('segredo alpha')));
    const registry = JSON.parse(fs.readFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), 'utf8'));
    const copiedIds = Object.entries(registry.pages)
      .filter(([file]) => file.startsWith('Empty/'))
      .map(([, placement]) => placement.id);
    assert.equal(copiedIds.length, 3);
    assert.ok(copiedIds.every((id) => !['source-alpha', 'source-beta', 'source-gamma'].includes(id)));
    evidence.ticket36.copyToEmptyAndPersistenceVerified = true;
    evidence.ticket36.copiedContentAndUnmappedFrontmatterVerified = true;
    evidence.ticket36.newIdsVerified = true;

    console.log('2. Reopening the same hidden app against the synthetic fixture...');
    markStage('reopen-close-first-app');
    await app.close();
    markStage('reopen-launch-second-app');
    app = await launchHidden(profileDir);
    markStage('reopen-verify-hidden-window');
    const hiddenAfterReopen = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(hiddenAfterReopen, true);
    markStage('reopen-attach-window-and-grant-clipboard');
    page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
    markStage('reopen-wait-renderer');
    await page.waitForTimeout(2000);
    markStage('reopen-open-empty-table');
    await openTable(page, 'Empty');
    markStage('reopen-verify-empty-table-persistence');
    assert.equal((await visibleRows(page)).length, 3, 'Copied rows must survive an app restart.');
    markStage('reopen-open-source-table');
    await openTable(page, 'Source');
    markStage('reopen-verify-source-preserved');
    assert.equal((await visibleRows(page)).length, 3, 'Copy must leave every source row in place.');
    evidence.ticket36.reopenPersistenceVerified = true;

    markStage('row-menu-open-and-read-actions');
    const menuProbe = page.locator('.db-table tbody tr').filter({ hasText: 'Alpha' });
    await menuProbe.locator('.db-row-menu-trigger').click();
    const menuLabels = await page.locator('[role="menu"] [role="menuitem"]').allTextContents();
    for (const pattern of [
      /expandir linha|open row/i,
      /inserir linha antes|insert row before/i,
      /inserir linha depois|insert row after/i,
      /duplicar|duplicate/i,
      /copiar linhas|copy rows/i,
      /colar linhas|paste rows/i,
      /mover para outra tabela|move to another table/i,
      /lixeira|trash/i,
    ])
      assert.ok(
        menuLabels.some((label) => pattern.test(label)),
        `Row menu is missing ${pattern}.`,
      );
    const rowMenu = page.locator('[role="menu"]:visible');
    markStage('row-menu-escape-close');
    await rowMenu.locator('[role="menuitem"]').first().focus();
    await page.keyboard.press('Escape');
    await rowMenu.waitFor({ state: 'detached' });
    evidence.ticket35.rowMenuActionsAndKeyboardCloseVerified = true;

    if (diagnosticMode) {
      await page.evaluate(() => {
        const observations = [];
        let previous = '';
        const capture = (event) => {
          const snapshot = {
            event,
            at: Date.now(),
            rows: [...document.querySelectorAll('.db-table tbody tr .db-col-title')].map(
              (cell) => cell.textContent?.trim() ?? '',
            ),
            toasts: [...document.querySelectorAll('.toast')].map((item) => item.textContent?.trim() ?? ''),
            recovery: [...document.querySelectorAll('.table-action-recovery')].map(
              (item) => item.textContent?.trim() ?? '',
            ),
          };
          const fingerprint = JSON.stringify(snapshot);
          if (fingerprint !== previous) {
            previous = fingerprint;
            observations.push(snapshot);
            if (observations.length > 40) observations.shift();
          }
        };
        window.__delivery5ActionObservations = observations;
        new MutationObserver(() => capture('mutation')).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        window.addEventListener('morrow-table-action-changed', () => capture('table-action-changed'));
        capture('baseline');
      });
    }

    for (const [label, pattern] of [
      ['insert-before', /inserir linha antes|insert row before/i],
      ['insert-after', /inserir linha depois|insert row after/i],
    ]) {
      const previousJournal = readActionJournal(vaultDir);
      markStage(`${label}-open-row-menu`);
      await page.locator('.db-table tbody tr').first().locator('.db-row-menu-trigger').click();
      markStage(`${label}-select-action`);
      const actionLabel = await clickMenuItem(page, pattern);
      markStage(`${label}-wait-row-count`);
      await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 4);
      const insertUndo = page
        .locator('.table-action-recovery button')
        .filter({ hasText: /desfazer|undo|deshacer/i });
      markStage(`${label}-wait-undo-button`);
      await insertUndo.waitFor({ state: 'visible' });
      const completedJournal = readActionJournal(vaultDir);
      assert.equal(completedJournal?.status, 'complete', `${label} must be saved before it can be undone.`);
      assert.notEqual(
        completedJournal?.id,
        previousJournal?.id,
        `${label} must replace the prior action journal.`,
      );
      assert.equal(completedJournal?.label, actionLabel, `${label} must journal the action the user selected.`);
      markStage(`${label}-undo`);
      await insertUndo.click();
      markStage(`${label}-wait-restored-row-count`);
      await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
      markStage(`${label}-wait-journal-settled`);
      await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
      const undoneJournal = readActionJournal(vaultDir);
      assert.equal(
        undoneJournal?.status,
        'undone',
        `${label} recovery must finish before the next action.`,
      );
      assert.equal(undoneJournal?.id, completedJournal?.id, `${label} undo must settle the same journal.`);
    }
    evidence.ticket35.insertBeforeAfterAndUndoVerified = true;
    evidence.ticket35.recoveryJournalReadyBeforeNextActionVerified = true;

    markStage('reorder-read-original-order');
    const beforeMoveOrder = await visibleRows(page);
    markStage('reorder-dispatch-drag-drop');
    const reorderEvidence = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.db-table tbody tr')];
      const handle = rows[0]?.querySelector('.db-row-drag');
      const target = rows[1];
      if (!(handle instanceof HTMLElement) || !(target instanceof HTMLElement))
        throw new Error('Could not locate visible row reorder controls.');
      const dataTransfer = new DataTransfer();
      const targetRect = target.getBoundingClientRect();
      const clientX = targetRect.left + targetRect.width / 2;
      const clientY = targetRect.bottom - 1;
      const startAccepted = handle.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }),
      );
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer }),
      );
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer });
      target.dispatchEvent(drop);
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
      return { startAccepted, dropPrevented: drop.defaultPrevented };
    });
    assert.ok(reorderEvidence.startAccepted && reorderEvidence.dropPrevented);
    const expectedReordered = [beforeMoveOrder[1], beforeMoveOrder[0], ...beforeMoveOrder.slice(2)];
    markStage('reorder-wait-new-order');
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('.db-table tbody tr')]
          .map((row) => row.querySelector('.db-col-title')?.textContent?.trim() ?? '')
          .join('\n') === expected.join('\n'),
      expectedReordered,
    );
    evidence.ticket35.manualReorderVerified = true;

    markStage('duplicate-open-row-menu');
    const gammaRow = page.locator('.db-table tbody tr').filter({ hasText: 'Gamma' });
    await gammaRow.locator('.db-row-menu-trigger').click();
    markStage('duplicate-select-action');
    await clickMenuItem(page, /duplicar|duplicate/i);
    markStage('duplicate-wait-row-count');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 4);
    assert.ok((await visibleRows(page)).some((title) => /Gamma/i.test(title) && !/^Gamma\s*$/.test(title)));
    const undoButton = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    markStage('duplicate-wait-undo-button');
    await undoButton.waitFor({ state: 'visible' });
    markStage('duplicate-undo');
    await undoButton.click();
    markStage('duplicate-wait-restored-row-count');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    markStage('duplicate-wait-journal-settled');
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    evidence.ticket35.duplicatePreservesRowsAndUndoVerified = true;

    markStage('move-open-row-menu');
    const betaRow = page.locator('.db-table tbody tr').filter({ hasText: /^Beta/ });
    await betaRow.locator('.db-row-menu-trigger').click();
    markStage('move-select-action');
    await clickMenuItem(page, /mover para outra tabela|move to another table|mover a otra tabla/i);
    dialog = page.locator('.db-row-dialog');
    markStage('move-wait-mapping-dialog');
    await dialog.waitFor({ state: 'visible' });
    markStage('move-select-destination');
    await dialog.locator('select[data-autofocus]').selectOption('destination-db');
    markStage('move-confirm');
    await focusPrimaryByTab(page, dialog);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    markStage('move-wait-source-row-removed');
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.db-table tbody tr')].some((row) =>
          row.textContent?.includes('Beta'),
        ),
    );
    markStage('move-wait-source-focus');
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('.db-table-view')));
    markStage('move-open-destination-table');
    await openTable(page, 'Destination');
    const moveUndo = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    markStage('move-wait-undo-button');
    await moveUndo.waitFor({ state: 'visible' });
    markStage('move-undo');
    await moveUndo.click();
    markStage('move-wait-destination-restored');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    markStage('move-wait-journal-settled');
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    assert.equal(
      (await visibleRows(page)).length,
      1,
      'Undoing a move must remove the moved row from its destination.',
    );
    markStage('move-open-source-after-undo');
    await openTable(page, 'Source');
    markStage('move-verify-source-row-restored');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table tbody tr')].some((row) => row.textContent?.includes('Beta')),
    );
    evidence.ticket36.movePreservesSourceAndUndoVerified = true;

    markStage('trash-filter-single-visible-row');
    const sourceSearch = page.locator('.db-search input[type="search"]');
    await sourceSearch.fill('Alpha');
    markStage('trash-wait-filter-result');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    const alphaRow = page.locator('.db-table tbody tr').filter({ hasText: /^Alpha/ });
    markStage('trash-open-warning');
    await alphaRow.locator('.db-row-menu-trigger').click();
    await clickMenuItem(page, /lixeira|trash|papelera/i);
    let trashDialog = page.getByRole('alertdialog');
    await trashDialog.waitFor({ state: 'visible' });
    assert.ok((await trashDialog.locator('h2').innerText()).includes('1'));
    assert.ok((await trashDialog.locator('#db-row-trash-impact').innerText()).includes('1'));
    assert.ok((await trashDialog.innerText()).match(/desfazer|undo|deshacer/i));
    assert.equal(
      await trashDialog
        .locator('.button[data-autofocus]')
        .evaluate((element) => element === document.activeElement),
      true,
      'The delete warning must initially focus Cancel.',
    );
    markStage('trash-cancel-warning');
    await page.keyboard.press('Escape');
    await trashDialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('db-row-menu-trigger'));
    assert.ok((await visibleRows(page)).some((title) => title.includes('Alpha')));
    evidence.ticket35.trashWarningCountsNestedRowsAndEscapeCancels = true;
    evidence.ticket35.dialogFocusReturnsToMenuTrigger = true;

    markStage('trash-reopen-warning');
    const alphaAgain = page.locator('.db-table tbody tr').filter({ hasText: /^Alpha/ });
    await alphaAgain.locator('.db-row-menu-trigger').click();
    await clickMenuItem(page, /lixeira|trash|papelera/i);
    markStage('trash-confirm-delete');
    trashDialog = page.getByRole('alertdialog');
    await trashDialog.waitFor({ state: 'visible' });
    const confirmDelete = trashDialog.locator('.db-row-dialog-actions .button.danger');
    await page.keyboard.press('Tab');
    assert.equal(await confirmDelete.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await trashDialog.waitFor({ state: 'detached' });
    markStage('trash-wait-row-removed');
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.db-table tbody tr')].some((row) =>
          row.textContent?.includes('Alpha'),
        ),
    );
    markStage('trash-wait-focus-fallback');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.db-table'), null, {
      timeout: 5000,
    });
    assert.equal(
      await page.evaluate(() => document.activeElement === document.querySelector('.db-table')),
      true,
      'Deleting the last visible row must move focus to the programmatically focusable table, not body.',
    );
    const trashUndo = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    markStage('trash-wait-undo-button');
    await trashUndo.waitFor({ state: 'visible' });
    markStage('trash-undo');
    await trashUndo.click();
    markStage('trash-wait-row-restored');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table tbody tr')].some((row) => row.textContent?.includes('Alpha')),
    );
    markStage('trash-wait-journal-settled');
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    evidence.ticket35.keyboardTrashConfirmAndUndoVerified = true;
    evidence.ticket35.deleteDialogFocusContainmentVerified = true;
    evidence.ticket35.lastVisibleRowDeletionMovesFocusToTable = true;

    markStage('inverse-open-source-table');
    await openTable(page, 'Books');
    markStage('inverse-open-property-settings');
    await page.locator('.db-header').filter({ hasText: 'Author' }).click();
    const relationPanel = page.locator('.db-panel');
    await relationPanel.waitFor({ state: 'visible' });
    const relationTargetField = relationPanel
      .locator('.field')
      .filter({ hasText: /Target table|Tabela relacionada|Tabla de destino/i });
    await relationTargetField.locator('.select-button').click();
    markStage('inverse-select-target-table');
    await page.getByRole('option', { name: 'Authors', exact: true }).click();
    const createInverseMode = relationPanel.getByRole('radio', {
      name: /Create new column in target|Criar nova coluna no destino|Crear nueva columna en el destino/i,
    });
    markStage('inverse-select-create-mode');
    await createInverseMode.click();
    const inverseName = relationPanel
      .locator('.field')
      .filter({ hasText: /New column name|Nome da nova coluna|Nombre de la nueva columna/i })
      .locator('input');
    assert.equal(await inverseName.inputValue(), 'Books');
    const createAndLink = relationPanel.getByRole('button', {
      name: /Create & Link|Criar e vincular|Crear y vincular/i,
    });
    markStage('inverse-create-and-link');
    await createAndLink.click();
    const sourceSchemaText = await waitForFileText(
      path.join(vaultDir, 'Books.md'),
      (text) => {
        const ownerBlock = databasePropertyBlock(text, 'author');
        return ownerBlock !== null && /^\s+inversePropertyId:\s*(?!null\s*$)\S+\s*$/m.test(ownerBlock);
      },
      'The source relation configuration',
    );
    const ownerBlock = databasePropertyBlock(sourceSchemaText, 'author');
    assert.ok(ownerBlock, 'The source relation property must be persisted.');
    const inversePropertyId = ownerBlock.match(/^\s+inversePropertyId:\s*(\S+)\s*$/m)?.[1];
    assert.ok(inversePropertyId && inversePropertyId !== 'null', 'A dynamic inverse property id must be saved.');
    const targetSchemaText = await waitForFileText(
      path.join(vaultDir, 'Authors.md'),
      (text) => databasePropertyBlock(text, inversePropertyId) !== null,
      'The created inverse property',
    );
    const inverseBlock = databasePropertyBlock(targetSchemaText, inversePropertyId);
    assert.ok(inverseBlock, 'The target schema must contain the dynamically created inverse property.');
    assert.match(inverseBlock, /^\s+name:\s*Books\s*$/m);
    assert.match(inverseBlock, /^\s+type:\s*relation\s*$/m);
    assert.match(inverseBlock, /^\s+targetDatabaseId:\s*books-db\s*$/m);
    assert.match(inverseBlock, /^\s+isInverse:\s*true\s*$/m);
    assert.match(inverseBlock, /^\s+inversePropertyId:\s*author\s*$/m);
    evidence.ticket46.createdInversePropertyId = inversePropertyId;
    markStage('inverse-wait-persisted-schemas');
    await page.keyboard.press('Escape');
    await relationPanel.waitFor({ state: 'detached' });

    markStage('inverse-open-target-table');
    await openTable(page, 'Authors');
    markStage('inverse-verify-projected-existing-link');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table thead .db-header-name')].some(
        (header) => header.textContent?.trim() === 'Books',
      ),
    );
    const linkedAuthorRow = page.locator('.db-table tbody tr').filter({ hasText: 'Le Guin' });
    assert.ok((await linkedAuthorRow.innerText()).includes('Earthsea'));

    markStage('inverse-close-before-reopen');
    await app.close();
    markStage('inverse-launch-after-reopen');
    app = await launchHidden(profileDir);
    const hiddenAfterInverseReopen = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(hiddenAfterInverseReopen, true);
    page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
    markStage('inverse-wait-tree-after-reopen');
    await page.waitForSelector('.tree-row', { timeout: 15000 });
    markStage('inverse-open-target-after-reopen');
    await openTable(page, 'Authors');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table thead .db-header-name')].some(
        (header) => header.textContent?.trim() === 'Books',
      ),
    );
    const reopenedAuthorRow = page.locator('.db-table tbody tr').filter({ hasText: 'Le Guin' });
    await reopenedAuthorRow.waitFor({ state: 'visible' });
    assert.ok((await reopenedAuthorRow.innerText()).includes('Earthsea'));
    evidence.ticket46.createdInverseLinkedExistingValueVerified = true;
    evidence.ticket46.inverseSchemaPersistedAfterReopenVerified = true;
    evidence.ticket46.existingRelationProjectedAfterReopenVerified = true;

    markStage('final-hidden-window-check');
    const allHiddenAtEnd = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(allHiddenAtEnd, true, 'The Electron app must remain hidden throughout the run.');
    assert.deepEqual(pageErrors, [], 'The renderer must not report page errors.');
    evidence.hiddenWindowVerified = true;
    evidence.rendererPageErrors = pageErrors;
    markStage('write-evidence');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const evidenceName = diagnosticMode ? `delivery5-ui-diagnostic-${runId}.json` : `delivery5-ui-${runId}.json`;
    evidencePath = path.join(evidenceDirectory, evidenceName);
    const serialized = JSON.stringify(evidence, null, 2);
    assert.ok(
      !serialized.includes(root),
      'Evidence must not disclose synthetic temp profile or vault paths.',
    );
    fs.writeFileSync(evidencePath, serialized, 'utf8');
    evidenceSaved = true;
    console.log(
      diagnosticMode
        ? `3. Delivery 5 diagnostic evidence saved: ${path.relative(process.cwd(), evidencePath)}`
        : `3. Delivery 5 hidden UI evidence saved: ${path.relative(process.cwd(), evidencePath)}`,
    );
    runSucceeded = true;
  } catch (error) {
    const snapshot = await captureFailureState(page, vaultDir);
    const message = error instanceof Error ? error.message : String(error);
    const failurePath = path.join(evidenceDirectory, `delivery5-ui-failure-${runId}.json`);
    const failureEvidence = {
      timestamp: new Date().toISOString(),
      runId,
      fixture: 'synthetic-only',
      buildIdentity: currentBuildIdentity,
      stage: currentStage,
      stageElapsedMs: snapshot.stageElapsedMs,
      message,
      location: relativeStackLocation(error),
      stack: relativeStack(error),
      state: snapshot,
    };
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const serializedFailure = JSON.stringify(failureEvidence, null, 2).replaceAll(root, '<synthetic-test-root>');
    assert.ok(
      !serializedFailure.includes(root),
      'Failure evidence must not disclose synthetic temp profile or vault paths.',
    );
    fs.writeFileSync(failurePath, serializedFailure, 'utf8');
    console.error(`Delivery 5 failure evidence saved: ${path.relative(process.cwd(), failurePath)}`);
    console.error(
      `Delivery 5 failure: stage=${currentStage}; elapsedMs=${snapshot.stageElapsedMs}; message=${message}`,
    );
    console.error(`Delivery 5 failure location: ${relativeStackLocation(error) ?? 'unavailable'}`);
    console.error(`Delivery 5 failure state: ${JSON.stringify(snapshot)}`);
    console.error(
      `Delivery 5 failure stack (repo-relative): ${relativeStack(error).replace(/\r?\n/g, ' | ')}`,
    );
    throw error;
  } finally {
    if (app) await app.close();
    if (diagnosticMode && !runSucceeded) {
      console.error(`Delivery 5 diagnostic fixture retained: ${path.basename(root)}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'Temporary profile and synthetic vault must be removed.');
    }
    if (evidenceSaved && evidencePath) {
      evidence.cleanupVerified = true;
      const cleaned = JSON.stringify(evidence, null, 2);
      assert.ok(!cleaned.includes(root), 'Evidence must remain sanitized after cleanup.');
      fs.writeFileSync(evidencePath, cleaned, 'utf8');
    }
  }
}

main().catch(() => process.exit(1));
