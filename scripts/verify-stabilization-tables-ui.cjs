const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const evidenceDirectory = path.resolve(
  process.env.MORROW_EVIDENCE_DIR ?? path.join(projectRoot, 'docs', 'evidence', 'stabilization-1.1.1'),
);
const evidenceVariant = process.env.MORROW_EVIDENCE_VARIANT ?? '';
if (evidenceVariant && !/^[a-z0-9-]+$/i.test(evidenceVariant)) {
  throw new Error('MORROW_EVIDENCE_VARIANT may contain only letters, digits, and hyphens.');
}
const evidenceSuffix = evidenceVariant ? `-${evidenceVariant}` : '';
const screenshotDirectory = path.join(evidenceDirectory, `tables-ui${evidenceSuffix}`);

function buildIdentity() {
  const directories = ['dist', 'dist-electron'];
  const files = [];
  for (const directory of directories) {
    const root = path.join(projectRoot, directory);
    if (!fs.existsSync(root)) continue;
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.isFile()) {
          const contents = fs.readFileSync(target);
          files.push({ path: path.relative(projectRoot, target).replaceAll(path.sep, '/'), sha256: crypto.createHash('sha256').update(contents).digest('hex') });
        }
      }
    };
    visit(root);
  }
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function tableView(id, name) {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    widths: { title: 220, amount: 140, notes: 220, status: 170, owner: 200, details: 240 },
    summaries: { amount: 'sum' },
  };
}

function viewYaml(view) {
  return [
    `    - id: ${view.id}`,
    `      name: ${view.name}`,
    `      type: ${view.type}`,
    '      filters: []',
    '      sorts: []',
    '      groupBy: null',
    '      dateProp: null',
    '      hidden: []',
    `      widths: ${JSON.stringify(view.widths)}`,
    `      summaries: ${JSON.stringify(view.summaries)}`,
  ].join('\n');
}

function writeFixture(root) {
  const profileDirectory = path.join(root, 'profile');
  const vaultDirectory = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultDirectory, 'Financeiro'), { recursive: true });
  fs.mkdirSync(path.join(vaultDirectory, 'Read-only'), { recursive: true });
  fs.mkdirSync(path.join(vaultDirectory, '.morrow'), { recursive: true });
  fs.mkdirSync(profileDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(profileDirectory, 'vaults.json'),
    JSON.stringify({ current: vaultDirectory, recent: [{ path: vaultDirectory, openedAt: Date.now() }] }),
  );

  fs.writeFileSync(
    path.join(vaultDirectory, '.morrow', 'workspace.json'),
    JSON.stringify(
      {
        pages: {
          'Financeiro.md': { id: 'finance-db' },
          'Financeiro/Alpha.md': { id: 'row-alpha' },
          'Financeiro/Beta.md': { id: 'row-beta' },
          'Financeiro/Gamma.md': { id: 'row-gamma' },
          'Read-only.md': { id: 'readonly-db' },
          'Read-only/Entry.md': { id: 'readonly-entry' },
          'Comparison.md': { id: 'comparison-page' },
        },
      },
      null,
      2,
    ),
  );

  const primaryView = tableView('finance-primary', 'Primary view');
  const linkedView = { ...primaryView, id: 'linked-review', name: 'Independent linked view name', hideTitle: true };
  const readonlyView = {
    ...primaryView,
    id: 'readonly-primary',
    name: 'Protected view',
    widths: { title: 220, protected: 220 },
    summaries: {},
  };
  const databaseMarkdown = `---
kind: database
database:
  properties:
    - id: amount
      name: Amount
      type: number
    - id: notes
      name: Notes
      type: text
    - id: status
      name: Status
      type: text
    - id: owner
      name: Owner
      type: text
    - id: details
      name: Details
      type: text
  views:
${viewYaml(primaryView)}
---
# Financeiro synthetic source
`;
  fs.writeFileSync(path.join(vaultDirectory, 'Financeiro.md'), databaseMarkdown, 'utf8');
  fs.writeFileSync(
    path.join(vaultDirectory, 'Read-only.md'),
    `---\nkind: database\ndatabase:\n  properties:\n    - id: protected\n      name: Protected field\n      type: text\n  views:\n${viewYaml(readonlyView)}\n---\n# Read-only synthetic database\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDirectory, 'Read-only', 'Entry.md'),
    `---\nProtected field: "Untouched synthetic value"\n---\n# Read-only entry\n`,
    'utf8',
  );

  for (const [fileName, title, amount, notes, status, owner, details] of [
    ['Alpha', 'Alpha', 120, 'First synthetic note', 'Open', 'Ada', 'Synthetic detail A'],
    ['Beta', 'Beta', 240, 'Second synthetic note', 'In progress', 'Bo', 'Synthetic detail B'],
    ['Gamma', 'Gamma', 360, 'Third synthetic note', 'Closed', 'Cy', 'Synthetic detail C'],
  ]) {
    fs.writeFileSync(
      path.join(vaultDirectory, 'Financeiro', `${fileName}.md`),
      `---\nAmount: ${amount}\nNotes: "${notes}"\nStatus: "${status}"\nOwner: "${owner}"\nDetails: "${details}"\n---\n# ${title}\n`,
      'utf8',
    );
  }

  const linkedPayload = encodeURIComponent(
    JSON.stringify({ sourceDatabaseId: 'finance-db', blockId: 'linked-block', view: linkedView }),
  );
  fs.writeFileSync(
    path.join(vaultDirectory, 'Comparison.md'),
    `# Comparison synthetic\n\n![[Financeiro]]\n\n<!-- morrow:linked-view:v1:${linkedPayload} -->\n\n**Linked database view:** [[Financeiro]] — open in Morrow to edit shared rows.\n`,
    'utf8',
  );
  return { profileDirectory, vaultDirectory };
}

