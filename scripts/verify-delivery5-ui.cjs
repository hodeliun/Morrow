const {
  _electron,
} = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROW_CLIPBOARD_PREFIX = 'morrow-row-clipboard:v1\n';

function databaseMarkdown(properties, viewId, hidden = []) {
  const hiddenLines = hidden.length
    ? `      hidden:\n${hidden.map((id) => `        - ${id}`).join('\n')}\n`
    : '';
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
# ${viewId === 'source-grid' ? 'Source' : viewId === 'destination-grid' ? 'Destination' : 'Empty'}
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
  fs.mkdirSync(path.join(vaultDir, '.morrow'));
  fs.mkdirSync(path.join(vaultDir, 'Source', 'Alpha'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'Destination'));
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

  let app = null;
  let evidencePath = null;
  let evidenceSaved = false;
  const evidence = {
    timestamp: new Date().toISOString(),
    fixture: 'synthetic-only',
    hiddenWindowVerified: false,
    ticket35: {},
    ticket36: {},
    rendererPageErrors: [],
    cleanupVerified: false,
  };

  try {
    console.log('1. Launching hidden Electron app with synthetic profile and vault...');
    app = await launchHidden(profileDir);
    const initiallyHidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(initiallyHidden, true, 'No Electron window may be visible.');
    evidence.hiddenWindowVerified = true;

    let page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const pageErrors = [];
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
    await app.close();
    app = await launchHidden(profileDir);
    const hiddenAfterReopen = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(hiddenAfterReopen, true);
    page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
    await page.waitForTimeout(2000);
    await openTable(page, 'Empty');
    assert.equal((await visibleRows(page)).length, 3, 'Copied rows must survive an app restart.');
    await openTable(page, 'Source');
    assert.equal((await visibleRows(page)).length, 3, 'Copy must leave every source row in place.');
    evidence.ticket36.reopenPersistenceVerified = true;

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
    await rowMenu.locator('[role="menuitem"]').first().focus();
    await page.keyboard.press('Escape');
    await rowMenu.waitFor({ state: 'detached' });
    evidence.ticket35.rowMenuActionsAndKeyboardCloseVerified = true;

    for (const pattern of [
      /inserir linha antes|insert row before/i,
      /inserir linha depois|insert row after/i,
    ]) {
      await page.locator('.db-table tbody tr').first().locator('.db-row-menu-trigger').click();
      await clickMenuItem(page, pattern);
      await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 4);
      const insertUndo = page
        .locator('.table-action-recovery button')
        .filter({ hasText: /desfazer|undo|deshacer/i });
      await insertUndo.waitFor({ state: 'visible' });
      await insertUndo.click();
      await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
      await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    }
    evidence.ticket35.insertBeforeAfterAndUndoVerified = true;
    evidence.ticket35.recoveryJournalReadyBeforeNextActionVerified = true;

    const beforeMoveOrder = await visibleRows(page);
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
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('.db-table tbody tr')]
          .map((row) => row.querySelector('.db-col-title')?.textContent?.trim() ?? '')
          .join('\n') === expected.join('\n'),
      expectedReordered,
    );
    evidence.ticket35.manualReorderVerified = true;

    const gammaRow = page.locator('.db-table tbody tr').filter({ hasText: 'Gamma' });
    await gammaRow.locator('.db-row-menu-trigger').click();
    await clickMenuItem(page, /duplicar|duplicate/i);
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 4);
    assert.ok((await visibleRows(page)).some((title) => /Gamma/i.test(title) && !/^Gamma\s*$/.test(title)));
    const undoButton = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    await undoButton.waitFor({ state: 'visible' });
    await undoButton.click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    evidence.ticket35.duplicatePreservesRowsAndUndoVerified = true;

    const betaRow = page.locator('.db-table tbody tr').filter({ hasText: /^Beta/ });
    await betaRow.locator('.db-row-menu-trigger').click();
    await clickMenuItem(page, /mover para outra tabela|move to another table|mover a otra tabla/i);
    dialog = page.locator('.db-row-dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('select[data-autofocus]').selectOption('destination-db');
    await focusPrimaryByTab(page, dialog);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.db-table tbody tr')].some((row) =>
          row.textContent?.includes('Beta'),
        ),
    );
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('.db-table-view')));
    await openTable(page, 'Destination');
    const moveUndo = page
      .locator('.table-action-recovery button')
      .filter({ hasText: /desfazer|undo|deshacer/i });
    await moveUndo.waitFor({ state: 'visible' });
    await moveUndo.click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    assert.equal(
      (await visibleRows(page)).length,
      1,
      'Undoing a move must remove the moved row from its destination.',
    );
    await openTable(page, 'Source');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table tbody tr')].some((row) => row.textContent?.includes('Beta')),
    );
    evidence.ticket36.movePreservesSourceAndUndoVerified = true;

    const sourceSearch = page.locator('.db-search input[type="search"]');
    await sourceSearch.fill('Alpha');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    const alphaRow = page.locator('.db-table tbody tr').filter({ hasText: /^Alpha/ });
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
    await page.keyboard.press('Escape');
    await trashDialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('db-row-menu-trigger'));
    assert.ok((await visibleRows(page)).some((title) => title.includes('Alpha')));
    evidence.ticket35.trashWarningCountsNestedRowsAndEscapeCancels = true;
    evidence.ticket35.dialogFocusReturnsToMenuTrigger = true;

    const alphaAgain = page.locator('.db-table tbody tr').filter({ hasText: /^Alpha/ });
    await alphaAgain.locator('.db-row-menu-trigger').click();
    await clickMenuItem(page, /lixeira|trash|papelera/i);
    trashDialog = page.getByRole('alertdialog');
    await trashDialog.waitFor({ state: 'visible' });
    const confirmDelete = trashDialog.locator('.db-row-dialog-actions .button.danger');
    await page.keyboard.press('Tab');
    assert.equal(await confirmDelete.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await trashDialog.waitFor({ state: 'detached' });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.db-table tbody tr')].some((row) =>
          row.textContent?.includes('Alpha'),
        ),
    );
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
    await trashUndo.waitFor({ state: 'visible' });
    await trashUndo.click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.db-table tbody tr')].some((row) => row.textContent?.includes('Alpha')),
    );
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    evidence.ticket35.keyboardTrashConfirmAndUndoVerified = true;
    evidence.ticket35.deleteDialogFocusContainmentVerified = true;
    evidence.ticket35.lastVisibleRowDeletionMovesFocusToTable = true;

    const allHiddenAtEnd = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
    );
    assert.equal(allHiddenAtEnd, true, 'The Electron app must remain hidden throughout the run.');
    assert.deepEqual(pageErrors, [], 'The renderer must not report page errors.');
    evidence.hiddenWindowVerified = true;
    evidence.rendererPageErrors = pageErrors;
    evidencePath = path.join(process.cwd(), 'docs', 'evidence', 'interaction-expansion-delivery5-ui.json');
    const serialized = JSON.stringify(evidence, null, 2);
    assert.ok(
      !serialized.includes(root),
      'Evidence must not disclose synthetic temp profile or vault paths.',
    );
    fs.writeFileSync(evidencePath, serialized, 'utf8');
    evidenceSaved = true;
    console.log('3. Delivery 5 hidden UI evidence saved.');
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'Temporary profile and synthetic vault must be removed.');
    if (evidenceSaved && evidencePath) {
      evidence.cleanupVerified = true;
      const cleaned = JSON.stringify(evidence, null, 2);
      assert.ok(!cleaned.includes(root), 'Evidence must remain sanitized after cleanup.');
      fs.writeFileSync(evidencePath, cleaned, 'utf8');
    }
  }
}

main().catch((error) => {
  console.error('Delivery 5 hidden UI verification failed:', error);
  process.exit(1);
});
