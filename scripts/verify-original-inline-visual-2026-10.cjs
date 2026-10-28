const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const projectRoot = path.resolve(__dirname, '..');
const fixtureSource = path.join(os.tmpdir(), 'morrow-delivery1-ui-c9C3eD', 'ticket-30');
const screenshotDir = path.join(projectRoot, 'docs', 'evidence', 'original-scope-inline-2026-10-28');
const evidencePath = path.join(projectRoot, 'docs', 'evidence', 'original-scope-inline-2026-10-28.json');
const screenshotNames = [];

function saveEvidence(evidence) {
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function buildIdentity() {
  const rendererDir = path.join(projectRoot, 'dist');
  const assets = fs.readdirSync(path.join(rendererDir, 'assets')).sort().map((name) => {
    const stat = fs.statSync(path.join(rendererDir, 'assets', name));
    return { name, size: stat.size, mtime: stat.mtime.toISOString() };
  });
  return {
    mainMtime: fs.statSync(path.join(projectRoot, 'dist-electron', 'main.cjs')).mtime.toISOString(),
    rendererIndexMtime: fs.statSync(path.join(rendererDir, 'index.html')).mtime.toISOString(),
    rendererAssetCount: assets.length,
    rendererAssetManifestSha256: crypto.createHash('sha256').update(JSON.stringify(assets)).digest('hex'),
  };
}

function readDatabaseDefinition(markdown) {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'Financeiro fixture must have YAML frontmatter');
  const frontmatter = YAML.parse(match[1]);
  assert.ok(frontmatter.database?.views?.length, 'Financeiro fixture must have views');
  return frontmatter.database;
}

function linkedViewMarker(blockId, name, sourceView) {
  const view = { ...sourceView, id: `${blockId}-view`, name };
  const payload = encodeURIComponent(JSON.stringify({ sourceDatabaseId: 'finance-db', blockId, view }));
  return `<!-- morrow:linked-view:v1:${payload} -->\n\n**Linked database view:** [[Financeiro]] — comparison fixture.`;
}

function normalizedView(view) {
  const { id, name, ...config } = view;
  return config;
}

async function assertHidden(app, checks, stage) {
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  checks.push({ stage, visible });
  assert.equal(visible, 0, `Electron must remain hidden at ${stage}`);
}

async function openPage(page, title) {
  const rows = page.locator('.tree-row, .link-row');
  let target = null;
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    if ((await row.innerText()).split('\n')[0].trim() === title) {
      target = row;
      break;
    }
  }
  assert.ok(target, `Synthetic page ${title} should be present in the sidebar`);
  await target.click();
  await page.waitForFunction((expected) => document.querySelector('main')?.innerText.includes(expected), title);
  await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
}

async function saveScreenshot(page, name, locator = null) {
  const absolute = path.join(screenshotDir, name);
  if (locator) await locator.screenshot({ path: absolute });
  else await page.screenshot({ path: absolute });
  screenshotNames.push(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
  return absolute;
}

async function captureVisualSummary(wrapper) {
  return wrapper.evaluate((root) => {
    const styleSummary = (element) => {
      if (!element) return null;
      const css = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const border = (side) => ({
        color: css[`border${side}Color`],
        style: css[`border${side}Style`],
        width: css[`border${side}Width`],
      });
      return {
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        display: css.display,
        color: css.color,
        backgroundColor: css.backgroundColor,
        font: {
          family: css.fontFamily,
          size: css.fontSize,
          weight: css.fontWeight,
          lineHeight: css.lineHeight,
          letterSpacing: css.letterSpacing,
        },
        border: { top: border('Top'), right: border('Right'), bottom: border('Bottom'), left: border('Left') },
        borderRadius: css.borderRadius,
        padding: { top: css.paddingTop, right: css.paddingRight, bottom: css.paddingBottom, left: css.paddingLeft },
        margin: { top: css.marginTop, right: css.marginRight, bottom: css.marginBottom, left: css.marginLeft },
        textAlign: css.textAlign,
        verticalAlign: css.verticalAlign,
        tableLayout: css.tableLayout,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    };
    const table = root.querySelector('table.db-table');
    const database = root.querySelector('.database');
    const headerCell = table?.querySelector('thead th') ?? null;
    const bodyCell = table?.querySelector('tbody td') ?? null;
    const headers = Array.from(table?.querySelectorAll('thead th') ?? []).map((cell) => cell.innerText.trim());
    const rows = Array.from(table?.querySelectorAll('tbody tr') ?? []).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.innerText.trim()),
    );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      wrapper: styleSummary(root),
      pageEmbedShell: styleSummary(root.closest('.page-embed')),
      database: styleSummary(database),
      table: styleSummary(table),
      headerCell: styleSummary(headerCell),
      bodyCell: styleSummary(bodyCell),
      headers,
      rows,
    };
  });
}

