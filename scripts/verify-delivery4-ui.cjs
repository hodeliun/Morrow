const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-delivery4-verify-'));
  const profileDir = path.join(root, 'profile');
  const vaultDir = path.join(root, 'vault');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(vaultDir);

  fs.writeFileSync(
    path.join(profileDir, 'vaults.json'),
    JSON.stringify({ current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] })
  );

  const databaseMarkdown = `---
kind: database
database:
  properties:
    - id: quantity
      name: Quantidade
      type: number
    - id: notes
      name: Observacoes
      type: text
    - id: active
      name: Ativo
      type: checkbox
    - id: status
      name: Status
      type: select
      options:
        - id: todo
          name: To do
          color: gray
        - id: done
          name: Done
          color: green
    - id: owner
      name: Responsavel
      type: relation
      relation:
        targetDatabaseId: people-db
        multiple: false
        isInverse: false
        displayPropertyId: null
        inversePropertyId: null
        filters: []
    - id: rating
      name: Avaliacao
      type: scale
    - id: website
      name: Site
      type: url
    - id: due_date
      name: Prazo
      type: date
    - id: formula_calc
      name: Calculado
      type: formula
      formula: "Quantidade * 2"
  views:
    - id: view-grid
      name: Grade Geral
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      widths:
        title: 160
        quantity: 120
        notes: 160
        active: 100
        status: 120
        owner: 140
        due_date: 120
        formula_calc: 120
---
# Projetos
`;

  const readOnlyMarkdown = `---
kind: database
database:
  properties:
    - id: quantity
      name: Quantidade
      type: number
    - id: future-rating
      name: Avaliacao futura
      type: futureRating
      precision: 3
  views:
    - id: readonly-grid
      name: Somente leitura
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Somente Leitura
`;

  fs.mkdirSync(path.join(vaultDir, 'Projetos'));
  fs.mkdirSync(path.join(vaultDir, 'Pessoas'));
  fs.mkdirSync(path.join(vaultDir, 'Recebimentos'));
  fs.mkdirSync(path.join(vaultDir, 'Somente Leitura'));
  fs.mkdirSync(path.join(vaultDir, '.morrow'));

  const peopleMarkdown = `---
kind: database
database:
  properties: []
  views:
    - id: people-grid
      name: Pessoas
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Pessoas
`;
  const destinationMarkdown = `---
kind: database
database:
  properties:
    - id: quantity
      name: Quantidade
      type: number
  views:
    - id: destination-grid
      name: Recebimentos
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
---
# Recebimentos
`;

  fs.writeFileSync(
    path.join(vaultDir, '.morrow', 'workspace.json'),
    JSON.stringify({
      pages: {
        'Projetos.md': { id: 'projetos-db' },
        'Pessoas.md': { id: 'people-db' },
        'Recebimentos.md': { id: 'destination-db' },
        'Pessoas/Pessoa Um.md': { id: 'person-1' },
        'Recebimentos/Destino.md': { id: 'destination-row' },
        'Somente Leitura.md': { id: 'readonly-db' },
        'Somente Leitura/Registro Protegido.md': { id: 'readonly-row-1' },
        'Somente Leitura/Segundo Registro.md': { id: 'readonly-row-2' },
      },
    })
  );

  fs.writeFileSync(path.join(vaultDir, 'Projetos.md'), databaseMarkdown, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'Somente Leitura.md'), readOnlyMarkdown, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'Pessoas.md'), peopleMarkdown, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'Recebimentos.md'), destinationMarkdown, 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'Pessoas', 'Pessoa Um.md'), `---\n---\n# Pessoa Um\n`, 'utf8');
  fs.writeFileSync(
    path.join(vaultDir, 'Recebimentos', 'Destino.md'),
    `---\nQuantidade: 0\n---\n# Destino\n`,
    'utf8'
  );

  // Rows
  const rowsData = [
    { name: 'Projeto Alpha', qty: 10, note: 'Nota Alpha', active: true, date: '2026-10-25', rating: 2, website: 'https://alpha.example' },
    { name: 'Projeto Beta', qty: 20, note: 'Nota Beta', active: false, date: '2026-10-26', rating: 3, website: 'https://beta.example' },
    { name: 'Projeto Gamma', qty: 30, note: 'Nota Gamma', active: true, date: '2026-10-27', rating: 3, website: 'https://gamma.example' },
    { name: 'Projeto Delta', qty: 40, note: 'Nota Delta', active: false, date: '2026-10-28', rating: 4, website: 'https://delta.example' },
  ];

  for (const r of rowsData) {
    fs.writeFileSync(
      path.join(vaultDir, 'Projetos', `${r.name}.md`),
      `---
Quantidade: ${r.qty}
Observacoes: "${r.note}"
Ativo: ${r.active}
Status: todo
Avaliacao: ${r.rating}
Site: "${r.website}"
Prazo: "${r.date}"
---
# ${r.name}
`,
      'utf8'
    );
  }

  fs.writeFileSync(
    path.join(vaultDir, 'Somente Leitura', 'Registro Protegido.md'),
    '---\nQuantidade: 10\n---\n# Registro Protegido\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Somente Leitura', 'Segundo Registro.md'),
    '---\nQuantidade: 20\n---\n# Segundo Registro\n',
    'utf8',
  );

  console.log('1. Launching hidden Electron app...');
  const app = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['dist-electron/main.cjs'],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      MORROW_HIDDEN: '1',
      MORROW_USER_DATA: profileDir,
    },
  });

  const evidence = {
    timestamp: new Date().toISOString(),
    fixture: 'synthetic-only',
    hiddenWindowVerified: false,
    ticket32: {},
    ticket33: {},
    ticket34: {},
  };
  let evidencePath = null;
  let evidenceSaved = false;

  try {
    // 1. Invisible Window Verification
    const isAnyVisible = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().some((w) => w.isVisible());
    });
    console.log(`2. BrowserWindow.getAllWindows().some(w => w.isVisible()) === ${isAnyVisible}`);
    assert.strictEqual(isAnyVisible, false, 'Security violation: electron window must not be visible');
    evidence.hiddenWindowVerified = true;

    const page = await app.firstWindow();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.name || 'Error'));
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    await page.waitForTimeout(3000);

    const treeItems = await page.evaluate(() => {
      return [...document.querySelectorAll('.tree-row, .link-row')].map((el) => el.textContent.trim());
    });
    console.log('Tree items:', treeItems);

    // Open Projetos database page
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) =>
        el.textContent.includes('Projetos')
      );
      link?.click();
    });
    await page.waitForTimeout(2000);
    await page.waitForSelector('.db-table', { timeout: 15000 });
    console.log('4. Projetos table opened.');

    const cell = (rowIndex, propertyId) =>
      page.locator('table.db-table tbody tr').nth(rowIndex).locator(`td[data-col-id="${propertyId}"]`);
    const setNumber = async (target, value) => {
      await target.click();
      await page.keyboard.press('Enter');
      const input = target.locator('input.prop-input');
      await input.waitFor({ state: 'visible' });
      await input.fill(String(value));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
    };

    // ==========================================
    // TICKET #32: Roving focus and cell navigation
    // ==========================================
    console.log('5. Verifying Ticket #32: Roving focus and keyboard navigation...');

    // A) Check roving focus: single tab stop in table (tabIndex=0 on active td, -1 on others)
    const activeCells = await page.locator('table.db-table td[tabindex="0"]').count();
    assert.strictEqual(activeCells, 1, 'Exactly one td should have tabIndex=0 for roving focus');

    // Check .db-open button has tabIndex=-1
    const openBtnTabIndex = await page.locator('.db-open').first().getAttribute('tabindex');
    assert.strictEqual(openBtnTabIndex, '-1', '.db-open button must have tabIndex=-1 so Tab skips it');

    // B) Click cell (quantity column, row 1)
    const qtyCellRow1 = cell(0, 'quantity');
    await qtyCellRow1.click();
    await page.waitForTimeout(200);

    const isQty1Active = await qtyCellRow1.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isQty1Active, true, 'Clicked cell must have is-grid-active class');

    // C) Arrow key navigation
    await page.keyboard.press('ArrowRight'); // moves to notes column
    await page.waitForTimeout(100);
    const notesCellRow1 = cell(0, 'notes');
    const isNotesActive = await notesCellRow1.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isNotesActive, true, 'ArrowRight must move active cell to notes column');

    await page.keyboard.press('ArrowDown'); // moves to row 2
    await page.waitForTimeout(100);
    const notesCellRow2 = cell(1, 'notes');
    const isNotesRow2Active = await notesCellRow2.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isNotesRow2Active, true, 'ArrowDown must move active cell to row 2');

    // D) Boundary check: ArrowUp on top row does not crash
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    const isNotesTopActive = await notesCellRow1.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isNotesTopActive, true, 'ArrowUp at boundary stays at row 1 without crash');

    // E) Tab / Shift+Tab navigation
    await page.keyboard.press('Tab'); // moves to active column
    await page.waitForTimeout(100);
    const activeColRow1 = cell(0, 'active');
    const isActiveColActive = await activeColRow1.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isActiveColActive, true, 'Tab moves to next column');

    await page.keyboard.press('Shift+Tab'); // moves back to notes column
    await page.waitForTimeout(100);
    const isNotesBackActive = await notesCellRow1.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isNotesBackActive, true, 'Shift+Tab moves back to previous column');

    // F) Enter to edit and Enter to commit & move down
    await qtyCellRow1.click();
    await page.keyboard.press('Enter'); // enters editing mode
    await page.waitForTimeout(200);

    const inputLocator = qtyCellRow1.locator('input.prop-input');
    await inputLocator.waitFor({ state: 'visible', timeout: 5000 });
    await inputLocator.fill('15');
    await page.keyboard.press('Enter'); // commits and moves down to row 2
    await page.waitForTimeout(300);

    const qtyCellRow2 = cell(1, 'quantity');
    const isQty2ActiveAfterEnter = await qtyCellRow2.evaluate((el) => el.classList.contains('is-grid-active'));
    assert.strictEqual(isQty2ActiveAfterEnter, true, 'Enter in single-line edit commits and moves down');

    // G) Escape cancels draft
    await page.keyboard.press('Enter'); // edit row 2 quantity
    await page.waitForTimeout(200);
    const qty2Input = qtyCellRow2.locator('input.prop-input');
    await qty2Input.waitFor({ state: 'visible' });
    await qty2Input.fill('9999');
    await page.keyboard.press('Escape'); // cancel draft
    await page.waitForTimeout(200);
    const qty2Value = await qtyCellRow2.textContent();
    assert.ok(!qty2Value.includes('9999'), 'Escape must cancel draft without committing');

    // H) Multiline text, Tab navigation, and temporal draft cancellation
    await notesCellRow1.click();
    await page.keyboard.press('Enter');
    const notesEditor = notesCellRow1.locator('textarea.prop-input');
    await notesEditor.waitFor({ state: 'visible' });
    await notesEditor.fill('Line one\nLine two');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(150);
    const multilineText = await notesCellRow1.textContent();
    assert.ok(multilineText.includes('Line one') && multilineText.includes('Line two'), 'Ctrl+Enter commits multiline text without discarding its line break');

    await notesCellRow1.click();
    await page.keyboard.press('Enter');
    const tabEditor = notesCellRow1.locator('textarea.prop-input');
    await tabEditor.fill('Tab committed text');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    assert.ok((await notesCellRow1.textContent()).includes('Tab committed text'), 'Tab commits a multiline editor draft');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'active', 'Tab advances from the textarea to the next cell');

    // I) Checkbox and date edits remain drafts until commit
    const activeCellRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="active"]');
    await activeCellRow1.click();
    assert.strictEqual(await activeCellRow1.locator('[role="checkbox"]').getAttribute('aria-checked'), 'true', 'Clicking a grid checkbox cell must not toggle it before edit mode');
    await page.keyboard.press('Enter');
    const checkboxEditor = activeCellRow1.locator('input.prop-checkbox');
    await checkboxEditor.waitFor({ state: 'visible' });
    await page.keyboard.press('Space');
    assert.strictEqual(await checkboxEditor.isChecked(), false, 'Space changes the checkbox draft');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.strictEqual(await activeCellRow1.locator('[role="checkbox"]').getAttribute('aria-checked'), 'true', 'Escape discards the checkbox draft');

    const dateCellRow1 = cell(0, 'due_date');
    const originalDateText = await dateCellRow1.textContent();
    await dateCellRow1.click();
    await page.keyboard.press('Enter');
    const dateEditor = dateCellRow1.locator('input[type="date"]');
    await dateEditor.fill('2026-11-25');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.strictEqual(await dateCellRow1.textContent(), originalDateText, 'Escape discards a temporal draft');

    const ratingCellRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="rating"]');
    await ratingCellRow1.click();
    await page.keyboard.press('F2');
    const ratingEditor = ratingCellRow1.locator('input.prop-range');
    await ratingEditor.waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowRight');
    assert.strictEqual(await ratingEditor.inputValue(), '3', 'The range editor displays its uncommitted value');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.strictEqual(await ratingCellRow1.locator('.prop-scale-stars').getAttribute('aria-label'), '2', 'Escape discards a range editor draft');

    await ratingCellRow1.click();
    await page.keyboard.press('F2');
    await ratingCellRow1.locator('input.prop-range').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    assert.strictEqual(await ratingCellRow1.locator('.prop-scale-stars').getAttribute('aria-label'), '3', 'Tab commits a range editor draft');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'website', 'Tab advances from the range editor into the next grid cell');

    const websiteCellRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="website"]');
    await websiteCellRow1.click();
    await page.keyboard.press('F2');
    const websiteEditor = websiteCellRow1.locator('input.prop-input');
    await websiteEditor.waitFor({ state: 'visible' });
    await websiteEditor.fill('https://discard.example');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.ok((await websiteCellRow1.textContent()).includes('https://alpha.example'), 'Escape cancels a URL editor draft');

    await websiteCellRow1.click();
    await page.keyboard.press('F2');
    await websiteCellRow1.locator('input.prop-input').waitFor({ state: 'visible' });
    await page.locator('input.prop-input').fill('https://edited.example');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    assert.ok((await websiteCellRow1.textContent()).includes('https://edited.example'), 'Tab commits a URL editor draft');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'due_date', 'Tab advances from a URL editor into the next grid cell');

    // J) Select and relation pickers close back into the grid cell
    const statusCellRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="status"]');
    await statusCellRow1.click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('.option-picker').waitFor({ state: 'visible' });
    await page.locator('.option-picker .option-row').filter({ hasText: 'Done' }).click();
    await page.waitForTimeout(100);
    assert.ok((await statusCellRow1.textContent()).includes('Done'), 'Choosing a select option updates the cell');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'status', 'Closing a select picker returns focus to its grid cell');

    await page.keyboard.press('F2');
    await statusCellRow1.locator('.prop-select').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'status', 'Escape exits an unopened select editor back to its grid cell');
    await page.keyboard.press('F2');
    await statusCellRow1.locator('.prop-select').waitFor({ state: 'visible' });
    await page.keyboard.press('Shift+Tab');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'active', 'Shift+Tab from an unopened select editor returns to the prior cell');

    const ownerCellRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="owner"]');
    await ownerCellRow1.click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('.relation-picker').waitFor({ state: 'visible' });
    await page.locator('.relation-picker input').fill('Pessoa Um');
    await page.locator('.relation-picker .relation-option').filter({ hasText: 'Pessoa Um' }).click();
    await page.waitForTimeout(100);
    assert.ok((await ownerCellRow1.textContent()).includes('Pessoa Um'), 'Choosing a relation updates the cell');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'owner', 'Closing a relation picker returns focus to its grid cell');

    await page.keyboard.press('F2');
    await ownerCellRow1.locator('.prop-select').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'owner', 'Escape exits an unopened relation editor back to its grid cell');
    await page.keyboard.press('F2');
    await ownerCellRow1.locator('.prop-select').waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'rating', 'Tab from an unopened relation editor advances to the next cell');

    evidence.ticket32 = {
      rovingFocusVerified: true,
      openButtonTabIndexVerified: true,
      arrowNavigationVerified: true,
      boundariesVerified: true,
      tabShiftTabVerified: true,
      enterCommitAndMoveDownVerified: true,
      escapeCancelsDraftVerified: true,
      multilineCommitVerified: true,
      textareaTabCommitVerified: true,
      checkboxDraftAndCancelVerified: true,
      temporalDraftCancelVerified: true,
      scaleDraftCancelAndTabCommitVerified: true,
      urlDraftCancelAndTabCommitVerified: true,
      pickerTriggerEscapeAndTabVerified: true,
      selectPickerFocusVerified: true,
      relationPickerFocusVerified: true,
    };
    console.log('✓ Ticket #32 verified successfully.');

    console.log('5a. Verifying read-only database mutation protection...');
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) =>
        el.textContent.includes('Somente Leitura'),
      );
      link?.click();
    });
    await page.waitForSelector('.db-table', { timeout: 15000 });
    await page.locator('.db-readonly-note').waitFor({ state: 'visible' });
    const readOnlyTitleCell = page.locator('table.db-table tbody tr').filter({ hasText: 'Registro Protegido' }).locator('td[data-col-id="title"]');
    const readOnlyQtyRow1 = page.locator('table.db-table tbody tr').filter({ hasText: 'Registro Protegido' }).locator('td[data-col-id="quantity"]');
    const readOnlyQtyRow2 = page.locator('table.db-table tbody tr').filter({ hasText: 'Segundo Registro' }).locator('td[data-col-id="quantity"]');
    await readOnlyTitleCell.click();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(100);
    assert.ok((await readOnlyTitleCell.textContent()).includes('Registro Protegido'), 'Delete cannot rename a title in an unsupported read-only database');

    await page.evaluate(() => navigator.clipboard.writeText('Nome alterado pela colagem'));
    await readOnlyTitleCell.click();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    assert.ok((await readOnlyTitleCell.textContent()).includes('Registro Protegido'), 'Clipboard paste cannot mutate a read-only title');

    await readOnlyQtyRow1.click();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), '10', 'Copy remains available in a read-only database');

    await readOnlyQtyRow1.click();
    await page.keyboard.press('Alt+Shift+ArrowDown');
    assert.strictEqual(await page.locator('.db-fill-toolbar').count(), 0, 'Keyboard fill is unavailable in a read-only database');
    assert.ok((await readOnlyQtyRow2.textContent()).includes('20'), 'Keyboard fill leaves read-only rows unchanged');

    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) =>
        el.textContent.includes('Projetos'),
      );
      link?.click();
    });
    await page.waitForSelector('.db-table', { timeout: 15000 });
    await page.waitForTimeout(150);

    const alphaTitleCell = page.locator('table.db-table tbody tr').filter({ hasText: 'Projeto Alpha' }).locator('td[data-col-id="title"]');
    await alphaTitleCell.click();
    await page.keyboard.press('Alt+Enter');
    await page.locator('.row-props').waitFor({ state: 'visible' });
    await page.locator('.row-props .row-prop').filter({ hasText: 'Prazo' }).locator('.prop-cell-value').click();
    const pageDateInput = page.locator('.row-props input[type="date"]').first();
    await pageDateInput.waitFor({ state: 'visible' });
    await pageDateInput.focus();
    await page.evaluate(() => {
      const onTab = (event) => {
        if (event.key !== 'Tab') return;
        window.__pagePropertiesTabPrevented = event.defaultPrevented;
        document.removeEventListener('keydown', onTab);
      };
      document.addEventListener('keydown', onTab);
    });
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => window.__pagePropertiesTabPrevented), false, 'PageProperties does not prevent the browser Tab key');
    assert.strictEqual(await pageDateInput.inputValue(), '2026-10-25', 'Normal Tab navigation leaves the page property value intact');
    evidence.pagePropertiesTabVerified = true;
    evidence.ticket32.pagePropertiesTabVerified = true;
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) =>
        el.textContent.includes('Projetos'),
      );
      link?.click();
    });
    await page.waitForSelector('.db-table', { timeout: 15000 });
    await page.waitForTimeout(150);

    // ==========================================
    // TICKET #33: Cell ranges, clear, copy, paste
    // ==========================================
    console.log('6. Verifying Ticket #33: Cell ranges, clear, copy and paste...');

    // A) Shift+Arrows rectangular selection
    await qtyCellRow1.click();
    await page.waitForTimeout(100);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const selectedCells = await page.locator('table.db-table td.is-grid-selected').count();
    assert.strictEqual(selectedCells, 4, 'Shift+Arrows must select 2x2 rectangular range (4 cells)');

    // B) Batch clear with Delete key without deleting rows
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    const rowsCountAfterClear = await page.locator('table.db-table tbody tr').count();
    assert.strictEqual(rowsCountAfterClear, 4, 'Delete must clear cell values without deleting rows');

    // C) Undo batch clear
    const undoToastBtn = page.locator('.toast button', { hasText: 'Undo' }).or(page.locator('.toast button', { hasText: 'Desfazer' })).first();
    if (await undoToastBtn.isVisible()) {
      await undoToastBtn.click();
      await page.waitForTimeout(300);
    } else {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(300);
    }
    const qty1Restored = await qtyCellRow1.textContent();
    assert.ok(qty1Restored.includes('15') || qty1Restored.includes('10'), 'Undo must restore cleared cell values');

    // D) Copy & Paste
    await qtyCellRow1.click();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(200);

    const qtyCellRow3 = cell(2, 'quantity');
    await qtyCellRow3.click();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(300);

    const qty3Value = await qtyCellRow3.textContent();
    assert.ok(qty3Value.includes('15') || qty3Value.includes('10'), 'Paste must update destination cell value');

    // E) A newer system clipboard value must replace the cached in-app copy.
    await qtyCellRow1.click();
    await page.keyboard.press('Control+c');
    await page.evaluate(() => navigator.clipboard.writeText('External clipboard value'));
    const notesCellRow4 = cell(3, 'notes');
    await notesCellRow4.click();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(250);
    assert.ok((await notesCellRow4.textContent()).includes('External clipboard value'), 'Paste reads the current external clipboard instead of stale typed cache');

    await page.evaluate(() => navigator.clipboard.writeText('00123'));
    await page.locator('td.is-grid-active').click();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(250);
    assert.ok((await notesCellRow4.textContent()).includes('00123'), 'Plain text paste preserves leading zeroes');

    // F) The module cache carries typed grid data across separate database views.
    await qtyCellRow1.click();
    await page.keyboard.press('Control+c');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: () => Promise.reject(new Error('synthetic clipboard read block')),
      });
    });
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) => el.textContent.includes('Recebimentos'));
      link?.click();
    });
    await page.waitForSelector('.db-table', { timeout: 15000 });
    const destinationCell = page.locator('table.db-table tbody tr').first().locator('td[data-col-id="quantity"]');
    await destinationCell.click();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(250);
    assert.ok((await destinationCell.textContent()).includes('15'), 'A typed grid copy survives a view change when external clipboard reads fail');

    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.tree-row, .link-row')].find((el) => el.textContent.includes('Projetos'));
      link?.click();
    });
    await page.waitForSelector('.db-table', { timeout: 15000 });
    await page.waitForTimeout(150);

    // G) Read-only column protection
    const formulaCell = cell(0, 'formula_calc');
    await formulaCell.click();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    const errorToast = page.locator('.toast');
    const toastCount = await errorToast.count();
    assert.ok(toastCount > 0, 'Attempt to clear read-only column must show error/refusal toast');

    evidence.ticket33 = {
      rectangularSelectionVerified: true,
      batchClearVerified: true,
      batchUndoVerified: true,
      copyPasteVerified: true,
      externalClipboardWinsOverCacheVerified: true,
      leadingZeroTextPreservedVerified: true,
      typedClipboardAcrossViewsVerified: true,
      readOnlyColumnProtectionVerified: true,
      readOnlyMutationProtectionVerified: true,
    };
    console.log('✓ Ticket #33 verified successfully.');

    // ==========================================
    // TICKET #34: Fill Handle with preview & progression
    // ==========================================
    console.log('7. Verifying Ticket #34: Fill handle with seed progression...');

    // Set a two-cell numeric source and sentinel values in its fill targets.
    await setNumber(qtyCellRow1, 10);
    await setNumber(qtyCellRow2, 20);
    const qtyRow4 = cell(3, 'quantity');
    await setNumber(qtyCellRow3, 99);
    await setNumber(qtyRow4, 99);

    // Select row 1 and row 2 in quantity column
    await qtyCellRow1.click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    // Check fill handle is visible on bottom-right cell (row 2)
    const fillHandle = qtyCellRow2.locator('.db-fill-handle');
    await fillHandle.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await fillHandle.isVisible(), true, 'Fill handle must be visible on bottom-right selected cell');

    // Drag fill handle from row 2 to row 4
    const handleBox = await fillHandle.boundingBox();
    const targetBox = await qtyRow4.boundingBox();

    assert.ok(handleBox && targetBox, 'Bounding boxes must be available for fill handle and target');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Hover over row 4
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
    await page.waitForTimeout(500);

    // Check preview class is present
    const isPreviewVisible = await qtyRow4.evaluate((el) => el.classList.contains('is-fill-preview'));
    assert.strictEqual(isPreviewVisible, true, 'Target cell must display is-fill-preview during drag');

    // Releasing the handle keeps a visible preview and does not commit values.
    await page.mouse.up();
    await page.locator('.db-fill-toolbar').waitFor({ state: 'visible' });
    await page.waitForTimeout(250);
    assert.strictEqual(await qtyCellRow3.getAttribute('data-fill-preview'), '10', 'Copy mode displays the planned value before commit');
    assert.strictEqual(await qtyRow4.getAttribute('data-fill-preview'), '20', 'Copy mode repeats the selected source range');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.ok((await qtyCellRow3.textContent()).includes('99'), 'Cancelling the drag preview leaves the actual target value unchanged');
    assert.ok((await qtyRow4.textContent()).includes('99'), 'Cancelling leaves every target unchanged');

    await qtyCellRow1.click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await page.locator('.db-fill-toolbar').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.db-fill-actions button'));
    assert.strictEqual(await qtyCellRow3.getAttribute('data-fill-preview'), '10', 'Keyboard fill previews copy mode by default');
    const sequenceChoice = page.locator('.db-fill-actions button').filter({ hasText: /Continue sequence|Continuar serie|Continuar sequência/ });
    assert.strictEqual(await page.evaluate(() => document.activeElement?.textContent?.trim()), await page.locator('.db-fill-actions button').first().textContent().then((text) => text.trim()), 'Keyboard fill places focus on the first toolbar action');
    await page.keyboard.press('Tab');
    assert.strictEqual(await sequenceChoice.evaluate((el) => document.activeElement === el), true, 'Tab moves keyboard focus to the sequence choice');
    await page.keyboard.press('Enter');
    assert.strictEqual(await sequenceChoice.getAttribute('aria-pressed'), 'true', 'Sequence mode is an explicit user choice');
    assert.strictEqual(await qtyCellRow3.getAttribute('data-fill-preview'), '30', 'Sequence choice updates the visible preview');
    assert.strictEqual(await qtyRow4.getAttribute('data-fill-preview'), '40', 'Sequence preview shows the planned value in each target');
    const applyFillChoice = page.locator('.db-fill-actions button').filter({ hasText: /Apply fill|Aplicar relleno|Aplicar preenchimento/ });
    await page.keyboard.press('Tab');
    assert.strictEqual(await applyFillChoice.evaluate((el) => document.activeElement === el), true, 'Tab moves keyboard focus to Apply fill');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // Verify progression: row 3 gets 30, row 4 gets 40
    const qty3TextAfterFill = await qtyCellRow3.textContent();
    const qty4TextAfterFill = await qtyRow4.textContent();
    console.log(`Fill results: Row 3 = "${qty3TextAfterFill}", Row 4 = "${qty4TextAfterFill}"`);
    assert.ok(qty3TextAfterFill.includes('30'), 'Arithmetic sequence must fill row 3 with 30');
    assert.ok(qty4TextAfterFill.includes('40'), 'Arithmetic sequence must fill row 4 with 40');

    // Keyboard-only fill preview uses copy mode and can be cancelled without applying.
    await qtyCellRow1.click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await page.locator('.db-fill-toolbar').waitFor({ state: 'visible' });
    assert.strictEqual(await qtyCellRow3.getAttribute('data-fill-preview'), '10', 'Keyboard fill previews a repeated copy by default');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const cancelFillChoice = page.locator('.db-fill-actions button').filter({ hasText: /Cancel|Cancelar/ });
    assert.strictEqual(await cancelFillChoice.evaluate((el) => document.activeElement === el), true, 'Tab reaches the Cancel fill action');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    assert.ok((await qtyCellRow3.textContent()).includes('30'), 'The keyboard Cancel action leaves the target unchanged');

    await qtyCellRow1.click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await page.locator('.db-fill-toolbar').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.ok((await qtyCellRow3.textContent()).includes('30'), 'Escape cancels a keyboard fill preview');

    // Frozen and hidden column changes preserve a valid active cell and move focus when needed.
    const quantityHeader = page.locator('table.db-table thead th').filter({ hasText: 'Quantidade' }).first();
    await quantityHeader.click({ button: 'right' });
    await page.locator('.menu .menu-item').filter({ hasText: /Freeze through this column|Fijar hasta esta columna|Congelar hasta esta columna|Congelar até esta coluna/ }).click();
    assert.strictEqual(await cell(0, 'quantity').evaluate((el) => el.classList.contains('db-frozen')), true, 'Frozen columns remain marked in the grid');

    await page.locator('.db-tools .text-tool').filter({ hasText: /Properties|Propiedades|Propriedades/ }).click();
    const quantityPropertyRow = page.locator('.db-prop-list li').filter({ hasText: 'Quantidade' }).first();
    await quantityPropertyRow.locator('button').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody td[data-col-id="quantity"]').length === 0);
    await page.waitForTimeout(100);
    assert.notStrictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'quantity', 'Hiding the active column moves the active cell into the visible grid');
    await quantityPropertyRow.locator('button').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody td[data-col-id="quantity"]').length === 4);
    await page.keyboard.press('Escape');

    // Sorting retains the focused row; filtering a focused-out row moves focus into the visible result.
    const alphaRow = page.locator('.db-table tbody tr').filter({ hasText: 'Projeto Alpha' });
    await alphaRow.locator('td[data-col-id="quantity"]').click();
    await quantityHeader.click({ button: 'right' });
    await page.locator('.menu .menu-item').filter({ hasText: /Sort descending|Ordenar de forma descendente|Ordenar em ordem decrescente/ }).click();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-row-id'), await alphaRow.locator('td[data-col-id="quantity"]').getAttribute('data-row-id'), 'Sorting keeps focus attached to the selected row');

    await page.locator('.db-filter-chip-add').first().click();
    await page.locator('.db-filter-chip').first().click();
    await page.locator('.db-filter-popover-content input[type="text"]').fill('Delta');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 1);
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('td.is-grid-active').getAttribute('data-col-id'), 'quantity', 'Filtering revalidates the active cell while preserving its visible column');
    const activeRowText = await page.locator('td.is-grid-active').evaluate((el) => el.parentElement?.textContent ?? '');
    assert.ok(activeRowText.includes('Projeto Delta'), 'Filtering moves focus to a visible row when the previous row is removed');

    evidence.ticket34 = {
      fillHandleRenderedVerified: true,
      fillPreviewVerified: true,
      arithmeticSequenceVerified: true,
      explicitFillModeVerified: true,
      keyboardFillAlternativeVerified: true,
      fillCancelVerified: true,
      hiddenWindowVerified: true,
      frozenColumnVerified: true,
      hiddenColumnFocusRevalidationVerified: true,
      sortedAndFilteredFocusRevalidationVerified: true,
    };
    console.log('✓ Ticket #34 verified successfully.');

    const stillHidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    );
    assert.strictEqual(stillHidden, true, 'the Electron window must remain hidden for the full verification');
    assert.strictEqual(pageErrors.length, 0, 'the renderer must not report page errors during verification');
    evidence.hiddenWindowVerified = true;
    evidence.rendererPageErrorsVerified = true;

    // Save sanitized evidence in the repository; temporary profile and vault paths stay private.
    evidencePath = path.join(process.cwd(), 'docs', 'evidence', 'interaction-expansion-delivery4-ui.json');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    const evidenceJson = JSON.stringify(evidence, null, 2);
    assert.ok(!evidenceJson.includes(root), 'durable evidence must not disclose temporary profile or vault paths');
    fs.writeFileSync(evidencePath, evidenceJson, 'utf8');
    evidenceSaved = true;
    console.log('8. Sanitized UI evidence saved in docs/evidence.');

  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(root), false, 'the temporary profile and synthetic vault must be cleaned up');
    if (evidenceSaved && evidencePath) {
      evidence.cleanupVerified = true;
      const cleanedEvidence = JSON.stringify(evidence, null, 2);
      assert.ok(!cleanedEvidence.includes(root), 'durable evidence must remain free of temporary paths after cleanup');
      fs.writeFileSync(evidencePath, cleanedEvidence, 'utf8');
    }
  }
}

main().catch((err) => {
  console.error('UI verification failed:', err);
  process.exit(1);
});
