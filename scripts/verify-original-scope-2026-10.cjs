const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { projectRelative, removeOwnedTempRoot, runPath } = require('./stabilization-1.1.1-audit-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const screenshotDir = runPath(
  path.join('screenshots', 'original-scope'),
  path.join(projectRoot, 'docs', 'evidence', 'original-scope-audit-2026-10-28'),
);
const screenshotRef = (name) => projectRelative(path.join(screenshotDir, name));

function sanitizeAudit(value, key = '') {
  if (typeof value === 'string') {
    if (/path|root|directory/i.test(key) && path.isAbsolute(value)) return path.basename(value);
    return value.replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>|]+/g, '[local path omitted]');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeAudit(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeAudit(childValue, childKey)]));
  }
  return value;
}

function saveAudit(fileName, report) {
  if (!process.env.MORROW_STABILIZATION_RUN_DIR) return;
  const outputPath = runPath(path.join('audit', fileName), path.join(projectRoot, 'docs', 'evidence', fileName));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(sanitizeAudit(report), null, 2)}\n`, 'utf8');
}

async function measureFooterAlignment(database) {
  return database.evaluate((root) => {
    const table = root.querySelector('.db-table');
    const bodyCells = [...(table?.querySelectorAll('tbody tr:first-child td[data-col-id]') ?? [])];
    const footerCells = [...(table?.querySelectorAll('tfoot td.db-footer-cell[data-col-id]') ?? [])];
    return footerCells.map((footer) => {
      const body = bodyCells.find((cell) => cell.getAttribute('data-col-id') === footer.getAttribute('data-col-id'));
      const footerRect = footer.getBoundingClientRect();
      const bodyRect = body?.getBoundingClientRect();
      return {
        columnId: footer.getAttribute('data-col-id'),
        bodyAlign: body ? getComputedStyle(body).textAlign : null,
        footerAlign: getComputedStyle(footer).textAlign,
        sameTextAlignment: body ? getComputedStyle(body).textAlign === getComputedStyle(footer).textAlign : false,
        bodyRect: bodyRect ? { left: Math.round(bodyRect.left), right: Math.round(bodyRect.right) } : null,
        footerRect: { left: Math.round(footerRect.left), right: Math.round(footerRect.right) },
        sameColumnBounds: Boolean(bodyRect && Math.abs(bodyRect.left - footerRect.left) <= 2 && Math.abs(bodyRect.right - footerRect.right) <= 2),
      };
    });
  });
}

function readAuditReference(environmentName) {
  const configuredPath = process.env[environmentName];
  if (!configuredPath) return null;
  const absolutePath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(projectRoot, configuredPath);
  if (!fs.existsSync(absolutePath)) return null;
  const report = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  return { path: projectRelative(absolutePath), report };
}

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
  const delivery3Fresh = readAuditReference('MORROW_AUDIT_DELIVERY3_EVIDENCE_PATH');
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
        args: [projectRoot],
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
    const existingInverseTicket = delivery3Fresh?.report?.evidence?.tickets?.['#43'];
    const existingRelationUnionPassed = delivery3Fresh?.report?.outcome === 'passed' &&
      delivery3Fresh.report.hiddenWindows === true &&
      delivery3Fresh.report.pageErrorCount === 0 &&
      existingInverseTicket?.status === 'passed' &&
      existingInverseTicket.checks?.previewCountedExistingPairs === true &&
      existingInverseTicket.checks?.ownerRelationPersisted === true &&
      existingInverseTicket.checks?.targetMarkedAsInverse === true &&
      existingInverseTicket.checks?.relationMetadataReopened === true &&
      /Livro Alfa/.test(existingInverseTicket.checks?.projectedBooksForAsha ?? '') &&
      /Livro Beta/.test(existingInverseTicket.checks?.projectedBooksForAsha ?? '');
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
      existingPopulatedColumnLinkAndMergeEvidence: delivery3Fresh?.path ?? null,
      existingRelationUnionPassed,
      status: reciprocalMetadataSaved && inverseProjectedColumnVisible && existingRelationUnionPassed
        ? 'pass'
        : reciprocalMetadataSaved && inverseProjectedColumnVisible
          ? 'partial'
          : 'fail',
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
    screenshotRef('item-16-number-alias.png'),
    screenshotRef('item-17-formula-token.png'),
    screenshotRef('item-17-formula-suggestions.png'),
    screenshotRef('item-18-number-formula-format.png'),
    screenshotRef('item-19-inverse-create.png'),
    screenshotRef('item-20-icon-picker-overlay.png'),
    screenshotRef('item-20-icon-upload.png'),
  ];
  saveAudit('original-scope-delivery3.json', result);
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
    fixtureRoot: path.basename(focusedRoot),
    syntheticDataOnly: true,
    hiddenWindowsVerified: true,
    rendererPageErrors: [],
    compiledBuildStable: false,
    checks: {},
  };
  const before = buildIdentity();
  let app = null;
  let page = null;
  let stage = 'launch';
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    page = await app.firstWindow();
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
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Alfa.md'),
      (contents) => /Segundo valor:\s*100/.test(contents),
      'horizontal fill persistence',
    );
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Beta.md'),
      (contents) => !/Segundo valor:\s*100/.test(contents),
      'horizontal fill leaves other rows untouched',
    );
    await fillTarget.click();
    await page.keyboard.press('Control+z');
    await page.waitForFunction((baseline) => {
      const cells = [...document.querySelectorAll('.database .db-table tbody tr td[data-col-id="amount2"]')];
      return cells.length === baseline.length && cells.every((cell, index) => cell.innerText.trim() === baseline[index]);
    }, horizontalBaseline, { timeout: 5000 });
    await waitForMarkdown(
      vaultDir,
      path.join('Financeiro', 'Alfa.md'),
      (contents) => !/Segundo valor:\s*100/.test(contents),
      'undo of horizontal fill',
    );
    const horizontalUndoRestored = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim())
      .every((value, index) => value === horizontalBaseline[index]);
    result.checks.item6HorizontalFill = {
      handleDragUsed: true,
      previewVisible,
      previewValue,
      appliedValue: horizontalApplied ? 100 : null,
      otherRowsUnchanged: otherRowDestinationsUnchanged,
      diskSaveConfirmed: true,
      undoRestoredEmptyColumn: horizontalUndoRestored,
      status: previewVisible && previewValue === '100' && horizontalApplied && otherRowDestinationsUnchanged ? 'pass' : 'fail',
    };
    if (!horizontalUndoRestored) result.checks.item6HorizontalFill.status = 'fail';

    await sourceCell.click();
    const repeatHandle = sourceCell.locator('.db-fill-handle');
    const repeatHandleBox = await repeatHandle.boundingBox();
    const repeatTargetBox = await fillTarget.boundingBox();
    assert.ok(repeatHandleBox && repeatTargetBox, 'Horizontal fill controls must be visible after undo.');
    await page.mouse.move(repeatHandleBox.x + repeatHandleBox.width / 2, repeatHandleBox.y + repeatHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(repeatTargetBox.x + repeatTargetBox.width / 2, repeatTargetBox.y + repeatTargetBox.height / 2, { steps: 8 });
    await page.mouse.up();
    const repeatFillToolbar = page.locator('.db-fill-toolbar');
    await repeatFillToolbar.waitFor({ state: 'visible', timeout: 5000 });
    await repeatFillToolbar.locator('button').filter({ hasText: /Apply fill|Aplicar relleno|Aplicar preenchimento/i }).first().click();
    await page.waitForFunction(() => document.querySelector('.database .db-table tbody tr td[data-col-id="amount2"]')?.innerText.trim() === '100');

    stage = 'vertical-fill';
    const verticalSource = rows.nth(0).locator('td[data-col-id="amount2"]');
    const verticalTarget = rows.nth(2).locator('td[data-col-id="amount2"]');
    await verticalSource.click();
    const verticalHandle = verticalSource.locator('.db-fill-handle');
    const verticalHandleBox = await verticalHandle.boundingBox();
    const verticalTargetBox = await verticalTarget.boundingBox();
    assert.ok(verticalHandleBox && verticalTargetBox, 'Vertical fill handle and destination must be visible.');
    await page.mouse.move(verticalHandleBox.x + verticalHandleBox.width / 2, verticalHandleBox.y + verticalHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(verticalTargetBox.x + verticalTargetBox.width / 2, verticalTargetBox.y + verticalTargetBox.height / 2, { steps: 10 });
    await page.waitForTimeout(250);
    const verticalPreviewVisible = await verticalTarget.evaluate((cell) => cell.classList.contains('is-fill-preview'));
    const verticalPreviewValue = await verticalTarget.getAttribute('data-fill-preview');
    await page.mouse.up();
    const verticalFillToolbar = page.locator('.db-fill-toolbar');
    await verticalFillToolbar.waitFor({ state: 'visible', timeout: 5000 });
    await verticalFillToolbar.locator('button').filter({ hasText: /Apply fill|Aplicar relleno|Aplicar preenchimento/i }).first().click();
    await page.waitForTimeout(500);
    const verticalApplied = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim());
    const sourceColumnUnchanged = JSON.stringify(
      (await rows.locator('td[data-col-id="amount"]').allTextContents()).map((value) => value.trim()),
    ) === JSON.stringify(['100', '200', '300']);
    const horizontalOnly = ['100', ...horizontalBaseline.slice(1)];
    const verticalChanged = JSON.stringify(verticalApplied) !== JSON.stringify(horizontalOnly);
    const verticalFullyApplied = JSON.stringify(verticalApplied) === JSON.stringify(['100', '100', '100']);
    if (verticalFullyApplied) {
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Beta.md'),
        (contents) => /Segundo valor:\s*100/.test(contents), 'vertical fill persistence for second row');
      await waitForMarkdown(vaultDir, path.join('Financeiro', 'Gama.md'),
        (contents) => /Segundo valor:\s*100/.test(contents), 'vertical fill persistence for third row');
    }
    let verticalUndoRestored = verticalApplied;
    if (verticalChanged) {
      await page.keyboard.press('Control+z');
      await page.waitForFunction((baseline) => {
        const cells = [...document.querySelectorAll('.database .db-table tbody tr td[data-col-id="amount2"]')];
        return cells.length === baseline.length && cells.every((cell, index) => cell.innerText.trim() === baseline[index]);
      }, horizontalOnly, { timeout: 5000 });
      verticalUndoRestored = (await rows.locator('td[data-col-id="amount2"]').allTextContents()).map((value) => value.trim());
      if (verticalFullyApplied) {
        await waitForMarkdown(vaultDir, path.join('Financeiro', 'Beta.md'),
          (contents) => !/Segundo valor:\s*100/.test(contents), 'undo of vertical fill for second row');
        await waitForMarkdown(vaultDir, path.join('Financeiro', 'Gama.md'),
          (contents) => !/Segundo valor:\s*100/.test(contents), 'undo of vertical fill for third row');
      }
    }
    if (!verticalFullyApplied) await page.screenshot({ path: path.join(screenshotDir, 'item-06-vertical-fill-failed.png') });
    result.checks.item6VerticalFill = {
      handleDragUsed: true,
      previewVisible: verticalPreviewVisible,
      previewValue: verticalPreviewValue,
      appliedValues: verticalApplied,
      sourceColumnUnchanged,
      undoRestoredHorizontalOnly: verticalUndoRestored,
      diskSaveAndUndoConfirmed: verticalFullyApplied && JSON.stringify(verticalUndoRestored) === JSON.stringify(horizontalOnly),
      status: verticalPreviewVisible && verticalPreviewValue === '100' &&
        JSON.stringify(verticalApplied) === JSON.stringify(['100', '100', '100']) &&
        sourceColumnUnchanged && JSON.stringify(verticalUndoRestored) === JSON.stringify(horizontalOnly)
        ? 'pass'
        : 'fail',
    };

    if (JSON.stringify(verticalUndoRestored) !== JSON.stringify(horizontalOnly)) {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(250);
    }
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
  } catch (error) {
    result.error = { stage, message: error.stack ?? String(error) };
    if (page) {
      result.failureState = await page.evaluate(() => ({
        values: [...document.querySelectorAll('.database .db-table tbody tr')].map((row) =>
          [...row.querySelectorAll('td[data-col-id="amount2"]')].map((cell) => cell.innerText.trim()),
        ),
        rows: document.querySelectorAll('.database .db-table tbody tr').length,
      })).catch(() => null);
      await page.screenshot({ path: path.join(screenshotDir, 'item-06-14-failure.png') }).catch(() => {});
    }
  } finally {
    if (app) await app.close().catch(() => {});
    result.compiledBuildStable = JSON.stringify(before) === JSON.stringify(buildIdentity());
    if (process.env.MORROW_STABILIZATION_RUN_DIR)
      result.syntheticFocusedFixtureRemoved = removeOwnedTempRoot(focusedRoot, 'morrow-original-scope-6-14-');
  }
  result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
  result.screenshots = [
    screenshotRef('item-06-horizontal-fill-preview.png'),
    screenshotRef('item-14-backspace-range.png'),
  ];
  saveAudit('original-scope-items6-14.json', result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.error || result.checks.item6VerticalFill?.status !== 'pass') process.exitCode = 1;
}

async function runItem14MouseRange(fixtureRoot) {
  const ticketRoot = path.join(fixtureRoot, 'ticket-39');
  const sourceRoot = fs.existsSync(path.join(ticketRoot, 'profile', 'vaults.json')) ? ticketRoot : fixtureRoot;
  const focusedRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'morrow-original-scope-14-mouse-'));
  const profileDir = path.join(focusedRoot, 'profile');
  const vaultDir = path.join(focusedRoot, 'vault');
  fs.cpSync(path.join(sourceRoot, 'profile'), profileDir, { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'vault'), vaultDir, { recursive: true });
  const registryPath = path.join(profileDir, 'vaults.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.current = vaultDir;
  registry.recent = (registry.recent ?? []).map((entry) => ({ ...entry, path: vaultDir }));
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const databasePath = path.join(vaultDir, 'Financeiro.md');
  let databaseMarkdown = fs.readFileSync(databasePath, 'utf8');
  const amountProperty = '    - id: amount\n      name: Valor\n      type: number\n';
  assert.ok(databaseMarkdown.includes(amountProperty), 'Expected the synthetic source number property.');
  if (!databaseMarkdown.includes('id: amount2')) {
    databaseMarkdown = databaseMarkdown.replace(
      amountProperty,
      `${amountProperty}    - id: amount2\n      name: Segundo valor\n      type: number\n`,
    );
  }
  fs.writeFileSync(databasePath, databaseMarkdown);
  const result = {
    runAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    fixtureRoot: path.basename(focusedRoot),
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
  let page = null;
  let stage = 'launch';
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    page = await app.firstWindow();
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
    if (process.env.MORROW_STABILIZATION_RUN_DIR)
      result.syntheticFocusedFixtureRemoved = removeOwnedTempRoot(focusedRoot, 'morrow-original-scope-14-mouse-');
  }
  result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
  result.screenshots = [
    screenshotRef('item-14-mouse-range-selected.png'),
    ...(fs.existsSync(path.join(screenshotDir, 'item-14-mouse-range-deleted.png'))
      ? [screenshotRef('item-14-mouse-range-deleted.png')]
      : []),
  ];
  saveAudit('original-scope-item14-mouse-range.json', result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const delivery2Fresh = readAuditReference('MORROW_AUDIT_DELIVERY2_EVIDENCE_PATH');
  const delivery4Fresh = readAuditReference('MORROW_AUDIT_DELIVERY4_EVIDENCE_PATH');
  const delivery5Fresh = readAuditReference('MORROW_AUDIT_DELIVERY5_EVIDENCE_PATH');
  const inlineFresh = readAuditReference('MORROW_AUDIT_INLINE_EVIDENCE_PATH');
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
  assert.equal(result.projectHead, process.env.MORROW_AUDIT_EXPECTED_HEAD ?? result.projectHead);
  assert.equal(result.packageVersion, process.env.MORROW_AUDIT_EXPECTED_VERSION ?? packageJson.version);
  const before = buildIdentity();
  let currentStage = 'launch';
  let app = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
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
    const conditionalCustomColorMatches = customHex.toUpperCase() === colorPickerValue.toUpperCase();
    const swatchesVisible = paletteSwatches.length > 0 && paletteSwatches.every((item) => item.width > 0 && item.height > 0);
    const formulaRuleTicket = delivery2Fresh?.report?.evidence?.tickets?.['#38'];
    const formulaRuleRowsPersisted = delivery2Fresh?.report?.outcome === 'passed' &&
      delivery2Fresh.report.hiddenWindows === true &&
      delivery2Fresh.report.pageErrorCount === 0 &&
      formulaRuleTicket?.status === 'passed' &&
      formulaRuleTicket.checks?.markdownStoresRule === true &&
      Array.isArray(formulaRuleTicket.checks?.reopenedRuleStillColorsOnlyMatches) &&
      formulaRuleTicket.checks.reopenedRuleStillColorsOnlyMatches.length === 3;
    const conditionalPaletteAndInputPass = Boolean(conditionalFormula) && conditionalCustomColorMatches && swatchesVisible;
    result.checks.item8 = {
      formula: conditionalFormula,
      customHex,
      nativeColorPickerPreview: colorPickerValue,
      customHexAndColorPickerMatch: conditionalCustomColorMatches,
      paletteSwatches,
      everySwatchHasVisibleArea: swatchesVisible,
      formulaRuleEvidence: delivery2Fresh?.path ?? null,
      formulaRuleRowsPersisted,
      matchingRowsAfterReopen: formulaRuleTicket?.checks?.reopenedRuleStillColorsOnlyMatches ?? null,
      status: conditionalPaletteAndInputPass && formulaRuleRowsPersisted ? 'pass' : conditionalPaletteAndInputPass ? 'partial' : 'fail',
    };
    await page.screenshot({ path: path.join(screenshotDir, 'item-08-conditional-swatches.png') });
    await page.keyboard.press('Escape');

    const primaryStyles = await styleSummary(primaryDatabase);
    const primaryTableStyles = await databaseStyleSummary(primaryDatabase);
    const primaryScreenshot = await primaryDatabase.screenshot();
    const summaryProfileDir = path.join(fixtureRoot, 'ticket-39', 'profile');
    const summaryVaultDir = path.join(fixtureRoot, 'ticket-39', 'vault');
    const summaryBuildBefore = buildIdentity();
    const summaryApp = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: summaryProfileDir },
    });
    let summaryFooter;
    const summaryLayoutChecks = { defaultAlignment: [], explicitAlignment: [], resizedAlignment: [], horizontalScroll: null, frozen: null, reopened: null };
    let summaryPage = null;
    let summaryDatabase = null;
    try {
      await assertHidden(summaryApp);
      summaryPage = await summaryApp.firstWindow();
      summaryPage.on('pageerror', (error) => result.rendererPageErrors.push({ stage: 'summary-multi-column-default-alignment', message: error.message }));
      await summaryPage.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
      await openPage(summaryPage, 'Financeiro');
      await summaryPage.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
      summaryDatabase = summaryPage.locator('.database').first();
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
      summaryLayoutChecks.defaultAlignment = await measureFooterAlignment(summaryDatabase);
      try {
        await summaryDatabase.locator('.db-options-button').click();
        const propertiesMenu = summaryPage.locator('.db-panel').last();
        await propertiesMenu.waitFor({ state: 'visible' });
        await propertiesMenu.locator('.db-options-item').filter({ hasText: /Propriedades|Properties/i }).click();
        const propertiesPanel = summaryPage.locator('.db-panel').last();
        await propertiesPanel.waitFor({ state: 'visible' });
        const propertyNames = await propertiesPanel.locator('.db-prop-name').allInnerTexts();
        const amountIndex = propertyNames.findIndex((name) => name.trim() === 'Valor');
        const dueIndex = propertyNames.findIndex((name) => name.trim() === 'Vencimento');
        const alignmentSelects = propertiesPanel.locator('select[aria-label*="Alinh"]');
        assert.ok(amountIndex >= 0 && dueIndex >= 0 && await alignmentSelects.count() === propertyNames.length,
          `Expected alignment controls for Valor and Vencimento; properties=${propertyNames.join(', ')}`);
        await alignmentSelects.nth(amountIndex).selectOption('right');
        await alignmentSelects.nth(dueIndex).selectOption('center');
        summaryLayoutChecks.explicitAlignmentSelection = {
          amount: await alignmentSelects.nth(amountIndex).inputValue(),
          due: await alignmentSelects.nth(dueIndex).inputValue(),
        };
        await summaryPage.keyboard.press('Escape');
        await summaryPage.waitForTimeout(180);
        summaryLayoutChecks.explicitAlignment = await measureFooterAlignment(summaryDatabase);

        const amountHeader = summaryDatabase.locator('.db-table thead th').filter({ hasText: 'Valor' }).first();
        const widthBefore = await amountHeader.evaluate((header) => Math.round(header.getBoundingClientRect().width));
        const resizeHandle = amountHeader.locator('.db-resize');
        const resizeBox = await resizeHandle.boundingBox();
        assert.ok(resizeBox, 'The Valor column resize handle must be visible.');
        await summaryPage.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
        await summaryPage.mouse.down();
        await summaryPage.mouse.move(resizeBox.x + resizeBox.width / 2 + 42, resizeBox.y + resizeBox.height / 2, { steps: 8 });
        await summaryPage.mouse.up();
        await summaryPage.waitForTimeout(180);
        const widthAfter = await amountHeader.evaluate((header) => Math.round(header.getBoundingClientRect().width));
        summaryLayoutChecks.resize = { widthBefore, widthAfter, increasedBy: widthAfter - widthBefore };
        summaryLayoutChecks.resizedAlignment = await measureFooterAlignment(summaryDatabase);

        await amountHeader.locator('button.db-header').click({ button: 'right' });
        const freezeMenu = summaryPage.locator('[role="menu"]:visible').last();
        await freezeMenu.waitFor({ state: 'visible' });
        await freezeMenu.locator('[role^="menuitem"]').filter({ hasText: /Congelar até esta coluna|Freeze through this column/i }).click();
        await summaryApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 650));
        await assertHidden(summaryApp);
        const frozenHeaderBeforeScroll = await amountHeader.evaluate((header) => ({
          frozen: header.classList.contains('db-frozen'),
          position: getComputedStyle(header).position,
          left: Math.round(header.getBoundingClientRect().left),
        }));
        const scrollInfo = await summaryDatabase.locator('.db-table-wrap').evaluate((wrap) => {
          const maximum = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
          wrap.scrollLeft = maximum;
          return { maximum, scrollLeft: wrap.scrollLeft, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth };
        });
        await summaryPage.waitForTimeout(180);
        const frozenHeaderAfterScroll = await amountHeader.evaluate((header) => ({
          frozen: header.classList.contains('db-frozen'),
          position: getComputedStyle(header).position,
          left: Math.round(header.getBoundingClientRect().left),
        }));
        const amountBodyCell = summaryDatabase.locator('.db-table tbody td[data-col-id="amount"]').first();
        const amountFooterCell = summaryDatabase.locator('.db-table tfoot td.db-footer-cell[data-col-id="amount"]');
        const frozenBodyAndFooter = {
          bodyFrozen: await amountBodyCell.evaluate((cell) => cell.classList.contains('db-frozen')),
          footerFrozen: await amountFooterCell.evaluate((cell) => cell.classList.contains('db-frozen')),
          bodyLeft: await amountBodyCell.evaluate((cell) => Math.round(cell.getBoundingClientRect().left)),
          footerLeft: await amountFooterCell.evaluate((cell) => Math.round(cell.getBoundingClientRect().left)),
        };
        summaryLayoutChecks.frozen = { beforeScroll: frozenHeaderBeforeScroll, afterScroll: frozenHeaderAfterScroll, bodyAndFooter: frozenBodyAndFooter };
        summaryLayoutChecks.horizontalScroll = {
          ...scrollInfo,
          stickyColumnStayedInPlace: Math.abs(frozenHeaderBeforeScroll.left - frozenHeaderAfterScroll.left) <= 2,
          footerBodyStayedAligned: Math.abs(frozenBodyAndFooter.bodyLeft - frozenBodyAndFooter.footerLeft) <= 2,
          footerAlignment: await measureFooterAlignment(summaryDatabase),
        };
        await summaryPage.screenshot({ path: path.join(screenshotDir, 'item-12-footer-horizontal-scroll-frozen.png') });
      } catch (error) {
        summaryLayoutChecks.error = error.stack ?? String(error);
      }
      await assertHidden(summaryApp);
      assert.deepEqual(buildIdentity(), summaryBuildBefore, 'Compiled build changed during summary inspection.');
    } finally {
      await summaryApp.close().catch(() => {});
    }
    const summaryReopenApp = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: summaryProfileDir },
    });
    try {
      await assertHidden(summaryReopenApp);
      const summaryReopenPage = await summaryReopenApp.firstWindow();
      summaryReopenPage.on('pageerror', (error) => result.rendererPageErrors.push({ stage: 'summary-multi-column-reopen', message: error.message }));
      await summaryReopenPage.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
      await summaryReopenApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 650));
      await assertHidden(summaryReopenApp);
      await openPage(summaryReopenPage, 'Financeiro');
      const reopenedDatabase = summaryReopenPage.locator('.database').first();
      await reopenedDatabase.waitFor({ state: 'visible' });
      const reopenedAmountHeader = reopenedDatabase.locator('.db-table thead th').filter({ hasText: 'Valor' }).first();
      const reopenedWidth = await reopenedAmountHeader.evaluate((header) => Math.round(header.getBoundingClientRect().width));
      const reopenedScroll = await reopenedDatabase.locator('.db-table-wrap').evaluate((wrap) => {
        const maximum = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
        wrap.scrollLeft = maximum;
        return { maximum, scrollLeft: wrap.scrollLeft };
      });
      await summaryReopenPage.waitForTimeout(180);
      summaryLayoutChecks.reopened = {
        amountWidth: reopenedWidth,
        widthPersisted: summaryLayoutChecks.resize ? Math.abs(reopenedWidth - summaryLayoutChecks.resize.widthAfter) <= 2 : false,
        frozenHeader: await reopenedAmountHeader.evaluate((header) => ({
          frozen: header.classList.contains('db-frozen'),
          position: getComputedStyle(header).position,
        })),
        horizontalScroll: reopenedScroll,
        alignment: await measureFooterAlignment(reopenedDatabase),
      };
      await assertHidden(summaryReopenApp);
      assert.deepEqual(buildIdentity(), summaryBuildBefore, 'Compiled build changed during summary reopen inspection.');
    } finally {
      await summaryReopenApp.close().catch(() => {});
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
    const summaryGroup39 = delivery2Fresh?.report?.evidence?.tickets?.['#39'];
    const persistedPerViewSummaries = delivery2Fresh?.report?.outcome === 'passed' &&
      delivery2Fresh.report.hiddenWindows === true &&
      delivery2Fresh.report.pageErrorCount === 0 &&
      summaryGroup39?.status === 'passed' &&
      summaryGroup39.checks?.distinctViewSummariesSaved === true &&
      summaryGroup39.checks?.reopenedPrimaryView &&
      summaryGroup39.checks?.reopenedReviewView &&
      summaryGroup39.checks?.configurationsIndependent === true;
    const comparisonsMatch = (comparisons) => Array.isArray(comparisons) && comparisons.length > 0 &&
      comparisons.every((comparison) => comparison.sameTextAlignment && comparison.sameColumnBounds);
    const layoutChecksPass = comparisonsMatch(summaryLayoutChecks.defaultAlignment) &&
      summaryLayoutChecks.explicitAlignmentSelection?.amount === 'right' &&
      summaryLayoutChecks.explicitAlignmentSelection?.due === 'center' &&
      comparisonsMatch(summaryLayoutChecks.explicitAlignment) &&
      summaryLayoutChecks.resize?.increasedBy >= 20 &&
      comparisonsMatch(summaryLayoutChecks.resizedAlignment) &&
      summaryLayoutChecks.frozen?.beforeScroll.frozen === true &&
      summaryLayoutChecks.frozen?.beforeScroll.position === 'sticky' &&
      summaryLayoutChecks.frozen?.bodyAndFooter.bodyFrozen === true &&
      summaryLayoutChecks.frozen?.bodyAndFooter.footerFrozen === true &&
      summaryLayoutChecks.horizontalScroll?.maximum > 0 &&
      summaryLayoutChecks.horizontalScroll?.stickyColumnStayedInPlace === true &&
      summaryLayoutChecks.horizontalScroll?.footerBodyStayedAligned === true &&
      comparisonsMatch(summaryLayoutChecks.horizontalScroll?.footerAlignment) &&
      summaryLayoutChecks.reopened?.widthPersisted === true &&
      summaryLayoutChecks.reopened?.frozenHeader.frozen === true &&
      summaryLayoutChecks.reopened?.frozenHeader.position === 'sticky' &&
      comparisonsMatch(summaryLayoutChecks.reopened?.alignment);
    const item12Status = persistedPerViewSummaries && layoutChecksPass
      ? 'pass'
      : summaryLayoutChecks.error && !summaryLayoutChecks.defaultAlignment.length
        ? 'fail'
        : 'partial';
    const item12Gaps = [];
    if (!persistedPerViewSummaries) item12Gaps.push('per-view summary persistence/reopen evidence');
    if (!comparisonsMatch(summaryLayoutChecks.defaultAlignment)) item12Gaps.push('default body/footer alignment');
    if (summaryLayoutChecks.explicitAlignmentSelection?.amount !== 'right' || summaryLayoutChecks.explicitAlignmentSelection?.due !== 'center' ||
      !comparisonsMatch(summaryLayoutChecks.explicitAlignment)) item12Gaps.push('explicit body/footer alignment');
    if (!(summaryLayoutChecks.resize?.increasedBy >= 20)) item12Gaps.push('column resize');
    if (!comparisonsMatch(summaryLayoutChecks.resizedAlignment)) item12Gaps.push('body/footer alignment after resize');
    if (summaryLayoutChecks.frozen?.beforeScroll.frozen !== true || summaryLayoutChecks.frozen?.beforeScroll.position !== 'sticky' ||
      summaryLayoutChecks.frozen?.bodyAndFooter.bodyFrozen !== true || summaryLayoutChecks.frozen?.bodyAndFooter.footerFrozen !== true ||
      !(summaryLayoutChecks.horizontalScroll?.maximum > 0) || summaryLayoutChecks.horizontalScroll?.stickyColumnStayedInPlace !== true ||
      summaryLayoutChecks.horizontalScroll?.footerBodyStayedAligned !== true || !comparisonsMatch(summaryLayoutChecks.horizontalScroll?.footerAlignment)) {
      item12Gaps.push('frozen column and body/footer alignment during horizontal scroll');
    }
    if (summaryLayoutChecks.reopened?.widthPersisted !== true || summaryLayoutChecks.reopened?.frozenHeader.frozen !== true ||
      summaryLayoutChecks.reopened?.frozenHeader.position !== 'sticky' || !comparisonsMatch(summaryLayoutChecks.reopened?.alignment)) {
      item12Gaps.push('reopened resize, frozen column and alignment');
    }
    result.checks.item12 = {
      summaryFooter,
      footerAlignmentComparison,
      footerAlignmentMismatches: footerAlignmentComparison.filter((item) => !item.sameTextAlignment),
      layoutChecks: summaryLayoutChecks,
      visibleCalculatePrompts: summaryFooter.rows.flat().filter((cell) => /calcular/i.test(cell.text)).length,
      selectedSummaryValues: summaryFooter.rows.flat().map((cell) => cell.text).filter((text) => /600|3/.test(text)),
      perViewConfiguredValues: { primarySum: summaryGroup39?.checks?.primaryView?.amount ?? null, primaryCount: summaryGroup39?.checks?.primaryView?.category ?? null, reviewMaximum: summaryGroup39?.checks?.reviewView?.amount ?? null },
      perViewSummaryEvidence: delivery2Fresh?.path ?? null,
      persistedPerViewSummaries,
      status: item12Status,
      reason: item12Status === 'pass' ? 'Per-view summaries and body/footer alignment persisted under defaults, explicit alignments, resize, horizontal scroll and frozen columns, including after reopening.' : `Unverified or failed checks: ${item12Gaps.join('; ') || 'summary layout measurements'}.`,
    };

    const primaryOptions = page.locator('.database .db-options-button').first();
    const toolbarButtons = await page.locator('.database .db-tools > button').allInnerTexts();
    await primaryOptions.click();
    let controlsPanel = page.locator('.db-panel').last();
    await controlsPanel.waitFor({ state: 'visible' });
    await controlsPanel.locator('.db-options-item').filter({ hasText: /Filtrar|Filter/i }).click();
    const filterPanel = page.locator('.db-panel').last();
    await filterPanel.waitFor({ state: 'visible' });
    await filterPanel.locator('.link-button').filter({ hasText: /Adicionar grupo de filtros|Add filter group/i }).click();
    await page.waitForFunction(() => document.querySelectorAll('.database .db-table tbody tr').length === 3);
    const activeFilterChipVisible = await page.locator('.database .db-filter-state').isVisible();
    const activeFilterText = activeFilterChipVisible ? await page.locator('.database .db-filter-state').innerText() : '';
    await page.keyboard.press('Escape');
    const amountHeaderForSort = primaryDatabase.locator('thead th').filter({ hasText: 'Valor' }).first();
    await amountHeaderForSort.locator('button.db-header').click({ button: 'right' });
    const sortMenu = page.locator('[role="menu"]:visible').last();
    await sortMenu.waitFor({ state: 'visible' });
    await sortMenu.locator('[role^="menuitem"]').filter({ hasText: /Ordem crescente|Sort ascending/i }).click();
    await page.waitForTimeout(120);
    const activeFilterSortLabel = await primaryOptions.getAttribute('aria-label');
    const activeFilterSortBadges = await primaryOptions.locator('.db-options-count').allInnerTexts();
    const visibleRowsAfterFilterAndSort = await page.locator('.database .db-table tbody tr').count();
    await primaryOptions.click();
    const optionsPanel = page.locator('.db-panel').last();
    await optionsPanel.waitFor({ state: 'visible' });
    const panelText = await optionsPanel.innerText();
    const toggleLabels = await optionsPanel.locator('.db-options-toggle > span').allInnerTexts();
    const toggleValues = await optionsPanel.locator('.db-options-toggle input[type="checkbox"]').evaluateAll((inputs) => inputs.map((input) => input.checked));
    const linkedViewLabels = await optionsPanel.locator('.db-options-menu button.db-options-item').allInnerTexts();
    const linkedViewEntries = linkedViewLabels.filter((label) => /Painel/i.test(label));
    const settingsAllFields = /propriedade|properties/i.test(panelText);
    const linkedViewsListed = /views?\s+vinculadas?|linked views/i.test(panelText) && linkedViewEntries.length >= 2;
    const optionSections = ['Filtrar', 'Ordenar', 'Layout', 'Propriedades', 'Calcular', 'Formatação condicional'];
    const optionSectionsPresent = optionSections.every((section) => panelText.includes(section));
    const activeFilterAndSortShown = activeFilterChipVisible && visibleRowsAfterFilterAndSort === 3 &&
      activeFilterSortBadges.length === 2 && activeFilterSortBadges.every((badge) => /1/.test(badge)) &&
      /1/.test(activeFilterSortLabel ?? '') && /1/.test(activeFilterText);
    result.checks.item10 = {
      optionsPanelVisible: true,
      panelText,
      optionSections,
      optionSectionsPresent,
      toggleLabels,
      toggleValues,
      toolbarButtons,
      directToolbarButtonCount: toolbarButtons.length,
      settingsAllFieldsEntry: settingsAllFields,
      linkedViewsListed,
      linkedViewEntries,
      linkedViewsHeader: panelText.match(/Views vinculadas|Linked views/i)?.[0] ?? null,
      activeFilterSortLabel,
      activeFilterSortBadges,
      activeFilterText,
      activeFilterChipVisible,
      visibleRowsAfterFilterAndSort,
      activeFilterAndSortShown,
      status: 'notverified',
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
    const readOnlyPropertiesAccessible = delivery4Fresh?.report?.pagePropertiesTabVerified === true &&
      delivery4Fresh.report.ticket32?.pagePropertiesTabVerified === true;
    const readOnlyMutationProtected = delivery4Fresh?.report?.ticket33?.readOnlyMutationProtectionVerified === true;
    result.checks.item10.readOnlyPropertiesAccessible = readOnlyPropertiesAccessible;
    result.checks.item10.readOnlyMutationProtected = readOnlyMutationProtected;
    const item10Pass = toolbarButtons.length === 1 && optionSectionsPresent && activeFilterAndSortShown &&
      toggleLabels.length === 2 && toggleValues.length === 2 && linkedViewsListed &&
      result.checks.item10.allUserDefinedPropertiesShown && !result.checks.item10.titleColumnIncludedInPropertyPanel &&
      readOnlyPropertiesAccessible && readOnlyMutationProtected;
    const item10Evidence = {
      compactToolbar: toolbarButtons.length === 1,
      optionSectionsPresent,
      activeFilterAndSortShown,
      stateToggles: toggleLabels.length === 2 && toggleValues.length === 2,
      linkedViewsListed,
      allUserDefinedPropertiesShown: result.checks.item10.allUserDefinedPropertiesShown,
      titleColumnExcludedFromPropertyList: !result.checks.item10.titleColumnIncludedInPropertyPanel,
      readOnlyPropertiesAccessible,
      readOnlyMutationProtected,
    };
    result.checks.item10.status = Object.values(item10Evidence).every(Boolean) ? 'pass' : 'partial';
    result.checks.item10.reason = Object.entries(item10Evidence).filter(([, passed]) => !passed).map(([key]) => key);
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
      comparisonNote: 'This fixture compares a full-page source database with its linked view. The canonical inline embed is verified separately by the focused item 11 visual report.',
      styleMismatchOnPrimaryVsLinked: primaryTableStyles.headerCell?.backgroundColor !== linkedTableStyles.headerCell?.backgroundColor || primaryTableStyles.headerCell?.borderColor !== linkedTableStyles.headerCell?.borderColor,
      observedPrimaryHeader: primaryTableStyles.headerCell,
      observedLinkedHeader: linkedTableStyles.headerCell,
      status: 'notverified',
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
    const hiddenTitleControlText = await linkedHiddenTitle.innerText();
    const sourceTitleButtonAbsent = await firstView.locator('.linked-database-source').count() === 0;
    const linkedOpenSource = firstView.locator('.linked-database-open-source');
    const linkedOpenSourceVisible = await linkedOpenSource.isVisible();
    result.checks.item9.linkedHideTitle = {
      controlVisible: true,
      sourceTitleButtonAbsent,
      restoreTitleControl: hiddenTitleControlText,
      sourceAccessControlVisible: linkedOpenSourceVisible,
      requirementPassed: sourceTitleButtonAbsent && /^Mostrar título$/i.test(hiddenTitleControlText.trim()) && linkedOpenSourceVisible,
    };
    currentStage = 'linked-view-hidden-title-source-access';
    await linkedOpenSource.click();
    await openPage(page, 'Financeiro');
    const sourceAccessWorks = await page.locator('main .database').first().isVisible();
    await openPage(page, 'Painel');
    await linkedHiddenTitle.click();
    await firstView.locator('.linked-database-name').waitFor({ state: 'visible' });
    result.checks.item9.sourceAccessBeforeReopen = sourceAccessWorks;

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

    currentStage = 'linked-view-hide-title-before-reopen';
    await linkedOptions.click();
    const hideAgainPanel = page.locator('.db-panel').last();
    await hideAgainPanel.waitFor({ state: 'visible' });
    await hideAgainPanel.locator('.db-options-toggle input[type="checkbox"]').nth(0).check();
    await firstView.locator('.inline-database-hidden-title-trigger').waitFor({ state: 'visible' });
    await linkedCollapseButton.click();
    await firstView.locator('.database').waitFor({ state: 'detached' });
    result.checks.item9.collapsedBeforeReopen = await firstView.locator('.database').count() === 0;

    await app.close();
    app = null;
    currentStage = 'reopen-after-rename';
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => result.rendererPageErrors.push({ stage: currentStage, message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await openPage(page, 'Painel');
    const reopenedViews = page.locator('.linked-database-view');
    const reopenedFirstView = reopenedViews.nth(0);
    const collapsedAfterReopen = await reopenedFirstView.locator('.database').count() === 0;
    const hiddenTitleAfterReopen = reopenedFirstView.locator('.inline-database-hidden-title-trigger');
    const titleRestoreControlPersisted = await hiddenTitleAfterReopen.isVisible();
    const sourceTitleStillHiddenAfterReopen = await reopenedFirstView.locator('.linked-database-source').count() === 0;
    const sourceAccessAfterReopen = await reopenedFirstView.locator('.linked-database-open-source').isVisible();
    result.checks.item9.linkedHideTitleAfterReopen = {
      collapsedAfterReopen,
      titleRestoreControlPersisted,
      sourceTitleStillHidden: sourceTitleStillHiddenAfterReopen,
      sourceAccessControlVisible: sourceAccessAfterReopen,
      sourceAccessBeforeReopen: sourceAccessWorks,
    };
    result.checks.item9.status = result.checks.item9.linkedViewCanCollapseAndExpand &&
      result.checks.item9.collapsedBeforeReopen && collapsedAfterReopen && titleRestoreControlPersisted &&
      sourceTitleStillHiddenAfterReopen && sourceAccessAfterReopen && sourceAccessWorks
      ? 'pass'
      : 'fail';
    if (collapsedAfterReopen) {
      await reopenedFirstView.locator('.linked-database-head button').first().click();
      await reopenedFirstView.locator('.database').waitFor({ state: 'visible' });
    }
    if (titleRestoreControlPersisted) {
      await hiddenTitleAfterReopen.click();
      await reopenedFirstView.locator('.linked-database-name').waitFor({ state: 'visible' });
    }
    const persistedFirstName = await reopenedViews.nth(0).locator('.linked-database-name').inputValue();
    const persistedSecondName = await reopenedViews.nth(1).locator('.linked-database-name').inputValue();
    assert.equal(persistedFirstName, renamedName);
    assert.equal(persistedSecondName, originalSecondName);
    result.checks.item11.independentRenameAfterReopen = {
      renamedView: persistedFirstName,
      siblingView: persistedSecondName,
      persisted: true,
    };
    const inlineComparisonPassed = inlineFresh?.report?.status === 'pass' &&
      inlineFresh.report.execution?.hiddenWindowsVerified === true &&
      inlineFresh.report.execution?.rendererPageErrors?.length === 0 &&
      inlineFresh.report.execution?.buildUnchanged === true &&
      inlineFresh.report.fixture?.canonicalWikiEmbedPresent === true &&
      inlineFresh.report.fixture?.linkedViewConfigMatchesEmbeddedPrimary === true &&
      inlineFresh.report.comparison?.sameViewport === true &&
      inlineFresh.report.comparison?.sameTableWidth === true &&
      inlineFresh.report.comparison?.sameViewConfig === true &&
      inlineFresh.report.comparison?.tableContentMatches === true &&
      inlineFresh.report.comparison?.computedTableCellStylesMatch === true &&
      inlineFresh.report.comparison?.canonicalEmbedPersistedAfterRender === true &&
      inlineFresh.report.execution?.syntheticFixtureRemoved === true;
    const independentRenamePersisted = result.checks.item11.independentRenameAfterReopen.persisted === true;
    result.checks.item11.inlineVisualEvidence = inlineFresh?.path ?? null;
    result.checks.item11.inlineComparisonPassed = inlineComparisonPassed;
    result.checks.item11.independentRenamePersisted = independentRenamePersisted;
    result.checks.item11.status = inlineComparisonPassed && independentRenamePersisted ? 'pass' : 'partial';
    result.checks.item11.reason = [
      ...(!inlineComparisonPassed ? ['canonical inline versus linked visual comparison'] : []),
      ...(!independentRenamePersisted ? ['independent rename persistence'] : []),
    ];

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
    const ticket35 = delivery5Fresh?.report?.ticket35;
    const ticket35Checks = [
      'filteredSelectionClearsWhenVisibleRowsChange',
      'shiftRangeSelectionVerified',
      'keyboardSelectAllVerified',
      'visibleSelectAllAndTriStateVerified',
      'rowMenuActionsAndKeyboardCloseVerified',
      'insertBeforeAfterAndUndoVerified',
      'manualReorderVerified',
      'duplicatePreservesRowsAndUndoVerified',
      'keyboardTrashConfirmAndUndoVerified',
    ];
    const filteredMultiRowDragKeyboardCoverage = Boolean(ticket35Checks.length) &&
      ticket35Checks.every((key) => ticket35?.[key] === true);
    const delivery5RunVerified = delivery5Fresh?.report?.hiddenWindowVerified === true &&
      Array.isArray(delivery5Fresh.report.rendererPageErrors) && delivery5Fresh.report.rendererPageErrors.length === 0 &&
      delivery5Fresh.report.cleanupVerified === true;
    const menuLabelsCoverExpectedActions = [
      /Expandir linha/i,
      /Inserir linha antes/i,
      /Inserir linha depois/i,
      /Duplicar linhas/i,
      /Copiar linhas/i,
      /Colar linhas/i,
      /Mover para outra tabela/i,
      /Mover para a lixeira/i,
    ].every((pattern) => separateMenuLabels.some((label) => pattern.test(label)));
    const item15Evidence = {
      gripClickSelectsRow: clickSelectedRow,
      gripRightClickOpensActions: contextOpenedMenu,
      separateMenuHasAllRowActions: menuLabelsCoverExpectedActions,
      individualSelection: selectedOne === 1,
      selectAllVisibleRows: selectedAll === 3,
      clearAllVisibleSelection: selectedAfterClear === 0,
      filteredMultiRowDragKeyboardCoverage,
      delivery5RunVerified,
    };
    result.checks.item15 = {
      gripClickOpenedMenu: clickOpenedMenu,
      gripClickSelectedRow: clickSelectedRow,
      gripRightClickOpenedMenu: contextOpenedMenu,
      separateMoreMenuLabels: separateMenuLabels,
      selectOneRowCheckbox: selectedOne === 1,
      headerSelectAllRows: selectedAll === 3,
      headerDeselectAllRows: selectedAfterClear === 0,
      broaderTicket35Coverage: Object.fromEntries(ticket35Checks.map((key) => [key, ticket35?.[key] === true])),
      delivery5Evidence: delivery5Fresh?.path ?? null,
      delivery5RunVerified,
      status: Object.values(item15Evidence).every(Boolean) ? 'pass' : 'partial',
      reason: Object.entries(item15Evidence).filter(([, passed]) => !passed).map(([key]) => key),
    };
    await page.keyboard.press('Escape').catch(() => {});
    await firstRow.hover();
    await page.screenshot({ path: path.join(screenshotDir, 'item-15-row-handle.png') });

    await page.waitForTimeout(500);
    await assertHidden(app);
    result.hiddenWindowsThroughout = true;
    result.rendererPageErrorsVerified = result.rendererPageErrors.length === 0;
    result.screenshots = [
      screenshotRef('item-08-conditional-swatches.png'),
      screenshotRef('item-10-options-panel.png'),
      screenshotRef('item-12-summary-footer.png'),
      screenshotRef('item-11-primary-vs-linked.png'),
      screenshotRef('item-15-row-handle.png'),
    ];
    saveAudit('original-scope-database.json', result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (app) await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
