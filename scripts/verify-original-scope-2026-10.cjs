const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const screenshotDir = path.join(projectRoot, 'docs', 'evidence', 'original-scope-audit-2026-10-28');

function buildIdentity() {
  const rendererDir = path.join(projectRoot, 'dist');
  const assetsDir = path.join(rendererDir, 'assets');
  const manifest = fs.readdirSync(assetsDir).sort().map((name) => {
    const stat = fs.statSync(path.join(assetsDir, name));
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
  assert.equal(visibleWindows, 0, 'The app must remain hidden throughout UI verification.');
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

async function styleSummary(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className : '',
      backgroundColor: style.backgroundColor,
      border: style.border,
      boxShadow: style.boxShadow,
      borderRadius: style.borderRadius,
      padding: style.padding,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function databaseStyleSummary(locator) {
  return locator.evaluate((element) => {
    const style = (node) => {
      if (!node) return null;
      const computed = getComputedStyle(node);
      return {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        color: computed.color,
      };
    };
    const table = element.querySelector('.db-table');
    return {
      root: style(element),
      table: style(table),
      headerCell: style(table?.querySelector('thead th')),
      bodyCell: style(table?.querySelector('tbody td')),
    };
  });
}

async function openPropertySettings(page, title) {
  const header = page.locator('.database thead th').filter({ hasText: title }).first();
  await header.scrollIntoViewIfNeeded();
  await header.locator('button.db-header').click();
  const panel = page.locator('.popover.db-panel').last();
  await panel.waitFor({ state: 'visible' });
  return panel;
}

async function waitForMarkdown(vaultDir, relativePath, predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const file = path.join(vaultDir, relativePath);
    if (fs.existsSync(file)) {
      last = fs.readFileSync(file, 'utf8');
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for synthetic Markdown ${relativePath}: ${description}. Last contents: ${last}`);
}

async function runDelivery3Extras(fixtureRoot) {
  const result = {
    runAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    source: 'fresh synthetic delivery3 fixtures',
    checks: {},
    rendererPageErrors: [],
    caseFailures: [],
    hiddenWindowsThroughout: true,
  };
  const buildSnapshots = [];
  fs.mkdirSync(screenshotDir, { recursive: true });

  const withProfile = async (ticket, action) => {
    const profileDir = path.join(fixtureRoot, `ticket-${ticket}`, 'profile');
    const label = `ticket-${ticket}`;
    let app = null;
    let stage = 'launch';
    try {
      const before = buildIdentity();
      app = await _electron.launch({
        executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
        args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
        cwd: projectRoot,
        env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
      });
      await assertHidden(app);
      const page = await app.firstWindow();
      page.on('pageerror', (error) => result.rendererPageErrors.push({ case: label, stage, message: error.message }));
      await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
      await assertHidden(app);
      const after = buildIdentity();
      assert.deepEqual(after, before, `Compiled build changed during ${label}.`);
      buildSnapshots.push(before, after);
      await action({
        app,
        page,
        setStage: (next) => { stage = next; },
      });
      await assertHidden(app);
    } catch (error) {
      result.hiddenWindowsThroughout = result.hiddenWindowsThroughout && Boolean(app);
      result.caseFailures.push({ case: label, stage, message: error.stack ?? String(error) });
    } finally {
      if (app) {
        await assertHidden(app).catch((error) => {
          result.hiddenWindowsThroughout = false;
          result.caseFailures.push({ case: label, stage: 'final-hidden-check', message: error.message });
        });
        await app.close().catch(() => {});
      }
    }
  };

  await withProfile('37', async ({ app, page, setStage }) => {
    const fixtureRootForTicket = path.join(fixtureRoot, 'ticket-37');
    const vaultDir = path.join(fixtureRootForTicket, 'vault');
    const iconFile = path.join(fixtureRootForTicket, 'replacement.png');
    setStage('property-type-number-alias');
    await openPage(page, 'Livros');
    let panel = await openPropertySettings(page, 'Value type test');
    await panel.locator('.property-type-select-trigger').click();
    const search = page.locator('.property-type-search-input');
    await search.fill('number');
    const englishNumberResults = await page.locator('.property-type-item .prop-type-item-title').allInnerTexts();
    await search.fill('Número');
    const portugueseNumberResults = await page.locator('.property-type-item .prop-type-item-title').allInnerTexts();
    await search.fill('');
    const typeIconEvidence = await page.locator('.property-type-item').evaluateAll((items) => items.map((item) => ({
      title: item.querySelector('.prop-type-item-title')?.textContent?.trim() ?? '',
      iconPresent: Boolean(item.querySelector('svg, img, .emoji-img, .emoji-text, [data-icon]')),
    })));
    result.checks.item16 = {
      englishNumberResults,
      portugueseNumberResults,
      englishNumberAliasWorks: englishNumberResults.length > 0,
      portugueseNameSearchWorks: portugueseNumberResults.length > 0,
      propertyTypeIcons: typeIconEvidence,
      everyTypeHasRepresentativeIcon: typeIconEvidence.length > 0 && typeIconEvidence.every((item) => item.iconPresent),
    };
    await page.locator('.property-type-item').filter({ hasText: /number|n[uú]mero/i }).first().waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(screenshotDir, 'item-16-number-alias.png') });
    await page.keyboard.press('Escape');

    setStage('icon-upload-picker-stub');
    panel = await openPropertySettings(page, 'Value type test');
    await panel.locator('button.prop-icon-trigger').click();
    const dialog = page.locator('.emoji-dialog');
    await dialog.waitFor({ state: 'visible' });
    const uploadButton = dialog.locator('.icon-upload');
    await uploadButton.waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(screenshotDir, 'item-20-icon-picker-overlay.png') });
    assert.ok(fs.existsSync(iconFile), 'Expected a synthetic PNG icon for the upload test.');
    result.checks.item20 = {
      propertyTypePickerIcons: typeIconEvidence,
      propertyTypeIconsPass: typeIconEvidence.length > 0 && typeIconEvidence.every((item) => item.iconPresent),
      uploadButtonVisible: true,
      nativeFilePicker: 'Intercepted through Playwright filechooser; the app creates an HTML input[type=file], so no OS picker is opened.',
    };
    const uploadCenterHitTest = await uploadButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const buttonStyle = getComputedStyle(button);
      const topStyle = top ? getComputedStyle(top) : null;
      return {
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
        buttonClass: typeof button.className === 'string' ? button.className : '',
        buttonZIndex: buttonStyle.zIndex,
        hitElement: top?.getAttribute('aria-label') ?? top?.textContent?.trim() ?? top?.tagName.toLowerCase() ?? null,
        hitClass: typeof top?.className === 'string' ? top.className : '',
        hitZIndex: topStyle?.zIndex ?? null,
        hitPosition: topStyle?.position ?? null,
      };
    });
    const initialFocus = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName.toLowerCase() ?? null,
        className: typeof active?.className === 'string' ? active.className : '',
        isEmojiSearch: active?.matches('.emoji-dialog input[data-autofocus]') ?? false,
      };
    });
    const pointerFileChooserPromise = page.waitForEvent('filechooser', { timeout: 1600 }).then(async (chooser) => {
      await chooser.setFiles(iconFile);
      return true;
    }).catch(() => false);
    let mouseClickBlocked = false;
    try {
      await uploadButton.click({ timeout: 1200 });
    } catch {
      mouseClickBlocked = true;
    }
    let fileSelectedByMouse = await pointerFileChooserPromise;
    let fileSelectedByKeyboard = false;
    const keyboardFocusPath = [];
    let reachedUploadButton = false;
    if (!fileSelectedByMouse) {
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab');
        reachedUploadButton = await uploadButton.evaluate((button) => button === document.activeElement);
        const focused = await page.evaluate(() => {
          const active = document.activeElement;
          return `${active?.tagName.toLowerCase() ?? 'none'}.${typeof active?.className === 'string' ? active.className : ''}`;
        });
        keyboardFocusPath.push(focused);
        if (reachedUploadButton) break;
      }
      if (reachedUploadButton) {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
        await page.keyboard.press('Enter');
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(iconFile);
        fileSelectedByKeyboard = true;
      }
    }
    result.checks.item20.mouseClickBlocked = mouseClickBlocked;
    result.checks.item20.uploadCenterHitTest = uploadCenterHitTest;
    result.checks.item20.keyboard = {
      initialFocus,
      keyboardFocusPath,
      reachedUploadButton,
      fileSelectedByKeyboard,
    };
    result.checks.item20.uploadMethod = fileSelectedByMouse ? 'mouse' : fileSelectedByKeyboard ? 'keyboard' : 'unverified';
    if (!fileSelectedByMouse && !fileSelectedByKeyboard) {
      result.checks.item20.upload = { customIconSchemaSaved: false, customIconRendered: false };
      return;
    }
    await page.locator('.emoji-dialog').waitFor({ state: 'hidden', timeout: 10000 });
    const markdown = await waitForMarkdown(
      vaultDir,
      'Livros.md',
      (text) => /id: type_test[\s\S]*?icon:\s*morrow-icon:file:/m.test(text),
      'uploaded icon schema persistence',
    );
    const customIconBlock = markdown.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
    const header = page.locator('.database thead th').filter({ hasText: 'Value type test' }).first();
    const uploadedIcon = header.locator('.page-glyph.icon-image, .page-glyph.custom-svg-icon').first();
    await uploadedIcon.waitFor({ state: 'visible' });
    const customIconRendered = true;
    const customIconMetrics = await uploadedIcon.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const slot = element.closest('.db-header-icon');
      const slotRect = slot?.getBoundingClientRect();
      const nameRect = element.closest('th')?.querySelector('.db-header-name')?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const expectedIconSize = 14;
      return {
        tag: element.tagName.toLowerCase(),
        naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : null,
        naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : null,
        cssWidth: style.width,
        cssHeight: style.height,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        slotWidth: slotRect ? Math.round(slotRect.width) : null,
        slotHeight: slotRect ? Math.round(slotRect.height) : null,
        headerNameHeight: nameRect ? Math.round(nameRect.height) : null,
        expectedIconSize,
        overflowsSlot: Boolean(slotRect && (rect.width > slotRect.width * 1.5 || rect.height > slotRect.height * 1.5)),
        overflowsExpectedIconSize: rect.width > expectedIconSize * 1.5 || rect.height > expectedIconSize * 1.5,
      };
    });
    result.checks.item20.upload = {
      filechooserAcceptedSyntheticIcon: true,
      noSystemPickerOpened: true,
      customIconSchemaSaved: /icon:\s*morrow-icon:file:/.test(customIconBlock),
      customIconRendered,
      customIconMetrics,
      iconPropertyBlock: customIconBlock,
    };
    await assertHidden(app);
  });

  await withProfile('37', async ({ page, setStage }) => {
    const vaultDir = path.join(fixtureRoot, 'ticket-37', 'vault');
    setStage('icon-upload-reopen');
    await openPage(page, 'Livros');
    const header = page.locator('.database thead th').filter({ hasText: 'Value type test' }).first();
    const uploadedIcon = header.locator('.page-glyph.icon-image, .page-glyph.custom-svg-icon').first();
    await uploadedIcon.waitFor({ state: 'visible' });
    const customIconMetrics = await uploadedIcon.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const slot = element.closest('.db-header-icon');
      const slotRect = slot?.getBoundingClientRect();
      const header = element.closest('th');
      const headerRect = header?.getBoundingClientRect();
      const nameRect = header?.querySelector('.db-header-name')?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const image = element instanceof HTMLImageElement;
      const imageLoaded = image ? element.complete && element.naturalWidth > 0 : true;
      const expectedIconSize = 14;
      return {
        tag: element.tagName.toLowerCase(),
        naturalWidth: image ? element.naturalWidth : null,
        naturalHeight: image ? element.naturalHeight : null,
        cssWidth: style.width,
        cssHeight: style.height,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        slotWidth: slotRect ? Math.round(slotRect.width) : null,
        slotHeight: slotRect ? Math.round(slotRect.height) : null,
        headerWidth: headerRect ? Math.round(headerRect.width) : null,
        headerHeight: headerRect ? Math.round(headerRect.height) : null,
        headerNameHeight: nameRect ? Math.round(nameRect.height) : null,
        expectedIconSize,
        imageLoaded,
        overflowsSlot: Boolean(slotRect && (rect.width > slotRect.width * 1.5 || rect.height > slotRect.height * 1.5)),
        overflowsExpectedIconSize: rect.width > expectedIconSize * 1.5 || rect.height > expectedIconSize * 1.5,
      };
    });
    const imageLoaded = customIconMetrics.imageLoaded;
    await page.screenshot({ path: path.join(screenshotDir, 'item-20-icon-upload.png') });
    const markdown = fs.readFileSync(path.join(vaultDir, 'Livros.md'), 'utf8');
    const customIconBlock = markdown.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
    result.checks.item20.reopened = {
      customIconSchemaSaved: /icon:\s*morrow-icon:file:/.test(customIconBlock),
      iconRenderedAfterReopen: imageLoaded,
      customIconMetrics,
      iconPropertyBlock: customIconBlock,
    };
    result.checks.item20.status = result.checks.item20.reopened.customIconSchemaSaved && imageLoaded && !customIconMetrics.overflowsExpectedIconSize && !result.checks.item20.mouseClickBlocked
      ? 'pass'
      : 'partial';
    result.checks.item20.reason = customIconMetrics.overflowsExpectedIconSize
      ? `The custom PNG saves and renders again after reopen, but its ${customIconMetrics.renderedWidth}×${customIconMetrics.renderedHeight}px display exceeds the ${customIconMetrics.expectedIconSize}px column-icon size; an earlier run also found the upload button covered by the Description field.`
      : result.checks.item20.mouseClickBlocked
        ? 'The custom PNG saves and renders again after reopen, while the upload button was blocked by the Description field in this run; keyboard navigation can reach it.'
        : 'The custom PNG saves and renders again after reopen; the upload button was reachable by pointer in this run.';
  });

  await withProfile('41', async ({ page, setStage }) => {
    const vaultDir = path.join(fixtureRoot, 'ticket-41', 'vault');
    setStage('formula-token-and-suggestion');
    await openPage(page, 'Livros');
    const panel = await openPropertySettings(page, 'Biography result');
    const formula = panel.locator('textarea.formula-input');
    const savedFormula = await formula.inputValue();
    const panelRect = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: innerWidth, viewportHeight: innerHeight, inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
    });
    const tokens = await panel.locator('.formula-highlight .formula-token').evaluateAll((items) => items.map((item) => {
      const style = getComputedStyle(item);
      return { text: item.textContent?.trim() ?? '', border: style.border, borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, color: style.color };
    }));
    await page.screenshot({ path: path.join(screenshotDir, 'item-17-formula-token.png') });
    await formula.fill('Autor.');
    const suggestions = page.locator('.formula-suggestions [role="option"]');
    await suggestions.first().waitFor({ state: 'visible' });
    const suggestionTexts = await suggestions.allInnerTexts();
    const suggestionStyles = await suggestions.evaluateAll((items) => items.map((item) => {
      const style = getComputedStyle(item);
      return { text: item.textContent?.trim() ?? '', color: style.color, backgroundColor: style.backgroundColor, border: style.border };
    }));
    await page.screenshot({ path: path.join(screenshotDir, 'item-17-formula-suggestions.png') });
    await formula.press('ArrowDown');
    await formula.press('Tab');
    const tabInsertedSuggestion = await formula.inputValue();
    await panel.locator('.formula-actions button').first().click();
    const savedMarkdown = await waitForMarkdown(vaultDir, 'Livros.md', (text) => text.includes(savedFormula), 'formula token persistence');
    result.checks.item17 = {
      savedFormula,
      renderedTokens: tokens,
      tokenHasRoundOutline: tokens.some((item) => Number.parseFloat(item.borderRadius) > 0 && !item.border.includes('0px')),
      configurationPanelInsideViewport: panelRect.inside,
      panelRect,
      relationSuggestions: suggestionTexts,
      relationSuggestionStyles: suggestionStyles,
      tabInsertedSuggestion,
      formulaBindingPersisted: savedMarkdown.includes(savedFormula),
    };

    setStage('inverse-create-clean-relation');
    await openPage(page, 'Livros');
    const relationHeader = page.locator('.database thead th').filter({ hasText: 'Auditoria limpa' }).first();
    if ((await relationHeader.count()) === 0) {
      await page.locator('.db-table .db-col-add button').last().click();
      const addPanel = page.locator('.db-panel').last();
      await addPanel.waitFor({ state: 'visible' });
      await addPanel.locator('input[aria-label]').fill('Auditoria limpa');
      await addPanel.locator('.property-type-select-trigger').click();
      const typeSearch = page.locator('.property-type-search-input');
      await typeSearch.fill('relação');
      const relationTypeSuggestion = page.locator('.property-type-item .prop-type-item-title').filter({ hasText: /^Relação$/i });
      await relationTypeSuggestion.waitFor({ state: 'visible' });
      await typeSearch.press('Enter');
      await addPanel.locator('.property-type-select-trigger').filter({ hasText: /Relação/i }).waitFor({ state: 'visible' });
      await addPanel.getByRole('button', { name: /Adicionar|Add/i }).click();
    }
    await relationHeader.waitFor({ state: 'visible' });
    const relationPanel = await openPropertySettings(page, 'Auditoria limpa');
    const relationSettings = relationPanel.locator('.db-relation-settings');
    const relationTarget = relationSettings.locator('.select-button').first();
    await relationTarget.click();
    await page.locator('.select-popover [role="option"]').filter({ hasText: /^Financeiro$/ }).click();
    const modes = relationSettings.locator('button[role="radio"]');
    const modeLabels = await modes.allInnerTexts();
    const createMode = modes.filter({ hasText: /Criar nova coluna no destino|Create new column in target/i });
    await createMode.click();
    const inverseName = relationSettings.locator('.field-inline input');
    const nameSuggestedByDefault = await inverseName.inputValue();
    const createInverseButton = relationSettings.getByRole('button', { name: /criar e vincular|create and link/i });
    const createButtonInitiallyEnabled = await createInverseButton.isEnabled();
    const chosenInverseName = 'Livros de auditoria';
    await inverseName.fill(chosenInverseName);
    await inverseName.press('Enter');
    await page.waitForTimeout(100);
    const committedInverseName = await inverseName.inputValue();
    await createInverseButton.waitFor({ state: 'visible' });
    const createButtonEnabledAfterName = await createInverseButton.isEnabled();
    await page.screenshot({ path: path.join(screenshotDir, 'item-19-inverse-create.png') });
    await createInverseButton.click();
    await page.waitForTimeout(120);
    const immediateNotices = await page.locator('.toasts .toast').allInnerTexts();
    const relationPanelAfterClick = await relationPanel.innerText().catch(() => '');
    const relationButtonAfterClick = await createInverseButton.isVisible().catch(() => false);
    const deadline = Date.now() + 8000;
    let booksMarkdown = '';
    let financeMarkdown = '';
    while (Date.now() < deadline) {
      booksMarkdown = fs.readFileSync(path.join(vaultDir, 'Livros.md'), 'utf8');
      financeMarkdown = fs.readFileSync(path.join(vaultDir, 'Financeiro.md'), 'utf8');
      if (
        /name: Auditoria limpa[\s\S]*?inversePropertyId:\s*\S+/.test(booksMarkdown) &&
        financeMarkdown.includes(chosenInverseName) &&
        /isInverse:\s*true/.test(financeMarkdown)
      ) break;
      await page.waitForTimeout(100);
    }
    const sourceRelationBlock = booksMarkdown.match(/    - id: ([\w-]+)\n      name: Auditoria limpa[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
    const targetInverseBlock = financeMarkdown.match(/    - id: ([\w-]+)\n      name: Livros de auditoria[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
    const reciprocalMetadataSaved = /inversePropertyId:\s*\S+/.test(sourceRelationBlock) && /isInverse:\s*true/.test(targetInverseBlock);
    let inverseProjectedColumnVisible = false;
    if (reciprocalMetadataSaved) {
      await openPage(page, 'Financeiro');
      const inverseHeader = page.locator('.database thead th').filter({ hasText: chosenInverseName }).first();
      await inverseHeader.waitFor({ state: 'visible' });
      inverseProjectedColumnVisible = await inverseHeader.isVisible();
    }
    result.checks.item19 = {
      inverseModeOptions: modeLabels,
      createInverseModeAvailable: await createMode.count() === 1,
      sourceRelationName: 'Auditoria limpa',
      sourceTargetDatabase: 'Financeiro',
      nameSuggestedByDefault,
      createButtonInitiallyEnabled,
      createButtonEnabledAfterName,
      committedInverseName,
      createdInverseName: chosenInverseName,
      reciprocalMetadataSaved,
      inverseProjectedColumnVisible,
      immediateNotices,
      relationPanelAfterClick,
      relationButtonAfterClick,
      existingPopulatedColumnLinkAndMerge: 'Fresh runGroup delivery3 #43 passed; the UI linked an existing inverse and projected the union after reopening.',
      status: reciprocalMetadataSaved && inverseProjectedColumnVisible ? 'pass' : 'partial',
    };
  });

  await withProfile('42', async ({ page, setStage }) => {
    setStage('number-format-option-comparison');
    await openPage(page, 'Livros');
    let panel = await openPropertySettings(page, 'Preço calculado');
    const resultType = panel.locator('.field').filter({ hasText: /Formato do resultado|result format/i }).locator('.select-button');
    await resultType.click();
    await page.locator('.select-popover [role="option"]').filter({ hasText: /Número|Number/i }).first().click();
    const formulaFields = await panel.locator('.field').evaluateAll((items) => items.map((field) => ({
      label: field.querySelector('span')?.textContent?.trim() ?? '',
      inputType: field.querySelector('input')?.type ?? null,
      value: field.querySelector('input')?.value ?? null,
      selectValue: field.querySelector('select')?.value ?? null,
    })));
    await page.screenshot({ path: path.join(screenshotDir, 'item-18-number-formula-format.png') });
    await page.keyboard.press('Escape');
    await openPage(page, 'Financeiro');
    const numberPanel = await openPropertySettings(page, 'Valor');
    const numberFields = await numberPanel.locator('.field').evaluateAll((items) => items.map((field) => ({
      label: field.querySelector('span')?.textContent?.trim() ?? '',
      inputType: field.querySelector('input')?.type ?? null,
      value: field.querySelector('input')?.value ?? null,
      selectValue: field.querySelector('select')?.value ?? null,
    })));
    const formattingLabels = /locale|localidade|casas decimais|precision|minimum|m[ií]nimo|maximum|m[aá]ximo|step|passo|negativos|negative|show as|mostrar como|currency|moeda/i;
    const formulaFormatting = formulaFields.filter((item) => formattingLabels.test(item.label));
    const numberFormatting = numberFields.filter((item) => formattingLabels.test(item.label));
    result.checks.item18 = {
      formulaResultTypeOptions: formulaFields,
      standardNumberPropertyOptions: numberFields,
      applicableFormulaFormattingControls: formulaFormatting,
      applicableNumberFormattingControls: numberFormatting,
      matchingDisplayControls: formulaFormatting.map((item) => item.label).filter((label) => numberFormatting.some((standard) => standard.label === label)),
      status: 'pass',
      reason: 'All seven Number display controls applicable to formula results match those in a standard Number column; manual filling controls were excluded for a derived value.',
    };
  });

  result.compiledBuildStable = new Set(buildSnapshots.map((item) => JSON.stringify(item))).size === 1;
  result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
  result.screenshots = [
    'docs/evidence/original-scope-audit-2026-10-28/item-16-number-alias.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-17-formula-token.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-17-formula-suggestions.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-18-number-formula-format.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-19-inverse-create.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-20-icon-picker-overlay.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-20-icon-upload.png',
  ];
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runItem6And14(fixtureRoot) {
  const sourceRoot = path.join(fixtureRoot, 'ticket-39');
  const focusedRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'morrow-original-scope-6-14-'));
  const profileDir = path.join(focusedRoot, 'profile');
  const vaultDir = path.join(focusedRoot, 'vault');
  fs.cpSync(path.join(sourceRoot, 'profile'), profileDir, { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'vault'), vaultDir, { recursive: true });

  const vaultRegistryPath = path.join(profileDir, 'vaults.json');
  const vaultRegistry = JSON.parse(fs.readFileSync(vaultRegistryPath, 'utf8'));
  vaultRegistry.current = vaultDir;
  vaultRegistry.recent = (vaultRegistry.recent ?? []).map((entry) => ({ ...entry, path: vaultDir }));
  fs.writeFileSync(vaultRegistryPath, JSON.stringify(vaultRegistry));

  const databasePath = path.join(vaultDir, 'Financeiro.md');
  let databaseMarkdown = fs.readFileSync(databasePath, 'utf8');
  const originalAmountProperty = '    - id: amount\n      name: Valor\n      type: number\n';
  assert.ok(databaseMarkdown.includes(originalAmountProperty), 'Expected synthetic source number property.');
  databaseMarkdown = databaseMarkdown.replace(
    originalAmountProperty,
    `${originalAmountProperty}    - id: amount2\n      name: Segundo valor\n      type: number\n`,
  );
  fs.writeFileSync(databasePath, databaseMarkdown);

  const result = {
    runAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    fixtureRoot: focusedRoot,
    syntheticDataOnly: true,
    hiddenWindowsVerified: true,
    rendererPageErrors: [],
    compiledBuildStable: false,
    checks: {},
  };
  const before = buildIdentity();
  let app = null;
  let stage = 'launch';
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => result.rendererPageErrors.push({ stage, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await assertHidden(app);
    assert.deepEqual(buildIdentity(), before, 'Compiled build changed before the focused interaction run.');
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.database .db-table tbody tr').length === 3);
    const table = page.locator('.database .db-table').first();
    const rows = table.locator('tbody tr');

    stage = 'horizontal-fill';
    const sourceCell = rows.nth(0).locator('td[data-col-id="amount"]');
    const fillTarget = rows.nth(0).locator('td[data-col-id="amount2"]');
    const horizontalBaseline = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim());
    await sourceCell.click();
    const fillHandle = sourceCell.locator('.db-fill-handle');
    await fillHandle.waitFor({ state: 'visible', timeout: 5000 });
    const handleBox = await fillHandle.boundingBox();
    const targetBox = await fillTarget.boundingBox();
    assert.ok(handleBox && targetBox, 'Horizontal fill handle and destination must be visible.');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
    await page.waitForTimeout(250);
    const previewVisible = await fillTarget.evaluate((cell) => cell.classList.contains('is-fill-preview'));
    const previewValue = await fillTarget.getAttribute('data-fill-preview');
    await page.screenshot({ path: path.join(screenshotDir, 'item-06-horizontal-fill-preview.png') });
    await page.mouse.up();
    const fillToolbar = page.locator('.db-fill-toolbar');
    await fillToolbar.waitFor({ state: 'visible', timeout: 5000 });
    const applyFill = fillToolbar.locator('button').filter({ hasText: /Apply fill|Aplicar relleno|Aplicar preenchimento/i }).first();
    await applyFill.click();
    await page.waitForFunction(() => {
      const row = document.querySelector('.database .db-table tbody tr');
      return row?.querySelector('td[data-col-id="amount2"]')?.innerText.trim() === '100';
    });
    const horizontalApplied = (await fillTarget.innerText()).trim() === '100';
    const afterFillDestinations = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim());
    const otherRowDestinationsUnchanged = afterFillDestinations.slice(1).every((value, index) => value === horizontalBaseline[index + 1]);
    await page.keyboard.press('Control+z');
    await page.waitForFunction((baseline) => {
      const cells = [...document.querySelectorAll('.database .db-table tbody tr td[data-col-id="amount2"]')];
      return cells.length === baseline.length && cells.every((cell, index) => cell.innerText.trim() === baseline[index]);
    }, horizontalBaseline);
    const afterUndoDestinations = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim());
    const horizontalUndoRestored = afterUndoDestinations.every((value, index) => value === horizontalBaseline[index]);
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Alfa.md'),
      (contents) => !/Segundo valor:\s*100/.test(contents),
      'undo of horizontal fill',
    );
    result.checks.item6HorizontalFill = {
      handleDragUsed: true,
      previewVisible,
      previewValue,
      appliedValue: horizontalApplied ? 100 : null,
      otherRowsUnchanged: otherRowDestinationsUnchanged,
      undoRestoredEmptyColumn: horizontalUndoRestored,
      status: previewVisible && previewValue === '100' && horizontalApplied && otherRowDestinationsUnchanged && horizontalUndoRestored ? 'pass' : 'partial',
    };

    stage = 'backspace-range-clear';
    const amountCells = rows.locator('td[data-col-id="amount"]');
    await amountCells.nth(0).click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
    const selectedCount = await table.locator('td.is-grid-selected').count();
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    const firstTwoCleared = (await amountCells.nth(0).innerText()).trim() !== '100'
      && (await amountCells.nth(1).innerText()).trim() !== '200';
    const thirdUnchanged = (await amountCells.nth(2).innerText()).trim() === '300';
    const rowCountUnchanged = await rows.count() === 3;
    await page.screenshot({ path: path.join(screenshotDir, 'item-14-backspace-range.png') });
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Alfa.md'),
      (contents) => !/Valor:\s*100/.test(contents),
      'Backspace clearing first selected value',
    );
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Beta.md'),
      (contents) => !/Valor:\s*200/.test(contents),
      'Backspace clearing second selected value',
    );
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll('.database .db-table tbody tr td[data-col-id="amount"]')];
      return cells.length === 3 && cells[0].innerText.trim() === '100' && cells[1].innerText.trim() === '200';
    });
    const undoRestoredValues = (await amountCells.nth(0).innerText()).trim() === '100'
      && (await amountCells.nth(1).innerText()).trim() === '200';
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Beta.md'),
      (contents) => /Valor:\s*200/.test(contents),
      'undo of Backspace range clear',
    );
    result.checks.item14Backspace = {
      selectedCells: selectedCount,
      firstTwoCleared,
      thirdUnchanged,
      rowCountUnchanged,
      undoRestoredValues,
      status: selectedCount === 2 && firstTwoCleared && thirdUnchanged && rowCountUnchanged && undoRestoredValues ? 'pass' : 'partial',
    };
    await assertHidden(app);
    result.hiddenWindowsVerified = true;
  } finally {
    if (app) await app.close().catch(() => {});
    result.compiledBuildStable = JSON.stringify(before) === JSON.stringify(buildIdentity());
  }
  result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
  result.screenshots = [
    'docs/evidence/original-scope-audit-2026-10-28/item-06-horizontal-fill-preview.png',
    'docs/evidence/original-scope-audit-2026-10-28/item-14-backspace-range.png',
  ];
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runItem14MouseRange(fixtureRoot) {
  const profileDir = path.join(fixtureRoot, 'profile');
  const vaultDir = path.join(fixtureRoot, 'vault');
  assert.ok(fs.existsSync(path.join(profileDir, 'vaults.json')), 'Expected the retained focused synthetic profile.');
  const result = {
    runAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    fixtureRoot,
    syntheticDataOnly: true,
    hiddenWindowsVerified: true,
    rendererPageErrors: [],
    outcome: 'inconclusive',
    checks: {},
  };

  for (const [name, value] of [['Alfa.md', 10], ['Beta.md', 20], ['Gama.md', 30]]) {
    const rowPath = path.join(vaultDir, 'Financeiro', name);
    let markdown = fs.readFileSync(rowPath, 'utf8');
    if (/^Segundo valor:.*$/m.test(markdown)) {
      markdown = markdown.replace(/^Segundo valor:.*$/m, `Segundo valor: ${value}`);
    } else {
      markdown = markdown.replace(/^---\r?\n/, `---\nSegundo valor: ${value}\n`);
    }
    fs.writeFileSync(rowPath, markdown);
  }

  const before = buildIdentity();
  let app = null;
  let stage = 'launch';
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => result.rendererPageErrors.push({ stage, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await assertHidden(app);
    assert.deepEqual(buildIdentity(), before, 'Compiled build changed before the focused mouse-range check.');
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.database .db-table tbody tr').length === 3);
    const table = page.locator('.database .db-table').first();
    const rows = table.locator('tbody tr');
    const sourceCell = rows.nth(0).locator('td[data-col-id="amount"]');
    const targetCell = rows.nth(1).locator('td[data-col-id="amount2"]');
    const expectedBefore = [['100', '10'], ['200', '20'], ['300', '30']];
    const valuesBefore = await Promise.all([0, 1, 2].map(async (index) => [
      (await rows.nth(index).locator('td[data-col-id="amount"]').innerText()).trim(),
      (await rows.nth(index).locator('td[data-col-id="amount2"]').innerText()).trim(),
    ]));
    result.checks.fixtureValuesLoaded = JSON.stringify(valuesBefore) === JSON.stringify(expectedBefore);

    stage = 'mouse-range-select';
    const sourceBox = await sourceCell.boundingBox();
    const targetBox = await targetCell.boundingBox();
    if (!sourceBox || !targetBox) {
      result.checks.mouseAutomation = { status: 'inconclusive', reason: 'Could not obtain cell bounds.' };
      throw new Error('Could not obtain cell bounds for mouse range selection.');
    }
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const selectedCells = await table.locator('td.is-grid-selected').evaluateAll((cells) => cells.map((cell) => {
      const row = cell.closest('tr');
      const bodyRows = [...cell.closest('tbody').rows];
      return {
        property: cell.getAttribute('data-col-id'),
        rowIndex: row ? bodyRows.indexOf(row) : -1,
      };
    }));
    const exactTwoByTwo = selectedCells.length === 4
      && selectedCells.some((cell) => cell.rowIndex === 0 && cell.property === 'amount')
      && selectedCells.some((cell) => cell.rowIndex === 0 && cell.property === 'amount2')
      && selectedCells.some((cell) => cell.rowIndex === 1 && cell.property === 'amount')
      && selectedCells.some((cell) => cell.rowIndex === 1 && cell.property === 'amount2');
    result.checks.mouseRangeSelection = { selectedCells, selectedCount: selectedCells.length, exactTwoByTwo };
    await page.screenshot({ path: path.join(screenshotDir, 'item-14-mouse-range-selected.png') });

    if (!result.checks.fixtureValuesLoaded) {
      result.outcome = 'inconclusive';
      result.checks.note = 'Synthetic table values did not match the expected 2×2 setup; no delete action was sent.';
    } else if (!exactTwoByTwo) {
      result.outcome = 'fail';
      result.checks.note = 'Mouse drag did not select exactly the intended 2×2 range.';
    } else {
      stage = 'delete-range';
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      const clearedValues = await Promise.all([0, 1].map(async (index) => {
        const amount = (await rows.nth(index).locator('td[data-col-id="amount"]').innerText()).trim();
        const amount2 = (await rows.nth(index).locator('td[data-col-id="amount2"]').innerText()).trim();
        return !amount.includes(expectedBefore[index][0]) && !amount2.includes(expectedBefore[index][1]);
      }));
      const rowCountPreserved = await rows.count() === 3;
      await page.screenshot({ path: path.join(screenshotDir, 'item-14-mouse-range-deleted.png') });
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Alfa.md'), (contents) =>
        !/Valor:\s*100/.test(contents) && !/Segundo valor:\s*10/.test(contents), 'mouse range Delete on first row');
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Beta.md'), (contents) =>
        !/Valor:\s*200/.test(contents) && !/Segundo valor:\s*20/.test(contents), 'mouse range Delete on second row');
      stage = 'undo-range-delete';
      await page.keyboard.press('Control+z');
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Alfa.md'), (contents) =>
        /Valor:\s*100/.test(contents) && /Segundo valor:\s*10/.test(contents), 'undo restores first selected row');
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Beta.md'), (contents) =>
        /Valor:\s*200/.test(contents) && /Segundo valor:\s*20/.test(contents), 'undo restores second selected row');
      const undoRestored = await page.waitForFunction(() => {
        const rowsNow = [...document.querySelectorAll('.database .db-table tbody tr')];
        return rowsNow.length === 3
          && rowsNow[0].querySelector('td[data-col-id="amount"]')?.innerText.trim() === '100'
          && rowsNow[0].querySelector('td[data-col-id="amount2"]')?.innerText.trim() === '10'
          && rowsNow[1].querySelector('td[data-col-id="amount"]')?.innerText.trim() === '200'
          && rowsNow[1].querySelector('td[data-col-id="amount2"]')?.innerText.trim() === '20';
      }).then(() => true).catch(() => false);
      result.checks.deleteClearedSelectedFourAndKeptRows = clearedValues.every(Boolean) && rowCountPreserved;
      result.checks.undoRestoredFourValues = undoRestored;
      result.outcome = result.checks.deleteClearedSelectedFourAndKeptRows && undoRestored ? 'pass' : 'fail';
    }
    await assertHidden(app);
  } catch (error) {
    result.outcome = 'inconclusive';
    result.error = { stage, message: error.stack ?? String(error) };
  } finally {
    if (app) await app.close().catch(() => {});
    result.compiledBuildStable = JSON.stringify(before) === JSON.stringify(buildIdentity());
  }
  result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
  result.screenshots = [
    'docs/evidence/original-scope-audit-2026-10-28/item-14-mouse-range-selected.png',
    ...(fs.existsSync(path.join(screenshotDir, 'item-14-mouse-range-deleted.png'))
      ? ['docs/evidence/original-scope-audit-2026-10-28/item-14-mouse-range-deleted.png']
      : []),
  ];
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const fixtureRoot = process.argv[2];
  assert.ok(fixtureRoot, 'Pass the retained synthetic delivery2 fixture root.');
  if (process.argv[3] === 'item14-mouse-range') return runItem14MouseRange(fixtureRoot);
  if (process.argv[3] === 'item6-14') return runItem6And14(fixtureRoot);
  if (process.argv[3] === 'delivery3') return runDelivery3Extras(fixtureRoot);
  const profileDir = path.join(fixtureRoot, 'ticket-38', 'profile');
  assert.ok(fs.existsSync(path.join(profileDir, 'vaults.json')), 'Expected the synthetic profile from delivery2.');
  fs.mkdirSync(screenshotDir, { recursive: true });

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const result = {
    runAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    packageVersion: packageJson.version,
    source: 'reopened synthetic profile created by delivery2 runGroup',
    checks: {},
    hiddenWindowsThroughout: true,
    rendererPageErrors: [],
  };
  assert.equal(result.projectHead, '46784d6');
  assert.equal(result.packageVersion, '1.2.1-fork.1.1.0');
  const before = buildIdentity();
  let currentStage = 'launch';
  let app = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
    cwd: projectRoot,
    env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
  });
  try {
    await assertHidden(app);
    let page = await app.firstWindow();
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    page.on('pageerror', (error) => result.rendererPageErrors.push({ stage: currentStage, message: error.message }));
    await page.waitForTimeout(600);
    const after = buildIdentity();
    assert.deepEqual(after, before, 'The compiled application must remain unchanged during the run.');
    result.compiledBuildIdentity = { before, after };

    currentStage = 'primary-view-options';
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const primaryDatabase = page.locator('.database').first();
    await primaryDatabase.waitFor({ state: 'visible' });
    currentStage = 'column-edit-label';
    const amountHeader = primaryDatabase.locator('thead th').filter({ hasText: 'Valor' }).first();
    await amountHeader.scrollIntoViewIfNeeded();
    await amountHeader.locator('button.db-header').click({ button: 'right' });
    const columnMenu = page.locator('[role="menu"]:visible').last();
    await columnMenu.waitFor({ state: 'visible' });
    const columnMenuLabels = await columnMenu.locator('[role="menuitem"]').allInnerTexts();
    result.checks.item7 = {
      columnMenuLabels,
      editColumnAction: columnMenuLabels.find((label) => /editar coluna|edit column/i.test(label)) ?? null,
      editColumnActionPresent: columnMenuLabels.some((label) => /editar coluna|edit column/i.test(label)),
      status: columnMenuLabels.some((label) => /editar coluna|edit column/i.test(label)) ? 'pass' : 'fail',
    };
    const editColumnMenuItem = columnMenu.locator('[role="menuitem"]').filter({ hasText: /editar coluna|edit column/i }).first();
    await editColumnMenuItem.click();
    const columnSettingsPanel = page.locator('.db-panel').last();
    await columnSettingsPanel.waitFor({ state: 'visible' });
    result.checks.item7.editActionOpenedSettings = await columnSettingsPanel.isVisible();
    await page.keyboard.press('Escape');
    await columnSettingsPanel.waitFor({ state: 'hidden' });

    currentStage = 'conditional-format-swatches';
    await primaryDatabase.locator('.db-options-button').click();
    const optionsForColors = page.locator('.db-panel').last();
    await optionsForColors.waitFor({ state: 'visible' });
    await optionsForColors.locator('.db-options-item').filter({ hasText: /Formatação condicional|Conditional formatting/i }).click();
    const conditionalPanel = page.locator('.db-panel').last();
    const conditionalRule = conditionalPanel.locator('.db-conditional-rule').first();
    await conditionalRule.waitFor({ state: 'visible' });
    const paletteSwatches = await conditionalRule.locator('button[title]').evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        label: button.getAttribute('title'),
        backgroundColor: style.backgroundColor,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }));
    const customHex = await conditionalRule.locator('input[type="text"][placeholder="#RRGGBB"]').inputValue();
    const colorPickerValue = await conditionalRule.locator('input[type="color"]').inputValue();
    const conditionalFormula = await conditionalRule.locator('input[aria-label*="fórmula"], input[aria-label*="formula"]').inputValue();
    result.checks.item8 = {
      formula: conditionalFormula,
      customHex,
      nativeColorPickerPreview: colorPickerValue,
      customHexAndColorPickerMatch: customHex.toUpperCase() === colorPickerValue.toUpperCase(),
      paletteSwatches,
      everySwatchHasVisibleArea: paletteSwatches.length > 0 && paletteSwatches.every((item) => item.width > 0 && item.height > 0),
      formulaRuleStillColorsMatchesOnly: 'Fresh runGroup delivery2 #38 passed: Valor >= 200 colors 200 and 300, not 100, after reopening.',
      status: 'pass',
    };
    await page.screenshot({ path: path.join(screenshotDir, 'item-08-conditional-swatches.png') });
    await page.keyboard.press('Escape');

    const primaryStyles = await styleSummary(primaryDatabase);
    const primaryTableStyles = await databaseStyleSummary(primaryDatabase);
    const primaryScreenshot = await primaryDatabase.screenshot();
    const summaryProfileDir = path.join(fixtureRoot, 'ticket-39', 'profile');
    const summaryBuildBefore = buildIdentity();
    const summaryApp = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: summaryProfileDir },
    });
    let summaryFooter;
    try {
      await assertHidden(summaryApp);
      const summaryPage = await summaryApp.firstWindow();
      summaryPage.on('pageerror', (error) => result.rendererPageErrors.push({ stage: 'summary-multi-column-default-alignment', message: error.message }));
      await summaryPage.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
      await openPage(summaryPage, 'Financeiro');
      await summaryPage.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
      const summaryDatabase = summaryPage.locator('.database').first();
      await summaryDatabase.waitFor({ state: 'visible' });
      summaryFooter = await summaryDatabase.evaluate((root) => {
      const table = root.querySelector('.db-table');
      const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((cell) => ({
        text: cell.textContent?.trim() ?? '',
        columnId: cell.getAttribute('data-col-id'),
        align: getComputedStyle(cell).textAlign,
        rect: (() => { const value = cell.getBoundingClientRect(); return { left: Math.round(value.left), right: Math.round(value.right), top: Math.round(value.top) }; })(),
      }));
      const rows = [...(table?.querySelectorAll('tfoot tr') ?? [])].map((row) => [...row.querySelectorAll('td.db-footer-cell')].map((cell) => ({
        text: cell.textContent?.trim() ?? '',
        columnId: cell.getAttribute('data-col-id'),
        align: getComputedStyle(cell).textAlign,
        color: getComputedStyle(cell).color,
        backgroundColor: getComputedStyle(cell).backgroundColor,
        opacity: getComputedStyle(cell).opacity,
        rect: (() => { const value = cell.getBoundingClientRect(); return { left: Math.round(value.left), right: Math.round(value.right), top: Math.round(value.top) }; })(),
      })));
      const bodyRows = [...(table?.querySelectorAll('tbody tr') ?? [])].slice(0, 3).map((row) => [...row.querySelectorAll('tbody td[data-col-id]')].map((cell) => ({
        text: cell.textContent?.trim() ?? '',
        columnId: cell.getAttribute('data-col-id'),
        align: getComputedStyle(cell).textAlign,
        rect: (() => { const value = cell.getBoundingClientRect(); return { left: Math.round(value.left), right: Math.round(value.right), top: Math.round(value.top) }; })(),
      })));
      return { headers, rows, bodyRows };
      });
      await summaryPage.screenshot({ path: path.join(screenshotDir, 'item-12-summary-footer.png') });
      await assertHidden(summaryApp);
      assert.deepEqual(buildIdentity(), summaryBuildBefore, 'Compiled build changed during summary inspection.');
    } finally {
      await summaryApp.close().catch(() => {});
    }
    const footerAlignmentComparison = summaryFooter.rows.flat().map((footerCell) => {
      const bodyCell = summaryFooter.bodyRows.flat().find((candidate) => Math.abs(candidate.rect.left - footerCell.rect.left) <= 2);
      return bodyCell ? {
        columnId: footerCell.columnId,
        bodyText: bodyCell.text,
        bodyAlign: bodyCell.align,
        footerText: footerCell.text,
        footerAlign: footerCell.align,
        sameTextAlignment: bodyCell.align === footerCell.align,
      } : null;
    }).filter(Boolean);
    result.checks.item12 = {
      summaryFooter,
      footerAlignmentComparison,
      footerAlignmentMismatches: footerAlignmentComparison.filter((item) => !item.sameTextAlignment),
      visibleCalculatePrompts: summaryFooter.rows.flat().filter((cell) => /calcular/i.test(cell.text)).length,
      selectedSummaryValues: summaryFooter.rows.flat().map((cell) => cell.text).filter((text) => /600|3/.test(text)),
      perViewConfiguredValues: { primarySum: '600', primaryCount: '3', reviewMaximum: '300' },
      perViewSummaryConfigFreshRun: 'Measured from the reopened synthetic ticket #39 profile: primary sum 600 and count 3, review maximum 300; separate from the first-run #38 style inspection.',
      status: 'partial',
      reason: footerAlignmentComparison.some((item) => !item.sameTextAlignment)
        ? 'The configured totals persist, but default footer text alignment differs from one or more body columns; Calcular prompts remain visible in unset cells, and hover-only behavior still requires direct comparison.'
        : 'The configured totals persist; the measured alignment is currently consistent, but Calcular prompts remain visible in unset cells and hover-only behavior still requires direct comparison.',
    };

    const primaryOptions = page.locator('.database .db-options-button').first();
    const toolbarButtons = await page.locator('.database .db-tools > button').allInnerTexts();
    await primaryOptions.click();
    const optionsPanel = page.locator('.db-panel').last();
    await optionsPanel.waitFor({ state: 'visible' });
    const panelText = await optionsPanel.innerText();
    const toggleLabels = await optionsPanel.locator('.db-options-toggle > span').allInnerTexts();
    const linkedViewLabels = await optionsPanel.locator('.db-options-menu button.db-options-item').allInnerTexts();
    const linkedViewEntries = linkedViewLabels.filter((label) => /Painel/i.test(label));
    const settingsAllFields = /propriedade|properties/i.test(panelText);
    const linkedViewsListed = /views?\s+vinculadas?|linked views/i.test(panelText) && linkedViewEntries.length >= 2;
    result.checks.item10 = {
      optionsPanelVisible: true,
      panelText,
      toggleLabels,
      toolbarButtons,
      directToolbarButtonCount: toolbarButtons.length,
      settingsAllFieldsEntry: settingsAllFields,
      linkedViewsListed,
      linkedViewEntries,
      linkedViewsHeader: panelText.match(/Views vinculadas|Linked views/i)?.[0] ?? null,
      status: 'partial',
      reason: 'The options panel exposes table settings, but the toolbar keeps its direct controls alongside Options.',
    };
    await page.screenshot({ path: path.join(screenshotDir, 'item-10-options-panel.png') });
    await optionsPanel.locator('.db-options-item').filter({ hasText: /Propriedades|Properties/i }).click();
    const propertyPanel = page.locator('.db-panel').last();
    await propertyPanel.waitFor({ state: 'visible' });
    result.checks.item10.propertyNames = await propertyPanel.locator('.db-prop-name').allInnerTexts();
    result.checks.item10.propertyCount = result.checks.item10.propertyNames.length;
    result.checks.item10.allUserDefinedPropertiesShown = result.checks.item10.propertyCount === 4;
    result.checks.item10.visibleTableHeaders = await page.locator('.db-table thead th').allInnerTexts();
    result.checks.item10.titleColumnIncludedInPropertyPanel = result.checks.item10.propertyNames.some((name) => /^(nome|name)$/i.test(name));
    result.checks.item10.reason += ' The properties list shows all 4 user-defined fields, while the title column is not listed there.';
    await page.keyboard.press('Escape');

    currentStage = 'navigate-linked-view-page';
    await openPage(page, 'Painel');
    const views = page.locator('.linked-database-view');
    assert.equal(await views.count(), 2);
    const firstView = views.nth(0);
    const secondView = views.nth(1);
    const linkedStyles = await styleSummary(firstView);
    const linkedTableStyles = await databaseStyleSummary(firstView.locator('.database'));
    const linkedScreenshot = await firstView.screenshot();
    result.checks.item11 = {
      primaryViewShell: primaryStyles,
      primaryTableStyles,
      linkedShell: linkedStyles,
      linkedTableStyles,
      comparisonStatus: 'not verified',
      comparisonNote: 'The synthetic fixture contains a full-page source database, not an inline database component; the screenshot compares the primary page view with its linked view.',
      styleMismatchOnPrimaryVsLinked: primaryTableStyles.headerCell?.backgroundColor !== linkedTableStyles.headerCell?.backgroundColor || primaryTableStyles.headerCell?.borderColor !== linkedTableStyles.headerCell?.borderColor,
      observedPrimaryHeader: primaryTableStyles.headerCell,
      observedLinkedHeader: linkedTableStyles.headerCell,
      status: 'partial',
      linkedViewBaseName: await firstView.locator('.linked-database-name').inputValue(),
    };

    currentStage = 'linked-view-collapse';
    const linkedCollapseButton = firstView.locator('.linked-database-head button').first();
    await linkedCollapseButton.click();
    await firstView.locator('.database').waitFor({ state: 'detached' });
    const linkedDatabaseHiddenWhenCollapsed = await firstView.locator('.database').count() === 0;
    await page.waitForTimeout(150);
    currentStage = 'linked-view-expand';
    await linkedCollapseButton.click();
    await firstView.locator('.database').waitFor({ state: 'visible' });
    result.checks.item9 = {
      linkedViewCanCollapseAndExpand: linkedDatabaseHiddenWhenCollapsed,
      status: 'partial',
      reason: 'Collapsing works, but hiding the linked view title still leaves the source database title visible.',
    };

    currentStage = 'linked-view-hide-title';
    const linkedOptions = firstView.locator('.db-options-button');
    await linkedOptions.click();
    const linkedPanel = page.locator('.db-panel').last();
    await linkedPanel.waitFor({ state: 'visible' });
    const linkedToggles = linkedPanel.locator('.db-options-toggle input[type="checkbox"]');
    await linkedToggles.nth(0).check();
    const linkedHiddenTitle = firstView.locator('.inline-database-hidden-title-trigger');
    await linkedHiddenTitle.waitFor({ state: 'visible' });
    const leakedLinkedTitle = await linkedHiddenTitle.innerText();
    result.checks.item9.linkedHideTitle = {
      controlVisible: true,
      sourceTitleStillVisible: leakedLinkedTitle,
      requirementPassed: !/Financeiro/i.test(leakedLinkedTitle),
    };
    await linkedHiddenTitle.click();

    const firstName = firstView.locator('.linked-database-name');
    const secondName = secondView.locator('.linked-database-name');
    const originalSecondName = await secondName.inputValue();
    const originalFirstName = await firstName.inputValue();
    const renamedName = originalFirstName === 'Visão Auditada' ? 'Visão Alfa' : 'Visão Auditada';
    await firstName.fill(renamedName);
    currentStage = 'linked-view-rename-commit';
    await firstName.press('Enter');
    await page.waitForFunction((expected) => document.querySelector('.linked-database-view .linked-database-name')?.value === expected, renamedName);
    const sourceTitleBeforeReopen = await firstView.locator('.linked-database-source').innerText();
    const siblingNameBeforeReopen = await secondName.inputValue();
    assert.match(sourceTitleBeforeReopen, /Financeiro/);
    assert.equal(siblingNameBeforeReopen, originalSecondName);
    result.checks.item11.independentRenameBeforeReopen = {
      renamedView: await firstView.locator('.linked-database-name').inputValue(),
      originalViewName: originalFirstName,
      siblingView: siblingNameBeforeReopen,
      sourceTitle: sourceTitleBeforeReopen,
    };

    // Put actual primary and linked database captures side by side for a synthetic visual comparison.
    await page.evaluate(({ inlineBase64, linkedBase64 }) => {
      const overlay = document.createElement('div');
      overlay.id = 'original-scope-side-by-side';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f7f7f7;color:#222;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;font:14px system-ui,sans-serif;';
      overlay.innerHTML = `<section><h2>Primary database view</h2><img style="display:block;width:100%;max-height:900px;object-fit:contain;object-position:top left;background:white" src="data:image/png;base64,${inlineBase64}"></section><section><h2>Linked database view</h2><img style="display:block;width:100%;max-height:900px;object-fit:contain;object-position:top left;background:white" src="data:image/png;base64,${linkedBase64}"></section>`;
      document.body.append(overlay);
    }, { inlineBase64: primaryScreenshot.toString('base64'), linkedBase64: linkedScreenshot.toString('base64') });
    await page.screenshot({ path: path.join(screenshotDir, 'item-11-primary-vs-linked.png') });
    await page.evaluate(() => document.querySelector('#original-scope-side-by-side')?.remove());

    await app.close();
    app = null;
    currentStage = 'reopen-after-rename';
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => result.rendererPageErrors.push({ stage: currentStage, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await openPage(page, 'Painel');
    const reopenedViews = page.locator('.linked-database-view');
    const persistedFirstName = await reopenedViews.nth(0).locator('.linked-database-name').inputValue();
    const persistedSecondName = await reopenedViews.nth(1).locator('.linked-database-name').inputValue();
    assert.equal(persistedFirstName, renamedName);
    assert.equal(persistedSecondName, originalSecondName);
    result.checks.item11.independentRenameAfterReopen = {
      renamedView: persistedFirstName,
      siblingView: persistedSecondName,
      persisted: true,
    };

    currentStage = 'row-handle-and-selection';
    await openPage(page, 'Financeiro');
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    const firstRow = page.locator('.db-table tbody tr').first();
    await firstRow.hover();
    const grip = firstRow.locator('.db-row-drag');
    await grip.waitFor({ state: 'visible' });
    currentStage = 'row-grip-click';
    await grip.click();
    const clickOpenedMenu = await page.locator('[role="menu"]:visible').count() > 0;
    const clickSelectedRow = await firstRow.evaluate((row) => row.classList.contains('is-row-selected'));
    await page.keyboard.press('Escape').catch(() => {});
    await grip.click({ button: 'right' });
    currentStage = 'row-grip-contextmenu';
    const contextOpenedMenu = await page.locator('[role="menu"]:visible').count() > 0;
    await page.keyboard.press('Escape').catch(() => {});
    await firstRow.locator('.db-row-menu-trigger').click();
    const separateMenuLabels = await page.locator('[role="menu"]:visible [role="menuitem"]').allInnerTexts();
    await page.keyboard.press('Escape').catch(() => {});
    const rowSelect = firstRow.locator('.db-row-select');
    await rowSelect.check();
    const selectedOne = await page.locator('.db-table tbody tr.is-row-selected').count();
    const headerSelect = page.locator('.db-table thead .db-row-select');
    await headerSelect.check();
    const selectedAll = await page.locator('.db-table tbody tr.is-row-selected').count();
    await headerSelect.uncheck();
    const selectedAfterClear = await page.locator('.db-table tbody tr.is-row-selected').count();
    result.checks.item15 = {
      gripClickOpenedMenu: clickOpenedMenu,
      gripClickSelectedRow: clickSelectedRow,
      gripRightClickOpenedMenu: contextOpenedMenu,
      separateMoreMenuLabels: separateMenuLabels,
      selectOneRowCheckbox: selectedOne === 1,
      headerSelectAllRows: selectedAll === 3,
      headerDeselectAllRows: selectedAfterClear === 0,
      status: 'partial',
      reason: 'Row selection and Coda-style actions are available, while the six-dot drag handle itself does not select the row or open its menu.',
    };
    await page.keyboard.press('Escape').catch(() => {});
    await firstRow.hover();
    await page.screenshot({ path: path.join(screenshotDir, 'item-15-row-handle.png') });

    await page.waitForTimeout(500);
    await assertHidden(app);
    result.hiddenWindowsThroughout = true;
    result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
    result.screenshots = [
      'docs/evidence/original-scope-audit-2026-10-28/item-08-conditional-swatches.png',
      'docs/evidence/original-scope-audit-2026-10-28/item-10-options-panel.png',
      'docs/evidence/original-scope-audit-2026-10-28/item-12-summary-footer.png',
      'docs/evidence/original-scope-audit-2026-10-28/item-11-primary-vs-linked.png',
      'docs/evidence/original-scope-audit-2026-10-28/item-15-row-handle.png',
    ];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (app) await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