function visualStyleMismatches(left, right) {
  const fields = [
    'display', 'color', 'backgroundColor', 'font', 'border', 'borderRadius', 'padding', 'textAlign', 'verticalAlign', 'tableLayout',
  ];
  const differences = [];
  for (const nodeName of ['wrapper', 'pageEmbedShell', 'database', 'table', 'headerCell', 'bodyCell']) {
    for (const field of fields) {
      const leftValue = left[nodeName]?.[field] ?? null;
      const rightValue = right[nodeName]?.[field] ?? null;
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        differences.push({ node: nodeName, field, inline: leftValue, linked: rightValue });
      }
    }
  }
  return differences;
}

async function main() {
  assert.ok(fs.existsSync(path.join(fixtureSource, 'vault', '.morrow', 'workspace.json')), 'Fresh delivery1 #30 fixture must exist');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-inline-item11-'));
  const profileDir = path.join(fixtureRoot, 'profile');
  const vaultDir = path.join(fixtureRoot, 'vault');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.cpSync(path.join(fixtureSource, 'vault'), vaultDir, { recursive: true });
  const copiedHistoryDir = path.join(vaultDir, '.morrow', 'history');
  if (copiedHistoryDir.startsWith(`${fixtureRoot}${path.sep}`)) fs.rmSync(copiedHistoryDir, { recursive: true, force: true });
  const sourceWorkspace = JSON.parse(fs.readFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), 'utf8'));
  assert.equal(sourceWorkspace.pages['Financeiro.md']?.id, 'finance-db');
  assert.equal(sourceWorkspace.pages['Painel.md']?.id, 'dashboard-page');
  const profileVaults = { current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] };
  fs.writeFileSync(path.join(profileDir, 'vaults.json'), JSON.stringify(profileVaults, null, 2), 'utf8');

  const financePath = path.join(vaultDir, 'Financeiro.md');
  const financeDatabase = readDatabaseDefinition(fs.readFileSync(financePath, 'utf8'));
  const primaryView = financeDatabase.views[0];
  const financeRows = [
    ['Alfa', 100, '2026-11-02', true, 'Infra'],
    ['Beta', 200, '2026-11-12', false, 'Desenvolvimento'],
    ['Gama', 300, '2026-11-22', true, 'Infra'],
  ];
  for (const [name, amount, due, done, category] of financeRows) {
    fs.writeFileSync(
      path.join(vaultDir, 'Financeiro', `${name}.md`),
      `---\nValor: ${amount}\nVencimento: "${due}"\nConcluído: ${done}\nCategoria: ${category}\n---\n# ${name}\n`,
      'utf8',
    );
  }
  const linkedViewOne = { ...primaryView, id: 'inline-compare-a-view', name: 'Comparação Alfa' };
  const linkedViewTwo = { ...primaryView, id: 'inline-compare-b-view', name: 'Comparação Beta' };
  fs.writeFileSync(path.join(vaultDir, 'Interface.md'), '# Interface sintética\n\n![[Financeiro]]\n', 'utf8');
  fs.writeFileSync(
    path.join(vaultDir, 'Painel.md'),
    `# Painel sintético\n\n${linkedViewMarker('inline-compare-a', 'Comparação Alfa', linkedViewOne)}\n\n${linkedViewMarker('inline-compare-b', 'Comparação Beta', linkedViewTwo)}\n`,
    'utf8',
  );

  const embedSource = fs.readFileSync(path.join(vaultDir, 'Interface.md'), 'utf8');
  const linkedSource = fs.readFileSync(path.join(vaultDir, 'Painel.md'), 'utf8');
  const linkedPayloads = [...linkedSource.matchAll(/<!--\s*morrow:linked-view:v1:([^\s]+)\s*-->/g)].map((match) =>
    JSON.parse(decodeURIComponent(match[1])),
  );
  assert.equal(linkedPayloads.length, 2, 'Painel fixture must contain two linked views');
  assert.ok(linkedPayloads.every((entry) => entry.sourceDatabaseId === 'finance-db'));
  const sameViewConfig = linkedPayloads.every((entry) =>
    JSON.stringify(normalizedView(entry.view)) === JSON.stringify(normalizedView(primaryView)),
  );

  const evidence = {
    audit: 'Focused original item 11 inline database versus linked view visual comparison',
    startedAt: new Date().toISOString(),
    projectHead: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    syntheticDataOnly: true,
    scope: 'Only item 11 visual comparison; no product code changes, clipboard interaction, OS dialog, build, or suite run.',
    fixture: {
      source: 'Fresh copy of delivery1 ticket #30 synthetic vault',
      sourcePath: path.basename(path.dirname(fixtureSource)) + '/' + path.basename(fixtureSource),
      fixtureRoot: path.basename(fixtureRoot),
      interfaceMarkdown: embedSource.trim(),
      canonicalWikiEmbedPresent: embedSource.includes('![[Financeiro]]'),
      inlineEmbedTargetId: 'finance-db',
      linkedViewCount: linkedPayloads.length,
      linkedViewNames: linkedPayloads.map((entry) => entry.view.name),
      linkedViewConfigMatchesEmbeddedPrimary: sameViewConfig,
      viewConfig: { embeddedPrimary: primaryView, linkedViews: linkedPayloads.map((entry) => entry.view) },
    },
    execution: {
      mode: 'Hidden Electron with synthetic fixture',
      hiddenWindowsVerified: true,
      visibleWindowChecks: [],
      visibleWindowCountMax: 0,
      rendererPageErrors: [],
      screenshots: [],
      buildBefore: buildIdentity(),
    },
    status: 'running',
  };
  saveEvidence(evidence);

  const pageErrors = evidence.execution.rendererPageErrors;
  let app = null;
  let page = null;
  try {
    app = await _electron.launch({
      executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
      cwd: projectRoot,
      env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
    });
    await assertHidden(app, evidence.execution.visibleWindowChecks, 'launch');
    page = await app.firstWindow();
    page.on('pageerror', (error) => pageErrors.push({ stage: 'renderer', message: error.message }));
    await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await page.waitForTimeout(120);
    await assertHidden(app, evidence.execution.visibleWindowChecks, 'viewport:1600x1000');

    await openPage(page, 'Interface');
    await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(350);
    const embedDom = await page.locator('.ProseMirror').first().evaluate((editor) => {
      const link = editor.querySelector('a.page-link.is-embed');
      const wrapper = link?.closest('.page-embed') ?? null;
      return {
        linkFound: Boolean(link),
        linkAttributes: link ? Object.fromEntries(Array.from(link.attributes).map((attribute) => [attribute.name, attribute.value])) : null,
        linkText: link?.innerText ?? null,
        wrapperClass: wrapper?.className ?? null,
        embedBodyClass: wrapper?.querySelector('.page-embed-body')?.className ?? null,
        inlineDatabaseFound: Boolean(wrapper?.querySelector('.inline-database')),
      };
    });
    evidence.fixture.embedResolution = embedDom;
    if (!embedDom.inlineDatabaseFound) {
      evidence.status = 'notverified';
      evidence.finding = 'The synthetic wiki embed did not mount .inline-database; no style conclusion is drawn. Resolve target ID/registry from recorded DOM attributes before assessing item 11.';
      evidence.fixture.workspacePage = sourceWorkspace.pages['Financeiro.md'];
      evidence.fixture.financeDatabaseDefinitionFound = Boolean(financeDatabase.views.length);
      evidence.execution.buildAfter = buildIdentity();
      evidence.execution.buildUnchanged = JSON.stringify(evidence.execution.buildBefore) === JSON.stringify(evidence.execution.buildAfter);
      evidence.execution.hiddenWindowsVerified = evidence.execution.visibleWindowChecks.every((check) => check.visible === 0);
      saveEvidence(evidence);
      console.log(`Inline embed unresolved; item 11 visual result not verified. Evidence: ${evidencePath}`);
      return;
    }

    const inlineWrapper = page.locator('.ProseMirror .inline-database').first();
    await inlineWrapper.locator('table.db-table tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
    const inlineSummary = await captureVisualSummary(inlineWrapper);
    await saveScreenshot(page, 'inline-item11-embedded-view.png', inlineWrapper);
    await saveScreenshot(page, 'inline-item11-embedded-page.png');
    await assertHidden(app, evidence.execution.visibleWindowChecks, 'inline-database-captured');

    await openPage(page, 'Painel');
    const linkedViews = page.locator('.ProseMirror .linked-database-view');
    await linkedViews.first().waitFor({ state: 'visible' });
    assert.equal(await linkedViews.count(), 2);
    const linkedWrapper = linkedViews.first();
    await linkedWrapper.locator('table.db-table tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
    const linkedSummary = await captureVisualSummary(linkedWrapper);
    await saveScreenshot(page, 'inline-item11-linked-view.png', linkedWrapper);
    await saveScreenshot(page, 'inline-item11-linked-page.png');
    await assertHidden(app, evidence.execution.visibleWindowChecks, 'linked-database-captured');

    const styleMismatches = visualStyleMismatches(inlineSummary, linkedSummary);
    const tableContentMatches = JSON.stringify(inlineSummary.headers) === JSON.stringify(linkedSummary.headers) &&
      JSON.stringify(inlineSummary.rows) === JSON.stringify(linkedSummary.rows);
    const sameViewport = JSON.stringify(inlineSummary.viewport) === JSON.stringify(linkedSummary.viewport);
    const canonicalEmbedPersistedAfterRender = fs.readFileSync(path.join(vaultDir, 'Interface.md'), 'utf8').includes('![[Financeiro]]');

    const inlinePng = fs.readFileSync(path.join(screenshotDir, 'inline-item11-embedded-view.png')).toString('base64');
    const linkedPng = fs.readFileSync(path.join(screenshotDir, 'inline-item11-linked-view.png')).toString('base64');
    await page.evaluate(({ inlineBase64, linkedBase64 }) => {
      const overlay = document.createElement('div');
      overlay.id = 'inline-item11-comparison';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f7f7f7;color:#222;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;overflow:auto;font:14px system-ui,sans-serif;';
      overlay.innerHTML = `<section><h2>Inline real — ![[Financeiro]]</h2><img style="display:block;width:100%;max-height:820px;object-fit:contain;object-position:top left;background:white" src="data:image/png;base64,${inlineBase64}"></section><section><h2>Linked view — Painel</h2><img style="display:block;width:100%;max-height:820px;object-fit:contain;object-position:top left;background:white" src="data:image/png;base64,${linkedBase64}"></section>`;
      document.body.append(overlay);
    }, { inlineBase64: inlinePng, linkedBase64: linkedPng });
    await saveScreenshot(page, 'inline-item11-side-by-side.png');
    await page.evaluate(() => document.querySelector('#inline-item11-comparison')?.remove());

    evidence.comparison = {
      sameViewport,
      sameTableWidth: inlineSummary.table?.box.width === linkedSummary.table?.box.width,
      inlineTableWidth: inlineSummary.table?.box.width ?? null,
      linkedTableWidth: linkedSummary.table?.box.width ?? null,
      inline: inlineSummary,
      linked: linkedSummary,
      sameViewConfig: sameViewConfig,
      canonicalEmbedPersistedAfterRender,
      tableContentMatches,
      computedStyleMismatches: styleMismatches,
      computedTableCellStylesMatch: !styleMismatches.some((difference) => ['table', 'headerCell', 'bodyCell'].includes(difference.node)),
      screenshotNote: 'Captures show the real embedded database and the first linked database view side by side, using the same Financeiro database and identical view configuration; component shells remain measured separately.',
    };
    evidence.execution.buildAfter = buildIdentity();
    evidence.execution.buildUnchanged = JSON.stringify(evidence.execution.buildBefore) === JSON.stringify(evidence.execution.buildAfter);
    evidence.execution.hiddenWindowsVerified = evidence.execution.visibleWindowChecks.every((check) => check.visible === 0);
    evidence.execution.visibleWindowCountMax = Math.max(...evidence.execution.visibleWindowChecks.map((check) => check.visible));
    evidence.execution.screenshots = [...screenshotNames];
    assert.ok(tableContentMatches, 'Embedded and linked views should display the same source rows and columns');
    assert.ok(sameViewport, 'Both captures should use the same app viewport');
    assert.ok(sameViewConfig, 'Linked views should use the same view config as the embedded primary');
    assert.equal(pageErrors.length, 0, 'No renderer page errors should occur during the comparison');
    assert.equal(evidence.execution.buildUnchanged, true, 'Compiled build should remain unchanged');
    assert.equal(evidence.execution.hiddenWindowsVerified, true, 'App windows should remain hidden');
    evidence.status = evidence.comparison.computedTableCellStylesMatch ? 'pass' : 'partial';
    evidence.finding = evidence.comparison.computedTableCellStylesMatch
      ? 'The real inline database embed and the linked view share computed table, header, and cell styles under an identical view configuration.'
      : 'The real inline database comparison completed. Computed-style differences are recorded by DOM node and property; inline-versus-linked parity remains partial.';
  } catch (error) {
    evidence.status = 'failed';
    evidence.fatalError = error.stack ?? String(error);
    evidence.execution.rendererPageErrors = pageErrors;
    throw error;
  } finally {
    if (app) {
      await assertHidden(app, evidence.execution.visibleWindowChecks, 'close').catch((error) => {
        evidence.execution.hiddenWindowsVerified = false;
        evidence.execution.hiddenCheckError = error.message;
      });
      await app.close().catch(() => {});
    }
    evidence.execution.rendererPageErrors = pageErrors;
    evidence.execution.buildAfter ??= buildIdentity();
    evidence.execution.buildUnchanged ??= JSON.stringify(evidence.execution.buildBefore) === JSON.stringify(evidence.execution.buildAfter);
    evidence.execution.hiddenWindowsVerified = evidence.execution.visibleWindowChecks.every((check) => check.visible === 0) && evidence.execution.hiddenWindowsVerified !== false;
    evidence.execution.visibleWindowCountMax = Math.max(0, ...evidence.execution.visibleWindowChecks.map((check) => check.visible));
    evidence.execution.screenshots = [...screenshotNames];
    evidence.finishedAt = new Date().toISOString();
    saveEvidence(evidence);
  }
  console.log(`Item 11 focused visual comparison: ${evidence.status}`);
  console.log(`Computed table/header/cell styles match: ${evidence.comparison?.computedTableCellStylesMatch ?? 'not measured'}`);
  console.log(`Evidence: ${evidencePath}`);
}

main().catch((error) => {
  console.error(`Focused item 11 visual comparison failed: ${error.message}`);
  process.exitCode = 1;
});