async function assertHidden(app) {
  const visibleWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  assert.equal(visibleWindows, 0, 'UI verification must keep every Electron window hidden.');
}

async function openPage(page, title, visibleText = title) {
  const navigationRows = page.locator('.tree-row, .link-row');
  let match = null;
  for (let index = 0; index < (await navigationRows.count()); index++) {
    const row = navigationRows.nth(index);
    if ((await row.innerText()).split('\n')[0].trim() === title) {
      match = row;
      break;
    }
  }
  assert.ok(match, `Synthetic page ${title} should appear in the navigation.`);
  await match.scrollIntoViewIfNeeded();
  await match.click();
  await page.waitForFunction((expected) => document.querySelector('main')?.innerText.includes(expected), visibleText);
  await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
}

async function waitFor(predicate, message, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${message}.`);
}

function readLinkedView(vaultDirectory) {
  const markdown = fs.readFileSync(path.join(vaultDirectory, 'Comparison.md'), 'utf8');
  const encoded = markdown.match(/morrow:linked-view:v1:([^\s]+) -->/)?.[1];
  assert.ok(encoded, 'The synthetic linked-view marker should remain in its host page.');
  return JSON.parse(decodeURIComponent(encoded));
}

async function tableStyleSummary(database) {
  return database.evaluate((root) => {
    const table = root.querySelector('.db-table');
    const header = table?.querySelector('thead th.db-col-title');
    const body = table?.querySelector('tbody td[data-col-id="amount"]');
    const footer = table?.querySelector('tfoot td[data-col-id="amount"]');
    const style = (element) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        borderTop: computed.borderTop,
        borderRight: computed.borderRight,
        borderBottom: computed.borderBottom,
        borderLeft: computed.borderLeft,
        padding: computed.padding,
        verticalAlign: computed.verticalAlign,
        textAlign: computed.textAlign,
      };
    };
    const tableStyle = table ? getComputedStyle(table) : null;
    const rect = table?.getBoundingClientRect();
    return {
      table: tableStyle
        ? {
            fontFamily: tableStyle.fontFamily,
            fontSize: tableStyle.fontSize,
            lineHeight: tableStyle.lineHeight,
            tableLayout: tableStyle.tableLayout,
            borderCollapse: tableStyle.borderCollapse,
            width: Math.round(rect?.width ?? 0),
          }
        : null,
      header: style(header),
      body: style(body),
      footer: style(footer),
    };
  });
}

async function readAmountAlignment(table) {
  return table.evaluate((element) => ({
    body: getComputedStyle(element.querySelector('tbody td[data-col-id="amount"]')).textAlign,
    footer: getComputedStyle(element.querySelector('tfoot td[data-col-id="amount"]')).textAlign,
    bodyFrozen: element.querySelector('tbody td[data-col-id="amount"]')?.classList.contains('db-frozen') ?? false,
    footerFrozen: element.querySelector('tfoot td[data-col-id="amount"]')?.classList.contains('db-frozen') ?? false,
  }));
}

async function openOptions(database) {
  await database.locator('.db-options-button').click();
  const panel = database.page().locator('.db-panel').last();
  await panel.waitFor({ state: 'visible' });
  return panel;
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-stabilization-tables-'));
  const { profileDirectory, vaultDirectory } = writeFixture(fixtureRoot);
  const originalBuildIdentity = buildIdentity();
  const errors = [];
  const checks = {};
  let app = null;
  let page = null;

  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDirectory },
    });
    await assertHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await page.setViewportSize({ width: 1180, height: 900 });
    await assertHidden(app);

    await openPage(page, 'Comparison', 'Comparison synthetic');
    await page.waitForFunction(() => document.querySelectorAll('.inline-database .db-table, .linked-database-view .db-table').length === 2);
    const inlineDatabase = page.locator('.inline-database .database').first();
    let linkedBlock = page.locator('.linked-database-view').first();
    let linkedDatabase = linkedBlock.locator('.database');
    const linkedSourceTitle = 'Financeiro';
    const linkedHeadText = await linkedBlock.locator('.linked-database-head').innerText();
    assert.ok(!linkedHeadText.includes(linkedSourceTitle), 'Hidden linked title must not show the actual source page title.');
    assert.match(await linkedBlock.locator('.inline-database-hidden-title-trigger').innerText(), /show title|mostrar título/i);
    assert.match(
      await linkedBlock.locator('.linked-database-open-source').getAttribute('aria-label'),
      /open source database|abrir banco de origem|abrir base de datos de origen/i,
    );
    assert.equal(await linkedDatabase.locator('.db-options-button').count(), 1);
    checks.linkedHiddenTitle = {
      actualSourceTitle: linkedSourceTitle,
      sourceNameHidden: !linkedHeadText.includes(linkedSourceTitle),
      restoreControlVisible: true,
      sourceOpenControlAccessible: true,
      optionsControlAvailable: true,
    };

    const inlineToolbarButtons = await inlineDatabase.locator('.db-tools > button').count();
    const linkedToolbarButtons = await linkedDatabase.locator('.db-tools > button').count();
    assert.equal(inlineToolbarButtons, 1);
    assert.equal(linkedToolbarButtons, 1);
    assert.equal(await inlineDatabase.locator('.db-search input').count(), 1);
    assert.equal(await linkedDatabase.locator('.db-search input').count(), 1);
    checks.compactToolbar = { inlineDirectButtons: inlineToolbarButtons, linkedDirectButtons: linkedToolbarButtons, searchInputs: 2 };

    await page.setViewportSize({ width: 1600, height: 1500 });
    const inlineStyles = await tableStyleSummary(inlineDatabase);
    const linkedStyles = await tableStyleSummary(linkedDatabase);
    assert.deepEqual(linkedStyles, inlineStyles, 'Canonical inline and linked databases should share table styles.');
    await page.evaluate(() => window.scrollTo(0, 0));
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    const styleScreenshot = path.join(screenshotDirectory, 'inline-linked-canonical-styles.png');
    await page.screenshot({ path: styleScreenshot, fullPage: true });
    checks.inlineLinkedStyleMatch = { inlineStyles, linkedStyles, screenshot: path.relative(projectRoot, styleScreenshot).replaceAll(path.sep, '/') };
    await page.setViewportSize({ width: 1180, height: 900 });

    let linkedPanel = await openOptions(linkedDatabase);
    const optionLabels = await linkedPanel.locator('.db-options-item').allInnerTexts();
    const hasLabel = (pattern) => optionLabels.some((label) => pattern.test(label));
    const settingsDiscoverable = {
      filter: hasLabel(/filter|filt/i),
      sort: hasLabel(/sort|orden/i),
      layout: hasLabel(/layout|diseñ|dispos/i),
      properties: hasLabel(/propert|propriedad|propriedade/i),
      summary: hasLabel(/calculate|calcular|resumen|resumo/i),
      conditionalFormatting: hasLabel(/conditional|condicional/i),
    };
    assert.ok(
      Object.values(settingsDiscoverable).every(Boolean),
      `Options should expose each table setting. Labels: ${JSON.stringify(optionLabels)}; matches: ${JSON.stringify(settingsDiscoverable)}`,
    );
    await linkedPanel.locator('.db-options-item').first().click();
    let filterPanel = page.locator('.db-panel').last();
    await filterPanel.waitFor({ state: 'visible' });
    await filterPanel.locator('.link-button').last().click();
    await filterPanel.locator('.db-filter-group').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    linkedPanel = await openOptions(linkedDatabase);
    await linkedPanel.locator('.db-options-item').nth(1).click();
    const sortPanel = page.locator('.db-panel').last();
    await sortPanel.waitFor({ state: 'visible' });
    await sortPanel.locator('.link-button').last().click();
    await sortPanel.locator('.db-sort-rule').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    const activeOptions = linkedDatabase.locator('.db-options-button');
    const activeOptionsLabel = await activeOptions.getAttribute('aria-label');
    const activeBadges = await activeOptions.locator('.db-options-count').count();
    assert.equal(activeBadges, 2);
    assert.ok((activeOptionsLabel?.match(/\b1\b/g)?.length ?? 0) >= 2);
    assert.equal(await activeOptions.getAttribute('aria-expanded'), 'false');
    checks.accessibleFilterSortState = {
      buttonLabel: activeOptionsLabel,
      filterAndSortBadges: activeBadges,
      settingsDiscoverable,
      expandedStateAfterClose: await activeOptions.getAttribute('aria-expanded'),
    };

    const sourceOpen = linkedBlock.locator('.linked-database-open-source');
    await sourceOpen.click();
    await page.waitForFunction(() => document.querySelector('main')?.innerText.includes('Financeiro synthetic source'));
    const currentPageTitle = page.locator('.breadcrumbs .crumb.is-current');
    await waitFor(
      async () => (await currentPageTitle.innerText()) === linkedSourceTitle,
      'the source page breadcrumb to show its actual display title',
    );
    assert.equal((await currentPageTitle.innerText()).trim(), linkedSourceTitle);
    await page.locator('.database .db-options-button').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.database .db-options-button').count(), 1);
    await openPage(page, 'Comparison', 'Comparison synthetic');
    linkedBlock = page.locator('.linked-database-view').first();
    linkedDatabase = linkedBlock.locator('.database');
    const restoreTitle = linkedBlock.locator('.inline-database-hidden-title-trigger');
    await restoreTitle.click();
    await linkedBlock.locator('.linked-database-source').waitFor({ state: 'visible' });
    const sourceNameAfterRestore = await linkedBlock.locator('.linked-database-source').innerText();
    assert.equal(sourceNameAfterRestore.trim(), linkedSourceTitle, `Unexpected restored source title: ${sourceNameAfterRestore}`);
    const linkedName = linkedBlock.locator('.linked-database-name');
    await linkedName.fill('Review view');
    await linkedName.press('Enter');
    await waitFor(
      async () => (await linkedBlock.locator('.linked-database-name').inputValue()) === 'Review view',
      'the linked view name to save independently',
    );
    await waitFor(
      () => readLinkedView(vaultDirectory).view.name === 'Review view',
      'the linked view name to persist before changing another linked-view setting',
    );
    const sourceTitleAfterRename = await linkedBlock.locator('.linked-database-source').innerText();
    assert.equal(sourceTitleAfterRename.trim(), linkedSourceTitle);
    assert.equal(fs.readFileSync(path.join(vaultDirectory, 'Financeiro.md'), 'utf8').includes('Review view'), false);

    linkedPanel = await openOptions(linkedDatabase);
    const hideTitleToggle = linkedPanel.locator('.db-options-toggle input').first();
    await hideTitleToggle.check();
    await linkedBlock.locator('.inline-database-hidden-title-trigger').waitFor({ state: 'visible' });
    await waitFor(() => readLinkedView(vaultDirectory).view.hideTitle === true, 'the hidden-title preference to persist');
    const persistedLinkedName = readLinkedView(vaultDirectory).view.name;
    assert.equal(persistedLinkedName, 'Review view');
    checks.independentLinkedName = {
      linkedViewName: persistedLinkedName,
      sourceTitleAfterRename: sourceTitleAfterRename.trim(),
      sourceDefinitionUnaffected: true,
    };

    await openPage(page, 'Financeiro', 'Financeiro synthetic source');
    const sourceTable = page.locator('.database .db-table').first();
    const defaultAlignment = await readAmountAlignment(sourceTable);
    assert.equal(defaultAlignment.body, 'left');
    assert.equal(defaultAlignment.footer, 'left');

    let sourcePanel = await openOptions(page.locator('.database').first());
    await sourcePanel.locator('.db-options-item').filter({ hasText: /propert|propriedad|propriedade/i }).click();
    sourcePanel = page.locator('.db-panel').last();
    await sourcePanel.waitFor({ state: 'visible' });
    const amountSettings = sourcePanel.locator('.db-prop-list li').filter({ hasText: 'Amount' });
    await amountSettings.locator('select[aria-label]').selectOption('right');
    await waitFor(async () => (await readAmountAlignment(sourceTable)).body === 'right', 'explicit alignment to reach the body');
    await page.keyboard.press('Escape');
    const explicitAlignment = await readAmountAlignment(sourceTable);
    assert.equal(explicitAlignment.body, 'right');
    assert.equal(explicitAlignment.footer, 'right');

    const amountHeader = sourceTable.locator('thead th').filter({ hasText: 'Amount' }).first();
    const resizeHandle = amountHeader.locator('.db-resize');
    const widthBeforeResize = await amountHeader.evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const resizeBox = await resizeHandle.boundingBox();
    assert.ok(resizeBox);
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 35, resizeBox.y + resizeBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await waitFor(
      async () => (await amountHeader.evaluate((element) => Math.round(element.getBoundingClientRect().width))) !== widthBeforeResize,
      'the amount column to resize',
    );
    const afterResizeAlignment = await readAmountAlignment(sourceTable);
    assert.equal(afterResizeAlignment.body, 'right');
    assert.equal(afterResizeAlignment.footer, 'right');

    const tableWrap = sourceTable.locator('xpath=..');
    const horizontalScroll = await tableWrap.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return { left: element.scrollLeft, width: element.scrollWidth, clientWidth: element.clientWidth };
    });
    assert.ok(horizontalScroll.left > 0, 'The synthetic table should exercise horizontal scrolling.');
    const afterScrollAlignment = await readAmountAlignment(sourceTable);
    assert.equal(afterScrollAlignment.body, 'right');
    assert.equal(afterScrollAlignment.footer, 'right');

    await tableWrap.evaluate((element) => { element.scrollLeft = 0; });
    await amountHeader.click({ button: 'right' });
    const columnMenu = page.locator('.menu[role="menu"]').last();
    await columnMenu.waitFor({ state: 'visible' });
    await columnMenu.locator('.menu-item').filter({ hasText: /freeze through|congelar|fijar/i }).click();
    await waitFor(async () => (await readAmountAlignment(sourceTable)).bodyFrozen, 'the amount column to freeze');
    const afterFreezeAlignment = await readAmountAlignment(sourceTable);
    assert.equal(afterFreezeAlignment.body, 'right');
    assert.equal(afterFreezeAlignment.footer, 'right');
    assert.equal(afterFreezeAlignment.footerFrozen, true);

    const calculate = sourceTable.locator('tfoot td[data-col-id="notes"] .db-calc-trigger');
    await calculate.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const calculateLabel = await calculate.getAttribute('aria-label');
    const idleOpacity = Number(await calculate.evaluate((element) => getComputedStyle(element).opacity));
    assert.ok(calculateLabel?.includes('Notes'));
    assert.equal(await calculate.evaluate((element) => element.tabIndex), 0, 'Calculate should remain in the tab order.');
    assert.ok(idleOpacity > 0 && idleOpacity < 1, 'Calculate should stay discreetly visible before focus.');
    await calculate.focus();
    await waitFor(
      async () => Number(await calculate.evaluate((element) => getComputedStyle(element).opacity)) === 1,
      'the calculate affordance to become fully visible on focus',
    );
    const focusedOpacity = Number(await calculate.evaluate((element) => getComputedStyle(element).opacity));
    assert.equal(focusedOpacity, 1);
    await page.keyboard.press('Enter');
    const calculatePanel = page.locator('.popover').last();
    await calculatePanel.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    checks.footerAlignment = {
      defaultAlignment,
      explicitAlignment,
      afterResizeAlignment,
      afterScrollAlignment,
      afterFreezeAlignment,
      horizontalScroll,
      calculateLabel,
      idleOpacity,
      focusedOpacity,
      keyboardOpensSummary: true,
    };

    const rowTitles = async () =>
      (await sourceTable.locator('tbody td.db-col-title').allInnerTexts()).map((text) => text.trim());
    const initialOrder = await rowTitles();
    const alpha = sourceTable.locator('tbody tr').filter({ hasText: /^Alpha/ }).first();
    const beta = sourceTable.locator('tbody tr').filter({ hasText: /^Beta/ }).first();
    const alphaGrip = alpha.locator('.db-row-drag');
    const betaGrip = beta.locator('.db-row-drag');
    await alpha.hover();
    assert.equal(await alphaGrip.getAttribute('draggable'), 'true');
    assert.ok((await alphaGrip.getAttribute('aria-keyshortcuts'))?.includes('Shift+F10'));
    await alphaGrip.click();
    assert.equal(await alpha.evaluate((row) => row.classList.contains('is-row-selected')), true);
    assert.equal(await alphaGrip.getAttribute('aria-pressed'), 'true');
    assert.equal(await alphaGrip.evaluate((element) => getComputedStyle(element).opacity), '1');
    await betaGrip.click({ modifiers: ['Shift'] });
    assert.equal(await sourceTable.locator('tbody tr.is-row-selected').count(), 2);
    await betaGrip.click({ modifiers: ['Control'] });
    assert.equal(await sourceTable.locator('tbody tr.is-row-selected').count(), 1);
    await betaGrip.click({ button: 'right' });
    const rightClickMenu = page.locator('.menu[role="menu"]').last();
    await rightClickMenu.waitFor({ state: 'visible' });
    const rightClickActions = await rightClickMenu.locator('[role="menuitem"]').allInnerTexts();
    assert.ok(rightClickActions.length > 0);
    await page.keyboard.press('Escape');

    const alphaCheckbox = alpha.locator('.db-row-select');
    await alphaCheckbox.uncheck();
    await waitFor(
      async () => !(await alpha.evaluate((row) => row.classList.contains('is-row-selected'))),
      'Alpha to be deselected before the Enter-key selection check',
    );
    assert.equal(await alphaGrip.getAttribute('aria-pressed'), 'false');
    await alphaGrip.focus();
    await page.keyboard.press('Enter');
    await waitFor(
      async () => alpha.evaluate((row) => row.classList.contains('is-row-selected')),
      'Enter to select Alpha from its deselected state',
    );
    assert.equal(await alpha.evaluate((row) => row.classList.contains('is-row-selected')), true);
    assert.equal(await alphaGrip.getAttribute('aria-pressed'), 'true');
    await alphaGrip.focus();
    await page.keyboard.press('Shift+F10');
    const keyboardMenu = page.locator('.menu[role="menu"]').last();
    await keyboardMenu.waitFor({ state: 'visible' });
    const keyboardActions = await keyboardMenu.locator('[role="menuitem"]').allInnerTexts();
    assert.ok(keyboardActions.length > 0);
    await page.keyboard.press('Escape');

    const search = page.locator('.database .db-search input').first();
    await search.fill('Beta');
    await page.waitForFunction(() => document.querySelectorAll('.database .db-table tbody tr').length === 1);
    await sourceTable.locator('tbody .db-row-drag').click();
    await sourceTable.locator('tbody .db-row-drag').press('Control+A');
    const visibleFilteredSelection = await sourceTable.locator('tbody tr.is-row-selected').count();
    assert.equal(visibleFilteredSelection, 1);
    await search.fill('');
    await page.waitForFunction(() => document.querySelectorAll('.database .db-table tbody tr').length === 3);

    for (let index = await sourceTable.locator('tbody tr.is-row-selected').count(); index > 0; index--) {
      const checkbox = sourceTable.locator('tbody tr.is-row-selected .db-row-select').first();
      if (await checkbox.isChecked()) await checkbox.uncheck();
    }
    const firstAfterReset = sourceTable.locator('tbody tr').first();
    const lastAfterReset = sourceTable.locator('tbody tr').last();
    await firstAfterReset.locator('.db-row-drag').dragTo(lastAfterReset);
    const orderAfterDrag = await waitFor(async () => {
      const current = await rowTitles();
      return current.join('|') !== initialOrder.join('|') ? current : null;
    }, 'the row order to change after dragging the six-dot grip');
    assert.notDeepEqual(orderAfterDrag, initialOrder);
    const afterDrag = {
      clickSelectsRow: true,
      shiftClickSelectsRange: true,
      controlClickTogglesSelection: true,
      rightClickActions,
      enterFromDeselectedState: true,
      enterSelectsRow: true,
      shiftF10Actions: keyboardActions,
      filteredVisibleSelection: visibleFilteredSelection,
      dragReordersRows: true,
      initialOrder,
      orderAfterDrag,
    };
    checks.rowGrip = afterDrag;

    const readonlyTreeRow = page.locator('.page-tree [role="treeitem"][data-page-id="readonly-db"]');
    await readonlyTreeRow.focus();
    await readonlyTreeRow.press('Delete');
    const trashNavigation = page.locator('.sidebar-footer .nav-item').filter({ hasText: /trash|lixeira/i }).first();
    await trashNavigation.click();
    const trashRows = page.locator('.trash-row');
    let readonlyTrashRow = null;
    for (let index = 0; index < await trashRows.count(); index++) {
      const candidate = trashRows.nth(index);
      const displayedTitle = (await candidate.locator('.link-row-title').innerText()).split('\n')[0].trim();
      if (displayedTitle === 'Read-only') {
        readonlyTrashRow = candidate;
        break;
      }
    }
    assert.ok(readonlyTrashRow, 'The synthetic read-only database must be in the Trash after the UI delete action.');
    await readonlyTrashRow.locator('button.link-row').click();
    await page.locator('.banner').filter({ hasText: /trash|lixeira/i }).waitFor({ state: 'visible' });
    await page.locator('.database .db-table').waitFor({ state: 'visible' });
    const readonlyTitle = page.locator('.breadcrumbs .crumb.is-current');
    assert.equal((await readonlyTitle.innerText()).trim(), 'Read-only');
    const readonlyDatabase = page.locator('.database').first();
    const readonlyOptionsButton = readonlyDatabase.locator('.db-options-button');
    assert.equal(await readonlyOptionsButton.isEnabled(), true, 'Options must remain available for a trashed database.');
    const readonlyOptions = await openOptions(readonlyDatabase);
    const readonlyOptionPatterns = [
      ['filter', /filter|filtro|filtr/i],
      ['sort', /sort|orden/i],
      ['layout', /layout|dispos|diseñ/i],
      ['calculate', /calculate|calcular|resumen|resumo/i],
      ['conditional formatting', /conditional|condicional/i],
    ];
    const disabledReadonlyOptions = [];
    for (const [name, pattern] of readonlyOptionPatterns) {
      const option = readonlyOptions.locator('.db-options-item').filter({ hasText: pattern });
      assert.equal(await option.count(), 1, `Read-only Options should expose ${name}.`);
      assert.equal(await option.isDisabled(), true, `${name} must be disabled for a trashed database.`);
      disabledReadonlyOptions.push(name);
    }
    const readonlyToggles = readonlyOptions.locator('.db-options-toggle input');
    assert.ok(await readonlyToggles.count() >= 2, 'Read-only Options should show title and collapse settings.');
    assert.equal(
      await readonlyToggles.evaluateAll((items) => items.every((item) => item.disabled)),
      true,
      'Title and collapse mutations must be disabled for a trashed database.',
    );
    const propertiesAction = readonlyOptions.locator('.db-options-item').filter({ hasText: /properties|propriedades|propiedades/i });
    assert.equal(await propertiesAction.count(), 1);
    assert.equal(await propertiesAction.isEnabled(), true, 'Properties must remain accessible for a trashed database.');
    const readonlyDatabasePath = path.join(vaultDirectory, '.trash', 'Read-only.md');
    await waitFor(
      () => fs.existsSync(readonlyDatabasePath),
      'the synthetic database markdown to move into the vault trash folder',
    );
    const markdownBeforeProperties = fs.readFileSync(readonlyDatabasePath, 'utf8');
    const markdownHashBeforeProperties = crypto.createHash('sha256').update(markdownBeforeProperties).digest('hex');
    await propertiesAction.click();
    const readonlyProperties = page.locator('.db-panel').last();
    await readonlyProperties.waitFor({ state: 'visible' });
    const readonlyPropertyNames = await readonlyProperties.locator('.db-prop-list .db-prop-name').allInnerTexts();
    assert.ok(readonlyPropertyNames.includes('Protected field'), `Protected property should be visible: ${readonlyPropertyNames.join(' | ')}`);
    const readonlyPropertyControls = readonlyProperties.locator('.db-prop-list li button, .db-prop-list li input, .db-prop-list li select');
    const readonlyPropertyControlCount = await readonlyPropertyControls.count();
    assert.ok(readonlyPropertyControlCount > 0, 'The property settings should expose controls whose read-only state can be checked.');
    assert.equal(
      await readonlyPropertyControls.evaluateAll((items) => items.every((item) => item.disabled)),
      true,
      'Every property mutation control must be disabled for a trashed database.',
    );
    assert.equal(await readonlyDatabase.locator('.db-new-row, .db-row-select, .db-row-menu-trigger, .db-row-drag').count(), 0);
    await page.keyboard.press('Escape');
    await readonlyProperties.waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    const markdownAfterProperties = fs.readFileSync(readonlyDatabasePath, 'utf8');
    const markdownHashAfterProperties = crypto.createHash('sha256').update(markdownAfterProperties).digest('hex');
    assert.equal(markdownAfterProperties, markdownBeforeProperties, 'Opening read-only Properties must not mutate database metadata.');
    assert.equal(markdownHashAfterProperties, markdownHashBeforeProperties);
    checks.readOnlyProperties = {
      openedFromTrash: true,
      displayedDatabaseTitle: (await readonlyTitle.innerText()).trim(),
      optionsAvailable: await readonlyOptionsButton.isEnabled(),
      propertiesAvailable: true,
      visibleProperties: readonlyPropertyNames,
      disabledOptions: disabledReadonlyOptions,
      disabledPropertyControlCount: readonlyPropertyControlCount,
      rowMutationControlsAbsent: true,
      markdownUnchanged: true,
      markdownSha256: markdownHashAfterProperties,
    };

    const markdownBeforeRestart = readLinkedView(vaultDirectory);
    assert.equal(markdownBeforeRestart.view.name, 'Review view');
    assert.equal(markdownBeforeRestart.view.hideTitle, true);
    await app.close();
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDirectory },
    });
    await assertHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await page.setViewportSize({ width: 1180, height: 900 });
    await openPage(page, 'Comparison', 'Comparison synthetic');
    linkedBlock = page.locator('.linked-database-view').first();
    await linkedBlock.locator('.inline-database-hidden-title-trigger').waitFor({ state: 'visible' });
    const reopenedTitleText = await linkedBlock.locator('.linked-database-head').innerText();
    assert.ok(!reopenedTitleText.includes(linkedSourceTitle), 'Reopened hidden title must not expose the actual source page title.');
    assert.equal(await linkedBlock.locator('.linked-database-name').count(), 0);
    assert.match(
      await linkedBlock.locator('.linked-database-open-source').getAttribute('aria-label'),
      /open source database|abrir banco de origem|abrir base de datos de origen/i,
    );
    await linkedBlock.locator('.inline-database-hidden-title-trigger').click();
    await linkedBlock.locator('.linked-database-source').waitFor({ state: 'visible' });
    assert.equal((await linkedBlock.locator('.linked-database-source').innerText()).trim(), linkedSourceTitle);
    assert.equal(await linkedBlock.locator('.linked-database-name').inputValue(), 'Review view');
    const sourceMarkdown = fs.readFileSync(path.join(vaultDirectory, 'Financeiro.md'), 'utf8');
    assert.ok(sourceMarkdown.includes('# Financeiro synthetic source'));
    assert.ok(!sourceMarkdown.includes('Review view'));
    checks.linkedTitlePersistence = {
      hideTitlePersisted: true,
      linkedNamePersisted: 'Review view',
      showTitleRestoresSource: true,
      restoredActualSourceTitle: linkedSourceTitle,
      sourceTitleUnaffected: true,
    };

    assert.deepEqual(buildIdentity(), originalBuildIdentity, 'The verifier must not modify the compiled build.');
    assert.deepEqual(errors, [], 'The renderer must not report uncaught page errors.');
    await assertHidden(app);
    const evidence = {
      runAt: new Date().toISOString(),
      evidenceVariant: evidenceVariant || 'initial',
      source: 'fresh synthetic inline, linked, and trashed read-only database fixtures',
      checks,
      rendererPageErrors: errors,
      hiddenWindowsThroughout: true,
      compiledBuildIdentity: originalBuildIdentity,
      screenshots: [
        path.relative(projectRoot, path.join(screenshotDirectory, 'inline-linked-canonical-styles.png')).replaceAll(path.sep, '/'),
      ],
    };
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = path.join(evidenceDirectory, `stabilization-tables-ui${evidenceSuffix}.json`);
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (app) await app.close().catch(() => {});
    const temporaryRoot = path.resolve(fixtureRoot);
    const temporaryDirectory = path.resolve(os.tmpdir());
    assert.ok(
      temporaryRoot.startsWith(`${temporaryDirectory}${path.sep}`) &&
        path.basename(temporaryRoot).startsWith('morrow-stabilization-tables-'),
      'Only this verifier’s generated temporary fixture may be removed.',
    );
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
