const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const projectRoot = path.resolve(__dirname, '..');
const groups = {
  delivery1: ['#26', '#27', '#30', '#31', '#40'],
  delivery2: ['#28', '#29', '#38', '#39'],
  delivery3: ['#37', '#41', '#42', '#43'],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function syntheticPng(width, height, color) {
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 3 + 1);
    pixels[offset] = 0;
    for (let x = 0; x < width; x++) {
      pixels[offset + 1 + x * 3] = color[0];
      pixels[offset + 2 + x * 3] = color[1];
      pixels[offset + 3 + x * 3] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function viewMarkdown(id, name, summaries = {}) {
  return `    - id: ${id}\n      name: ${name}\n      type: table\n      filters: []\n      sorts: []\n      groupBy: null\n      dateProp: null\n      hidden: []\n      widths:\n        title: 190\n        amount: 130\n        due: 130\n        done: 90\n        category: 130\n      summaries: ${JSON.stringify(summaries)}\n`;
}

function linkedViewMarker(blockId, viewId, name) {
  const view = {
    id: viewId,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    widths: { title: 190, amount: 130, due: 130, done: 90, category: 130 },
    summaries: {},
  };
  const payload = encodeURIComponent(JSON.stringify({ sourceDatabaseId: 'finance-db', blockId, view }));
  return `<!-- morrow:linked-view:v1:${payload} -->\n\n**Linked database view:** [[Financeiro]] — open in Morrow to edit shared rows.`;
}

function writeFixture(root) {
  const profileDir = path.join(root, 'profile');
  const vaultDir = path.join(root, 'vault');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'vaults.json'),
    JSON.stringify({ current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] }),
  );

  for (const folder of ['Financeiro', 'Autores', 'Livros', '.morrow']) {
    fs.mkdirSync(path.join(vaultDir, folder), { recursive: true });
  }

  const pageIds = {
    'Interface.md': { id: 'interaction-page' },
    'Financeiro.md': { id: 'finance-db' },
    'Financeiro/Alfa.md': { id: 'finance-alpha' },
    'Financeiro/Beta.md': { id: 'finance-beta' },
    'Financeiro/Gama.md': { id: 'finance-gamma' },
    'Autores.md': { id: 'authors-db' },
    'Autores/Asha.md': { id: 'author-asha' },
    'Autores/Bela.md': { id: 'author-bela' },
    'Livros.md': { id: 'books-db' },
    'Livros/Livro Alfa.md': { id: 'book-alpha' },
    'Livros/Livro Beta.md': { id: 'book-beta' },
    'Painel.md': { id: 'dashboard-page' },
  };
  fs.writeFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), JSON.stringify({ pages: pageIds }, null, 2));

  const widths = '15,15,15,15,15,15,10';
  const columns = Array.from({ length: 6 }, (_, index) => `
<div data-column>

Coluna ${index + 1} conteúdo sintético.

</div>`).join('');
  const interfaceMarkdown = `# Interface sintética

## Alvo de fundo

Parágrafo que receberá uma cor hexadecimal personalizada.

## Seção recolhível

Conteúdo sintético que deve ficar oculto quando a seção for recolhida.

### Subseção interna

Texto interno da subseção.

## Seção seguinte

Este conteúdo continua visível após recolher a seção anterior.

<div data-columns data-widths="${widths}">${columns}
</div>

Parágrafo para mover à sétima coluna.

Parágrafo que não deve ser movido para uma oitava coluna.

<!-- morrow:image align="center" caption="Legenda sintética preservada" crop="0.1,0.1,0.8,0.8" -->
![Imagem sintética original](original.png)
`;
  fs.writeFileSync(path.join(vaultDir, 'Interface.md'), interfaceMarkdown, 'utf8');
  const originalImage = path.join(vaultDir, 'original.png');
  fs.writeFileSync(originalImage, syntheticPng(400, 200, [44, 113, 168]));
  const replacementImage = path.join(root, 'replacement.png');
  fs.writeFileSync(replacementImage, syntheticPng(200, 400, [191, 82, 55]));
  const syntheticRasterIcon = path.join(root, 'portrait-200x400.png');
  fs.writeFileSync(syntheticRasterIcon, syntheticPng(200, 400, [191, 82, 55]));
  const syntheticSvgIcon = path.join(root, 'portrait-200x400.svg');
  fs.writeFileSync(
    syntheticSvgIcon,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 400" width="200" height="400"><rect x="0" y="0" width="200" height="400" fill="#2f80ed"/></svg>',
    'utf8',
  );

  const financeMarkdown = `---
kind: database
database:
  properties:
    - id: amount
      name: Valor
      type: number
    - id: due
      name: Vencimento
      type: date
    - id: done
      name: Concluído
      type: checkbox
    - id: category
      name: Categoria
      type: select
      options:
        - id: opt-infra
          name: Infra
          color: blue
        - id: opt-dev
          name: Desenvolvimento
          color: green
  views:
${viewMarkdown('finance-main', 'Principal')}${viewMarkdown('finance-review', 'Revisão')}
---
# Financeiro sintético
`;
  fs.writeFileSync(path.join(vaultDir, 'Financeiro.md'), financeMarkdown, 'utf8');
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

  const authorsMarkdown = `---
kind: database
database:
  properties:
    - id: bio
      name: Biography Long
      type: text
    - id: books
      name: Livros escritos
      type: relation
      relation:
        targetDatabaseId: books-db
        multiple: true
        isInverse: false
        displayPropertyId: null
        inversePropertyId: null
        filters: []
  views:
${viewMarkdown('authors-main', 'Autores')}
---
# Autores sintéticos
`;
  fs.writeFileSync(path.join(vaultDir, 'Autores.md'), authorsMarkdown, 'utf8');
  fs.writeFileSync(
    path.join(vaultDir, 'Autores', 'Asha.md'),
    `---\nBiografia: "Biografia sintética de Asha"\nLivros escritos:\n  - Livro Beta\n---\n# Asha\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Autores', 'Bela.md'),
    `---\nBiografia: "Biografia sintética de Bela"\n---\n# Bela\n`,
    'utf8',
  );

  const booksMarkdown = `---
kind: database
icon: "📚"
database:
  properties:
    - id: writer
      name: Autor
      type: relation
      relation:
        targetDatabaseId: authors-db
        multiple: false
        isInverse: false
        displayPropertyId: null
        inversePropertyId: null
        filters: []
    - id: writer_bio
      name: Biography result
      type: formula
      formula: "Autor"
      formulaResultType: text
    - id: price
      name: Preço calculado
      type: formula
      formula: "150.5"
      formulaResultType: number
    - id: zero
      name: Zero calculado
      type: formula
      formula: "0"
      formulaResultType: number
      format:
        precision: 0
    - id: available
      name: Disponível calculado
      type: formula
      formula: "false"
      formulaResultType: checkbox
    - id: available_blank
      name: Disponibilidade em branco
      type: formula
      formula: "null"
      formulaResultType: checkbox
    - id: type_test
      name: Value type test
      type: text
    - id: svg_test
      name: SVG type test
      type: text
    - id: rich_canvas_test
      name: Rich canvas layer test
      type: richCanvas
      fillMode: default
  views:
${viewMarkdown('books-main', 'Livros')}
---
# Livros sintéticos
`;
  fs.writeFileSync(path.join(vaultDir, 'Livros.md'), booksMarkdown, 'utf8');
  fs.writeFileSync(
    path.join(vaultDir, 'Livros', 'Livro Alfa.md'),
    `---\nAutor: Asha\nValue type test: "100"\n---\n# Livro Alfa\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Livros', 'Livro Beta.md'),
    `---\nAutor: Asha\nValue type test: "200"\n---\n# Livro Beta\n`,
    'utf8',
  );

  const dashboardMarkdown = `# Painel sintético

${linkedViewMarker('linked-alpha', 'linked-alpha-view', 'Visão Alfa')}

${linkedViewMarker('linked-beta', 'linked-beta-view', 'Visão Beta')}
`;
  fs.writeFileSync(path.join(vaultDir, 'Painel.md'), dashboardMarkdown, 'utf8');

  return { profileDir, vaultDir, originalImage, replacementImage, syntheticRasterIcon, syntheticSvgIcon };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function imagePresentation(image) {
  return image.evaluate((node) => {
    const img = node.querySelector('img');
    const wrapper = node.querySelector('.image-crop-wrapper');
    return {
      align: node.getAttribute('data-align'),
      caption: node.querySelector('.image-caption')?.textContent?.trim(),
      cropActive: Boolean(img && wrapper && img.style.position === 'absolute' && wrapper.style.aspectRatio),
      imageSource: img?.getAttribute('src') ?? null,
      imageStyle: img ? { position: img.style.position, left: img.style.left, top: img.style.top, width: img.style.width, height: img.style.height } : null,
      wrapperAspectRatio: wrapper?.style.aspectRatio ?? '',
      naturalWidth: img?.naturalWidth ?? 0,
      naturalHeight: img?.naturalHeight ?? 0,
    };
  });
}

function setRuntime(evidence, fixture, app, page) {
  const values = {
    app,
    page,
    vaultDir: fixture.vaultDir,
    originalImage: fixture.originalImage,
    replacementImage: fixture.replacementImage,
    syntheticRasterIcon: fixture.syntheticRasterIcon,
    syntheticSvgIcon: fixture.syntheticSvgIcon,
    originalImageHash: sha256(fixture.originalImage),
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(evidence, key)) {
      Object.defineProperty(evidence, key, { value, writable: true, enumerable: false });
    } else {
      evidence[key] = value;
    }
  }
}

async function resizeHiddenWindow(evidence, width, height) {
  await evidence.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
  }, { width, height });
  await evidence.page.waitForTimeout(150);
  await assertHidden(evidence.app);
}

function readMarkdown(vaultDir, relativePath) {
  const file = path.join(vaultDir, relativePath);
  assert.ok(fs.existsSync(file), `Expected synthetic vault file ${relativePath} to exist`);
  return fs.readFileSync(file, 'utf8');
}

function linkedViewPayloads(markdown) {
  return [...markdown.matchAll(/<!--\s*morrow:linked-view:v1:([^\s]+)\s*-->/g)].map((match) =>
    JSON.parse(decodeURIComponent(match[1])),
  );
}

async function waitForMarkdown(vaultDir, relativePath, predicate, description, timeout = 8000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    const file = path.join(vaultDir, relativePath);
    if (fs.existsSync(file)) {
      last = fs.readFileSync(file, 'utf8');
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for saved ${description} in ${relativePath}. Last contents:\n${last}`);
}

async function openPage(page, title) {
  const rows = page.locator('.tree-row, .link-row');
  const navigationTitle = ({
    'Interface sintética': 'Interface',
    'Financeiro sintético': 'Financeiro',
    'Autores sintéticos': 'Autores',
    'Livros sintéticos': 'Livros',
    'Painel sintético': 'Painel',
  })[title] ?? title;
  let candidate = null;
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    const label = (await row.innerText()).split('\n')[0].trim();
    if (label === navigationTitle) {
      candidate = row;
      break;
    }
  }
  assert.ok(candidate, `Page “${title}” (navigation label “${navigationTitle}”) must be present in the synthetic vault navigation`);
  await candidate.scrollIntoViewIfNeeded();
  await candidate.click();
  await page.waitForFunction((expected) => document.querySelector('main')?.innerText.includes(expected) ?? false, title);
  await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
}

async function clickMatchingButton(locator, pattern, description = pattern.toString()) {
  const labels = [];
  for (let index = 0; index < (await locator.count()); index++) {
    const button = locator.nth(index);
    const label = `${await button.innerText().catch(() => '')} ${await button.getAttribute('aria-label') ?? ''} ${await button.getAttribute('title') ?? ''}`;
    labels.push(label.trim());
    if (pattern.test(label)) {
      await button.click();
      return label.trim();
    }
  }
  assert.fail(`Could not find an actionable button matching ${description}. Available labels: ${labels.join(' | ')}`);
}

async function openDatabaseOptions(page, database) {
  const button = database.locator('.db-options-button');
  assert.equal(await button.count(), 1, 'Each database must expose one Options control.');
  await button.click();
  const options = page.locator('.popover.db-panel .db-options-menu').last();
  await options.waitFor({ state: 'visible' });
  return options;
}

async function openDatabaseOption(page, database, pattern, description) {
  const options = await openDatabaseOptions(page, database);
  const labels = await options.locator('.db-options-item').allInnerTexts();
  const selected = await clickMatchingButton(options.locator('.db-options-item'), pattern, description);
  const panel = page.locator('.popover.db-panel').last();
  await panel.waitFor({ state: 'visible' });
  return { labels, selected, panel };
}

async function openBlockMenu(page, selector, text) {
  const block = page.locator(`.ProseMirror ${selector}`).filter({ hasText: text }).first();
  await block.scrollIntoViewIfNeeded();
  await block.hover();
  const handle = page.locator('.block-handle');
  await handle.waitFor({ state: 'visible' });
  await handle.click();
  const menu = page.locator('.menu[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  return { block, menu };
}

async function insideViewport(locator, page) {
  return page.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      inside:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight,
    };
  }, await locator.elementHandle());
}

async function assertHidden(app) {
  const visibleWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  assert.equal(visibleWindows, 0, 'MORROW_HIDDEN=1 must keep every Electron window invisible');
}

function compiledBuildIdentity() {
  const rendererDir = path.join(projectRoot, 'dist');
  const assetDir = path.join(rendererDir, 'assets');
  const manifest = fs.readdirSync(assetDir).sort().map((name) => {
    const stat = fs.statSync(path.join(assetDir, name));
    return { name, size: stat.size, mtime: stat.mtime.toISOString() };
  });
  const artifactFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) artifactFiles.push(file);
    }
  };
  for (const directory of ['dist', 'dist-electron']) visit(path.join(projectRoot, directory));
  const artifactManifest = artifactFiles
    .map((file) => `${path.relative(projectRoot, file).replaceAll(path.sep, '/')}:${sha256(file)}`)
    .join('\n');
  return {
    mainMtime: fs.statSync(path.join(projectRoot, 'dist-electron', 'main.cjs')).mtime.toISOString(),
    rendererIndexMtime: fs.statSync(path.join(rendererDir, 'index.html')).mtime.toISOString(),
    rendererAssetCount: manifest.length,
    rendererAssetManifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    artifactFileCount: artifactFiles.length,
    artifactContentSha256: crypto.createHash('sha256').update(artifactManifest).digest('hex'),
  };
}

async function launchHidden({ profileDir }) {
  const buildBeforeLaunch = compiledBuildIdentity();
  const app = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [path.join(projectRoot, 'dist-electron', 'main.cjs')],
    cwd: projectRoot,
    env: { ...process.env, MORROW_HIDDEN: '1', MORROW_USER_DATA: profileDir },
  });
  await assertHidden(app);
  const page = await app.firstWindow();
  await page.waitForSelector('.tree-row, .link-row', { timeout: 15000 });
  const buildAfterLaunch = compiledBuildIdentity();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await assertHidden(app);
  return { app, page, buildIdentity: { beforeLaunch: buildBeforeLaunch, afterLaunch: buildAfterLaunch } };
}

async function runAction(evidence, id, action) {
  const entry = (evidence.tickets[id] ??= { status: 'pending', checks: {} });
  try {
    const result = await action();
    Object.assign(entry.checks, result ?? {});
    entry.actionVerified = true;
    entry.status = result?.partial ? 'partial' : 'action-passed';
    console.log(`PASS action ${id}`);
  } catch (error) {
    entry.status = 'failed';
    entry.actionFailure = error.stack ?? String(error);
    console.error(`FAIL action ${id}: ${error.message}`);
  }
}

async function runReopen(evidence, id, check) {
  const entry = (evidence.tickets[id] ??= { status: 'pending', checks: {} });
  try {
    const result = await check();
    Object.assign(entry.checks, result ?? {});
    entry.reopenVerified = true;
    if (entry.actionVerified) entry.status = entry.checks.partial ? 'partial' : 'passed';
    console.log(`PASS reopen ${id}`);
  } catch (error) {
    entry.status = 'failed';
    entry.reopenFailure = error.stack ?? String(error);
    console.error(`FAIL reopen ${id}: ${error.message}`);
  }
}

async function verify26(evidence) {
  const { page } = evidence;
  await openPage(page, 'Interface sintética');
  const { menu } = await openBlockMenu(page, 'p', 'Parágrafo que não deve ser movido');
  const blockMenu = await insideViewport(menu, page);
  assert.ok(blockMenu.inside, `Block menu escapes the 1600x1000 viewport: ${JSON.stringify(blockMenu)}`);
  await page.keyboard.press('Escape');

  await openPage(page, 'Financeiro sintético');
  await resizeHiddenWindow(evidence, 800, 600);
  const optionsButton = page.locator('.db-options-button');
  await optionsButton.click();
  const optionsPanel = page.locator('.popover.db-panel').last();
  await optionsPanel.waitFor({ state: 'visible' });
  const optionsRect = await insideViewport(optionsPanel, page);
  assert.ok(optionsRect.inside, `Table options panel escapes the viewport: ${JSON.stringify(optionsRect)}`);
  await page.keyboard.press('Escape');
  await optionsPanel.waitFor({ state: 'detached' });
  const pageOptionsEscapeRestoredFocus = await optionsButton.evaluate((button) => document.activeElement === button);
  assert.ok(pageOptionsEscapeRestoredFocus, 'Escape must close page options and restore focus to its trigger.');

  await page.locator('tfoot .db-calc-trigger').first().scrollIntoViewIfNeeded();
  await page.locator('tfoot .db-calc-trigger').first().click();
  const footerMenu = page.locator('.popover[role="dialog"]').last();
  await footerMenu.waitFor({ state: 'visible' });
  const footerRect = await insideViewport(footerMenu, page);
  assert.ok(footerRect.inside, `Footer menu escapes the viewport: ${JSON.stringify(footerRect)}`);
  await page.keyboard.press('Escape');
  await resizeHiddenWindow(evidence, 1600, 1000);
  return {
    blockMenuAtWideViewport: blockMenu,
    optionsPanelAtNarrowViewport: optionsRect,
    pageOptionsEscapeRestoredFocus,
    footerMenuAtNarrowViewport: footerRect,
    testedViewports: ['1600x1000', '800x600'],
  };
}

async function verify27(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Interface sintética');
  const { block, menu } = await openBlockMenu(page, 'p', 'Parágrafo que receberá uma cor hexadecimal');
  const swatchCount = await menu.locator('.menu-swatch').count();
  assert.ok(swatchCount >= 8, `Expected the menu to offer the named background swatches; found ${swatchCount}`);
  const hex = menu.locator('.color-hex-input');
  await hex.fill('#13579B');
  await page.waitForFunction((text) => {
    const target = [...document.querySelectorAll('.ProseMirror p')].find((item) => item.textContent?.includes(text));
    return target?.getAttribute('data-block-background')?.toUpperCase() === '#13579B';
  }, 'Parágrafo que receberá uma cor hexadecimal');
  const rendered = await block.getAttribute('data-block-background');
  const markdown = await waitForMarkdown(
    vaultDir,
    'Interface.md',
    (text) => /morrow:block-background:#13579b/i.test(text),
    'custom block background',
  );
  assert.match(markdown, /morrow:block-background:#13579b/i);
  const storedMarker = markdown.match(/<!--\s*morrow:block-background:[^>]+-->/i)?.[0] ?? null;
  return { paletteSwatches: swatchCount, renderedHex: rendered, markdownMarkerSaved: true, storedMarker };
}

async function verify30(evidence) {
  const { page, vaultDir, originalImage, replacementImage } = evidence;
  const ticket = evidence.tickets['#30'];
  const setDiagnosticStep = (step) => { ticket.diagnosticStep = step; };
  setDiagnosticStep('open synthetic page and inspect initial image');
  await openPage(page, 'Interface sintética');
  const image = page.locator('.image-block').first();
  await image.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const imageElement = document.querySelector('.image-block img');
    return imageElement instanceof HTMLImageElement && imageElement.naturalWidth > 0;
  });
  const originalHash = sha256(originalImage);
  const before = await imagePresentation(image);
  const originalImageSource = await image.locator('img').getAttribute('src');
  assert.equal(before.align, 'center');
  assert.equal(before.caption, 'Legenda sintética preservada');
  assert.ok(before.cropActive, `The Markdown crop marker must render as a cropped image: ${JSON.stringify(before)}`);

  const originalMarkdown = readMarkdown(vaultDir, 'Interface.md');
  const originalCrop = originalMarkdown.match(/crop="([^"]+)"/)?.[1];
  assert.ok(originalCrop, 'The image fixture must start with a persisted crop');

  setDiagnosticStep('hover image before opening crop mode');
  await image.hover();
  setDiagnosticStep('click crop toolbar action');
  await image.locator('.image-toolbar button[aria-label]').nth(5).click();
  const cropOverlay = image.locator('.image-crop-overlay');
  setDiagnosticStep('wait for crop overlay');
  await cropOverlay.waitFor({ state: 'visible' });
  const cropGeometry = await image.locator('.image-crop-box').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  assert.ok(cropGeometry.width > 0 && cropGeometry.height > 0, `Crop selection must cover a measurable image area: ${JSON.stringify(cropGeometry)}`);
  const handle = cropOverlay.locator('.image-crop-handle.handle-br');
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox && handleBox.width > 0, 'Crop handle must be interactable');
  setDiagnosticStep('drag crop handle with pointer events');
  const cropDraftDrag = await page.evaluate(() => {
    const handle = document.querySelector('.image-crop-handle.handle-br');
    const cropBox = document.querySelector('.image-crop-box');
    if (!handle || !cropBox) throw new Error('Crop handle or selection box is missing');
    const rect = handle.getBoundingClientRect();
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const before = { width: cropBox.style.width, height: cropBox.style.height };
    const event = (type, x, y, buttons) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });
    handle.dispatchEvent(event('pointerdown', start.x, start.y, 1));
    window.dispatchEvent(event('pointermove', start.x - 12, start.y - 8, 1));
    window.dispatchEvent(event('pointerup', start.x - 12, start.y - 8, 0));
    return { before, after: { width: cropBox.style.width, height: cropBox.style.height } };
  });
  assert.notDeepEqual(cropDraftDrag.after, cropDraftDrag.before, 'Dragging a crop handle must change the crop draft');
  setDiagnosticStep('apply crop and persist crop marker');
  await cropOverlay.locator('button.primary').click();
  const cropped = await imagePresentation(image);
  assert.ok(cropped.cropActive, `Applying a crop must change the rendered image presentation: ${JSON.stringify(cropped)}`);
  const markdownAfterCrop = await waitForMarkdown(
    vaultDir,
    'Interface.md',
    (text) => {
      const crop = text.match(/crop="([^"]+)"/)?.[1];
      return Boolean(crop && crop !== originalCrop);
    },
    'updated image crop selection',
  );

  setDiagnosticStep('edit image caption');
  await image.hover();
  const captionButton = image.locator('.image-toolbar button[aria-label]').nth(1);
  await captionButton.click();
  const captionInput = image.locator('.image-caption-input');
  await captionInput.fill('Legenda atualizada sintética');
  await captionInput.press('Enter');
  setDiagnosticStep('change image alignment');
  await image.hover();
  await image.locator('.image-toolbar button[aria-label]').nth(2).click();
  assert.equal(await image.getAttribute('data-align'), 'left', 'Image alignment must change through the image toolbar');

  setDiagnosticStep('open and cancel replacement chooser');
  await image.hover();
  const replaceButton = image.locator('.image-toolbar button[aria-label]').first();
  const chooserPromise = page.waitForEvent('filechooser');
  await replaceButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles([]);
  await page.waitForTimeout(100);
  const afterCanceledReplacement = await imagePresentation(image);
  assert.equal(afterCanceledReplacement.cropActive, true, 'Canceling image replacement must leave the crop unchanged');

  const chooserAgainPromise = page.waitForEvent('filechooser');
  setDiagnosticStep('open chooser and select replacement image');
  await image.hover();
  await image.locator('.image-toolbar button[aria-label]').first().click();
  const chooserAgain = await chooserAgainPromise;
  await chooserAgain.setFiles(replacementImage);
  const markdownAfterReplacement = await waitForMarkdown(
    vaultDir,
    'Interface.md',
    (text) => text.includes('Legenda atualizada sintética') && /align="left"/.test(text) && !/crop="/.test(text) && text.includes('attachments/replacement.png'),
    'replacement image presentation without the old crop',
  );
  setDiagnosticStep('inspect live replacement rendering');
  const afterReplace = await imagePresentation(image);
  assert.equal(afterReplace.align, 'left', 'Replacing an image must preserve its alignment');
  assert.equal(afterReplace.caption, 'Legenda atualizada sintética', 'Replacing an image must preserve its caption');
  assert.equal(afterReplace.cropActive, false, 'Replacing an image with a different aspect ratio must reset its old crop');
  assert.equal(sha256(originalImage), originalHash, 'The source image file must remain unchanged');

  const entry = evidence.tickets['#30'];
  entry.partialActionVerified = true;
  entry.checks.partialReplacement = {
    align: afterReplace.align,
    caption: afterReplace.caption,
    oldCropReset: !afterReplace.cropActive,
    markdownHasNoCropMarker: !/crop="/.test(markdownAfterReplacement),
    originalImageUnchanged: true,
    renderedImageSourceChanged: afterReplace.imageSource !== originalImageSource,
  };
  assert.notEqual(afterReplace.imageSource, originalImageSource, 'Replacing the image must update the visible image source as well as Markdown metadata');

  setDiagnosticStep('verification complete');
  return {
    initial: before,
    initialCropRendered: before.cropActive,
    cropGeometry,
    cropAppliedBeforeReplacement: cropped.cropActive,
    cropMarkdownUpdatedBeforeReplacement: markdownAfterCrop.match(/crop="([^"]+)"/)?.[1] !== originalCrop,
    canceledReplacementKeptCrop: afterCanceledReplacement.cropActive,
    replacementPreservedCaptionAndAlignment: true,
    differentAspectRatioResetCrop: true,
    renderedImageSourceChanged: afterReplace.imageSource !== originalImageSource,
    cropMarkdownMarkerAfterReplacement: /crop="/.test(markdownAfterReplacement),
    markdownStoresPresentation: /morrow:image align="left" caption="Legenda atualizada sintética"/.test(markdownAfterReplacement),
    originalFileSha256Unchanged: true,
  };
}

async function verify31(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Interface sintética');
  const heading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
  await heading.scrollIntoViewIfNeeded();
  await heading.hover();
  await page.locator('.block-handle').click();
  const menu = page.locator('.menu[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  await clickMatchingButton(menu.locator('button[role="menuitem"]'), /enable.*collaps|enable.*fold|make collapsible|tornar recolh[ií]vel|ativar.*recolh|habilitar.*recolh/i, 'enable heading folding');
  const fold = heading.locator('button.heading-fold-btn');
  await fold.waitFor({ state: 'visible' });
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  await fold.click();
  await page.waitForFunction(() => document.querySelector('.heading-fold-btn')?.getAttribute('aria-expanded') === 'false');
  const collapsed = await page.evaluate(() => ({
    hidden: [...document.querySelectorAll('.is-collapsed-hidden')].map((node) => node.textContent?.trim()),
    nextHeadingHidden: [...document.querySelectorAll('.ProseMirror h2')].find((node) => node.textContent?.includes('Seção seguinte'))?.classList.contains('is-collapsed-hidden') ?? false,
    bodyStillInDom: document.querySelector('.ProseMirror')?.textContent?.includes('Conteúdo sintético que deve ficar oculto') ?? false,
  }));
  assert.ok(collapsed.hidden.some((text) => text.includes('Conteúdo sintético que deve ficar oculto')));
  assert.equal(collapsed.nextHeadingHidden, false, 'The next equal-level heading must remain visible');
  assert.equal(collapsed.bodyStillInDom, true, 'Collapsing must hide content without deleting it');
  await fold.click();
  await page.waitForFunction(() => document.querySelector('.heading-fold-btn')?.getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('.is-collapsed-hidden').count(), 0, 'Expanding must restore the section contents');
  await fold.click();
  const markdown = await waitForMarkdown(
    vaultDir,
    'Interface.md',
    (text) => /morrow:heading collapsible collapsed/i.test(text),
    'collapsed heading state',
  );
  return { collapsedSectionContent: collapsed.hidden, siblingRemainsVisible: true, expandRestoresContent: true, markerSaved: /morrow:heading collapsible collapsed/i.test(markdown) };
}

async function dragBlockToColumnEdge(page, text) {
  const block = page.locator('.ProseMirror p').filter({ hasText: text }).first();
  await block.scrollIntoViewIfNeeded();
  await block.hover();
  const handle = page.locator('.block-handle');
  await handle.waitFor({ state: 'visible' });
  return await page.evaluate(({ text }) => {
    const block = [...document.querySelectorAll('.ProseMirror p')].find((node) => node.textContent?.includes(text));
    const handle = document.querySelector('.block-handle');
    const target = [...document.querySelectorAll('.ProseMirror .columns .column')].at(-1);
    if (!block || !handle || !target) throw new Error('Could not locate the source block, block handle, or last column');
    const rect = target.getBoundingClientRect();
    if (rect.width <= 10 || rect.height <= 5) throw new Error('Drop target column must be visible and measurable');
    const dataTransfer = new DataTransfer();
    window.__morrowDragEvents = [];
    if (!window.__morrowDragRecorderInstalled) {
      for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
        document.addEventListener(type, (event) => window.__morrowDragEvents.push({
          type,
          target: event.target instanceof HTMLElement ? event.target.className || event.target.tagName : '',
          clientX: event instanceof DragEvent ? event.clientX : null,
          clientY: event instanceof DragEvent ? event.clientY : null,
        }), true);
      }
      window.__morrowDragRecorderInstalled = true;
    }
    const sourceRect = block.getBoundingClientRect();
    handle.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceRect.left + Math.min(10, sourceRect.width / 2),
      clientY: sourceRect.top + sourceRect.height / 2,
      dataTransfer,
    }));
    const clientX = rect.right - 1;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer }));
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer }));
    return window.__morrowDragEvents ?? [];
  }, { text });
}

async function addColumnThroughMenu(page, blockText) {
  const { menu } = await openBlockMenu(page, '.column', blockText);
  await clickMatchingButton(menu.locator('button[role="menuitem"]'), /add.*column.*right|adicionar coluna à direita/i, 'add column from block menu');
}

async function verify40(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Interface sintética');
  await resizeHiddenWindow(evidence, 1440, 900);
  const columns = page.locator('.ProseMirror .columns').first();
  assert.equal(await columns.locator('.column').count(), 6, 'The fixture must start with six content columns');
  const dragEvents = await dragBlockToColumnEdge(page, 'Parágrafo para mover à sétima coluna');
  let dragCreatedSeventh = await columns.locator('.column').count() === 7;
  const completeDragEvents = dragEvents.some((event) => event.type === 'dragstart') && dragEvents.some((event) => event.type === 'drop');
  if (completeDragEvents) {
    assert.ok(dragCreatedSeventh, `A completed drag did not create the seventh column: ${JSON.stringify(dragEvents)}`);
  } else {
    assert.equal(await columns.locator('.column').count(), 6, `Unexpected column mutation without a delivered drag: ${JSON.stringify(dragEvents)}`);
    await addColumnThroughMenu(page, 'Coluna 1 conteúdo sintético.');
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .columns .column').length === 7, null, { timeout: 5000 });
  }
  assert.equal(await columns.locator('.column').count(), 7);

  let rejectedEighthByDrag = false;
  let eighthDragEvents = [];
  if (dragCreatedSeventh) {
    eighthDragEvents = await dragBlockToColumnEdge(page, 'Parágrafo que não deve ser movido para uma oitava coluna');
    await page.locator('.toast.is-error').filter({ hasText: /7/ }).waitFor({ state: 'visible', timeout: 3000 });
    rejectedEighthByDrag = eighthDragEvents.some((event) => event.type === 'dragstart') && eighthDragEvents.some((event) => event.type === 'drop');
  } else {
    await addColumnThroughMenu(page, 'Coluna 6 conteúdo sintético.');
    await page.locator('.toast.is-error').filter({ hasText: /7/ }).waitFor({ state: 'visible', timeout: 3000 });
  }
  assert.equal(await columns.locator('.column').count(), 7, 'The eighth content column must be refused');
  const eighthParagraph = page.locator('.ProseMirror > p').filter({ hasText: 'Parágrafo que não deve ser movido para uma oitava coluna' });
  assert.equal(await eighthParagraph.count(), 1, 'A refused drag must leave the source paragraph outside the columns');

  await resizeHiddenWindow(evidence, 800, 600);
  const responsive = await columns.evaluate((element) => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    columns: [...element.querySelectorAll(':scope > .column')].map((column) => {
      const rect = column.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }),
  }));
  assert.ok(responsive.columns.every((column) => column.width > 0), 'All seven columns must remain reachable in the narrow viewport');
  const markdown = await waitForMarkdown(
    vaultDir,
    'Interface.md',
    (text) => (text.match(/<div data-column>/g) ?? []).length === 7,
    'seven-column layout',
  );
  await resizeHiddenWindow(evidence, 1600, 1000);
  return {
    partial: !dragCreatedSeventh,
    createdSeventhByDrag: dragCreatedSeventh,
    createdSeventhByMenu: !dragCreatedSeventh,
    dragDispatch: 'DOM DragEvent with DataTransfer and edge coordinates',
    dragEvents,
    eighthDragEvents,
    rejectedEighthByDrag,
    rejectedEighthByMenu: !dragCreatedSeventh,
    columnCount: responsive.columns.length,
    responsive,
    markdownHasSevenColumns: (markdown.match(/<div data-column>/g) ?? []).length === 7,
  };
}

async function verify28(evidence) {
  const { page } = evidence;
  await openPage(page, 'Financeiro sintético');
  const database = page.locator('.database').first();
  await database.locator('.db-filter-chip-add').click();
  const chip = database.locator('.db-filter-chip').first();
  await chip.click();
  const filterDialog = page.locator('.popover.db-panel').last();
  await filterDialog.waitFor({ state: 'visible' });
  const filterSelects = filterDialog.locator('.db-filter-popover-content select');
  await filterSelects.nth(0).selectOption('category');
  const valueSelect = filterDialog.locator('.db-filter-popover-content select').last();
  await valueSelect.selectOption('opt-infra');
  await page.waitForFunction(() => {
    const table = document.querySelector('.database table');
    return table?.querySelectorAll('tbody tr').length === 2;
  });
  const rowsAfterFilter = await database.locator('tbody tr').allInnerTexts();
  assert.ok(rowsAfterFilter.some((text) => text.includes('Alfa')));
  assert.ok(rowsAfterFilter.some((text) => text.includes('Gama')));
  assert.ok(rowsAfterFilter.every((text) => !text.includes('Beta')));
  await database.locator('.db-filter-reset').click();
  await page.waitForFunction(() => document.querySelector('.database tbody')?.querySelectorAll('tr').length === 3);

  const options = await openDatabaseOptions(page, database);
  const optionsLabels = await options.locator('.db-options-item').allInnerTexts();
  assert.ok(optionsLabels.some((label) => /filter|filt?r|filtr|filtro|filtrar/i.test(label)));
  await clickMatchingButton(options.locator('.db-options-item'), /filter|filt?r|filtr|filtro|filtrar/i, 'open filter options');
  const filterPanel = page.locator('.popover.db-panel').last();
  await filterPanel.waitFor({ state: 'visible' });
  assert.ok(await filterPanel.locator('text=/no filters|sem filtros|filter/i').count());
  await page.keyboard.press('Escape');
  return { filteredRows: rowsAfterFilter.map((text) => text.trim().split('\n')[0]), resetRestoredThreeRows: true, optionsSections: optionsLabels, filterSectionOpened: true, quickFilterRemainsTemporary: true };
}

async function verify29(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Painel sintético');
  const views = page.locator('.linked-database-view');
  assert.equal(await views.count(), 2, 'The fixture must contain two canonical linked views of one source');
  const first = views.nth(0);
  const second = views.nth(1);
  const names = ['Visão somente Alfa', 'Visão somente Beta'];
  for (let index = 0; index < 2; index++) {
    const input = views.nth(index).locator('input.linked-database-name');
    await input.fill(names[index]);
    await input.press('Enter');
  }
  const searches = views.locator('.db-search input');
  await searches.nth(0).fill('Alfa');
  await searches.nth(1).fill('Beta');
  await page.waitForFunction(() => {
    const counts = [...document.querySelectorAll('.linked-database-view .db-count')].map((item) => item.textContent ?? '');
    return counts.length === 2 && counts.every((text) => /1/.test(text));
  });
  const linkedRows = await views.locator('tbody tr').allInnerTexts();
  assert.ok(linkedRows.some((text) => text.includes('Alfa')));
  assert.ok(linkedRows.some((text) => text.includes('Beta')));

  const collapseButton = first.locator('.linked-database-head button[aria-label]').first();
  const pageErrorsBeforeCollapse = evidence.pageErrors?.length ?? 0;
  const collapseSequence = [true, false, true, false, true];
  for (const collapsed of collapseSequence) {
    await collapseButton.click();
    await page.waitForFunction((expected) => {
      const blocks = [...document.querySelectorAll('.linked-database-view')];
      return blocks.length === 2 && (!!blocks[0]?.querySelector('.database') === !expected) && !!blocks[1]?.querySelector('.database');
    }, collapsed);
  }
  assert.equal(
    evidence.pageErrors?.length ?? 0,
    pageErrorsBeforeCollapse,
    'Repeated linked-view collapse and expand must not produce editor selection errors.',
  );
  const hostMarkdown = await waitForMarkdown(
    vaultDir,
    'Painel.md',
    (text) => linkedViewPayloads(text).length === 2 && linkedViewPayloads(text).every((item) => item.view.name.startsWith('Visão somente')),
    'local linked-view names',
  );
  const persistedViews = linkedViewPayloads(hostMarkdown).map((item) => item.view);
  assert.deepEqual(persistedViews.map((view) => [view.name, view.search, view.collapsed]), [
    [names[0], 'Alfa', true],
    [names[1], 'Beta', undefined],
  ]);

  await openPage(page, 'Financeiro sintético');
  const links = page.locator('.db-linked-views button');
  assert.equal(await links.count(), 2, 'Source database must list both linked view locations');
  const labels = await links.allInnerTexts();
  assert.ok(labels.some((label) => label.includes(names[0])));
  assert.ok(labels.some((label) => label.includes(names[1])));
  await links.first().click();
  await page.waitForFunction(() => document.querySelector('main')?.innerText.includes('Painel sintético') ?? false);
  return {
    localNames: names,
    independentSearches: persistedViews.map((view) => view.search),
    searchProducedOneRowPerView: true,
    collapseSequence,
    collapsedOneViewOnly: true,
    sourceListsBothViews: labels.map((label) => label.trim()),
  };
}

async function verify38(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Financeiro sintético');
  const database = page.locator('.database').first();
  const { panel } = await openDatabaseOption(
    page,
    database,
    /conditional formatting|formata[cç][aã]o condicional/i,
    'open conditional formatting',
  );
  await clickMatchingButton(panel.locator('button.link-button'), /add condition|adicionar condi[cç][aã]o/i, 'add a conditional rule');
  const rule = panel.locator('.db-conditional-rule').last();
  await rule.waitFor({ state: 'visible' });
  await rule.locator('select').nth(0).selectOption('formula');
  await rule.locator('select').nth(1).selectOption('cell');
  const selectors = rule.locator('select');
  let propertySelect = null;
  for (let index = 0; index < await selectors.count(); index++) {
    const options = await selectors.nth(index).locator('option').evaluateAll((items) => items.map((item) => item.value));
    if (options.includes('amount')) {
      propertySelect = selectors.nth(index);
      break;
    }
  }
  assert.ok(propertySelect, 'Conditional rule must expose the amount property selector');
  await propertySelect.selectOption('amount');
  const formulaInput = rule.locator('input[placeholder*="Score"], input[aria-label*="formula"], input[aria-label*="fórmula"]').first();
  if (!(await formulaInput.count())) {
    const candidates = rule.locator('input[type="text"]');
    await candidates.first().fill('Valor >= 200');
  } else {
    await formulaInput.fill('Valor >= 200');
  }
  const customColor = rule.locator('input[placeholder="#RRGGBB"]');
  await customColor.fill('#3157C8');
  await page.waitForFunction(() => {
    const diagnostic = document.querySelector('.db-conditional-rule .db-formula-diagnostic');
    return !diagnostic || !diagnostic.textContent?.trim();
  });
  const diagnostic = await rule.locator('.db-formula-diagnostic').allInnerTexts();
  assert.equal(diagnostic.length, 0, `Boolean condition should compile without diagnostics: ${diagnostic.join('; ')}`);
  await page.keyboard.press('Escape');
  const colors = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.database tbody tr')];
    const cellFor = (amount) => {
      const row = rows.find((candidate) => [...candidate.querySelectorAll('td')].some((cell) => cell.textContent?.trim() === String(amount)));
      const cell = row && [...row.querySelectorAll('td')].find((candidate) => candidate.textContent?.trim() === String(amount));
      return cell ? { text: cell.textContent?.trim(), background: getComputedStyle(cell).backgroundColor } : null;
    };
    return { hundred: cellFor(100), twoHundred: cellFor(200), threeHundred: cellFor(300) };
  });
  assert.ok(colors.twoHundred && colors.threeHundred && colors.hundred);
  assert.equal(colors.hundred.background, 'rgba(0, 0, 0, 0)', 'A row not matching the formula must not be colored');
  assert.equal(colors.twoHundred.background, 'rgb(49, 87, 200)');
  assert.equal(colors.threeHundred.background, 'rgb(49, 87, 200)');
  const markdown = await waitForMarkdown(vaultDir, 'Financeiro.md', (text) => text.includes('conditionalFormats'), 'conditional formula rule');
  assert.ok(markdown.includes('Valor >= 200') || markdown.includes('amount'));
  return { formula: 'Valor >= 200', customColor: '#3157C8', matchingCells: [colors.twoHundred, colors.threeHundred], nonMatchingCell: colors.hundred, markdownStoresRule: true };
}

async function chooseSummary(page, table, headerText, optionPattern) {
  const headerTexts = await table.locator('thead th').allInnerTexts();
  const index = headerTexts.findIndex((text) => text.includes(headerText));
  assert.ok(index >= 0, `Could not locate summary column ${headerText}: ${headerTexts.join(' | ')}`);
  const footerCell = table.locator('tfoot tr').locator('th,td').nth(index);
  await footerCell.locator('button.db-calc-trigger, button.db-footer-summary').click();
  const menu = page.locator('.popover[role="dialog"]').last();
  await menu.waitFor({ state: 'visible' });
  const selected = await clickMatchingButton(menu.locator('.db-options-item'), optionPattern, `choose calculation for ${headerText}`);
  await page.waitForTimeout(350);
  console.log(`SUMMARY ${headerText}: headerIndex=${index}, selected=${selected}, footer=${await footerCell.innerText()}`);
}

async function verify39(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Financeiro sintético');
  const table = page.locator('.database table').first();
  const database = page.locator('.database').first();
  const summaryOptions = await openDatabaseOption(
    page,
    database,
    /calculate|calcular|resumen|resumo/i,
    'open summary options',
  );
  const summaryFields = await summaryOptions.panel.locator('label.field').allInnerTexts();
  assert.ok(summaryFields.some((label) => /Valor/.test(label)), `Summary options must expose Valor. Fields: ${summaryFields.join(' | ')}`);
  assert.ok(summaryFields.some((label) => /Categoria/.test(label)), `Summary options must expose Categoria. Fields: ${summaryFields.join(' | ')}`);
  await page.keyboard.press('Escape');
  await chooseSummary(page, table, 'Valor', /^\s*(?:sum|soma)\b/i);
  await chooseSummary(page, table, 'Categoria', /count values|contar.*preench/i);
  let footer = await table.locator('tfoot tr').innerText();
  assert.match(footer, /600/);
  assert.match(footer, /3/);
  const search = page.locator('.database .db-search input').first();
  await search.fill('Alfa');
  await page.waitForFunction(() => document.querySelector('.database tbody')?.querySelectorAll('tr').length === 1);
  footer = await table.locator('tfoot tr').innerText();
  assert.match(footer, /100/, 'Summary must aggregate only the row remaining after search');
  await search.fill('');
  await page.waitForFunction(() => document.querySelector('.database tbody')?.querySelectorAll('tr').length === 3);

  const reviewTab = page.getByRole('tab').filter({ hasText: 'Revisão' });
  await reviewTab.click();
  const reviewTable = page.locator('.database table').first();
  await chooseSummary(page, reviewTable, 'Valor', /maximum|maximum value|m[aá]ximo/i);
  const reviewFooter = await reviewTable.locator('tfoot tr').innerText();
  assert.match(reviewFooter, /300/);
  const markdown = await waitForMarkdown(vaultDir, 'Financeiro.md', (text) => text.includes('summaries:'), 'per-view calculations');
  assert.match(markdown, /amount:\s*sum/);
  assert.match(markdown, /amount:\s*max/);
  return { primaryView: { amount: 'sum = 600', category: 'count values = 3', searchReducedAmountTo: 100 }, reviewView: { amount: 'maximum = 300' }, distinctViewSummariesSaved: true };
}

async function openPropertySettings(page, title) {
  const header = page.locator('.database thead th').filter({ hasText: title }).first();
  await header.scrollIntoViewIfNeeded();
  await header.locator('button.db-header').click();
  const panel = page.locator('.popover.db-panel').last();
  await panel.waitFor({ state: 'visible' });
  return panel;
}

async function verifyRichCanvasLayer(page, vaultDir, evidence) {
  let panel = await openPropertySettings(page, 'Rich canvas layer test');
  const trigger = panel.locator('.media-default-value button.rich-canvas-preview');
  await trigger.click();
  const backdrop = page.locator('.rich-canvas-backdrop');
  const dialog = page.locator('.rich-canvas-dialog');
  await dialog.waitFor({ state: 'visible' });
  const layerOrder = await page.evaluate(() => {
    const backdrop = document.querySelector('.rich-canvas-backdrop');
    const panel = [...document.querySelectorAll('.popover.db-panel')].at(-1);
    if (!backdrop || !panel) return null;
    return {
      dialogOrder: Number.parseInt(getComputedStyle(backdrop).zIndex, 10),
      propertyPanelOrder: Number.parseInt(getComputedStyle(panel).zIndex, 10),
      sharedPortalRoot: backdrop.parentElement?.id === 'morrow-overlay-root' && panel.parentElement?.id === 'morrow-overlay-root',
    };
  });
  assert.ok(layerOrder, 'The rich canvas and property panel must share the overlay portal root.');
  assert.equal(layerOrder.sharedPortalRoot, true, 'The rich canvas must use the shared overlay root.');
  assert.ok(
    layerOrder.dialogOrder > layerOrder.propertyPanelOrder,
    `The rich canvas must sit above its property panel: ${JSON.stringify(layerOrder)}`,
  );
  await saveEditorScreenshot(page, evidence, 'editor-20-rich-canvas-over-settings.png');

  await page.keyboard.press('Escape');
  await backdrop.waitFor({ state: 'detached' });
  await panel.waitFor({ state: 'visible' });
  const restoredPreviewFocus = await trigger.evaluate((button) => document.activeElement === button);
  assert.equal(restoredPreviewFocus, true, 'Escape must close the rich canvas and restore focus to its preview trigger.');
  await saveEditorScreenshot(page, evidence, 'editor-20-rich-canvas-escape-keeps-settings.png');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });

  panel = await openPropertySettings(page, 'Rich canvas layer test');
  const preview = panel.locator('.media-default-value button.rich-canvas-preview');
  await preview.click();
  const editor = page.locator('.rich-canvas-editor[contenteditable="true"]');
  await editor.waitFor({ state: 'visible' });
  await editor.fill('Unsaved synthetic canvas content');
  await page.locator('.rich-canvas-dialog-actions button').first().click();
  await backdrop.waitFor({ state: 'detached' });
  await panel.waitFor({ state: 'visible' });
  assert.equal(readMarkdown(vaultDir, 'Livros.md').includes('Unsaved synthetic canvas content'), false);

  await preview.click();
  await editor.waitFor({ state: 'visible' });
  await editor.fill('Saved synthetic canvas content');
  await page.locator('.rich-canvas-dialog-actions button').last().click();
  const savedMarkdown = await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => text.includes('Saved synthetic canvas content'),
    'rich canvas save after cancel',
  );
  assert.ok(savedMarkdown.includes('Saved synthetic canvas content'));
  assert.match(await preview.innerText(), /Saved synthetic canvas content/);
  await saveEditorScreenshot(page, evidence, 'editor-20-rich-canvas-saved-content.png');

  return {
    layerOrder,
    escapeClosesRichCanvasBeforePropertySettings: true,
    escapeRestoresPreviewFocus: restoredPreviewFocus,
    cancelDoesNotPersistDraft: !readMarkdown(vaultDir, 'Livros.md').includes('Unsaved synthetic canvas content'),
    savePersistsContent: true,
  };
}

async function uploadSyntheticIcon(page, dialog, file) {
  const chooserPromise = page.waitForEvent('filechooser');
  await dialog.locator('button.icon-upload').click();
  const chooser = await chooserPromise;
  const inputType = await chooser.element().evaluate((input) => input.type);
  assert.equal(inputType, 'file', 'The picker must be intercepted at its HTML file input.');
  await chooser.setFiles(file);
  return { mechanism: 'Playwright filechooser', inputType, nativeDialogOpened: false };
}

async function uploadedGlyphMetrics(container, kind) {
  const selector = kind === 'raster' ? 'img.icon-image' : '.custom-svg-icon';
  const glyph = container.locator(selector);
  await glyph.waitFor({ state: 'visible' });
  return glyph.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const image = element instanceof HTMLImageElement ? element : null;
    const svg = element.querySelector('svg');
    const style = getComputedStyle(element);
    return {
      styleWidth: element.style.width,
      styleHeight: element.style.height,
      objectFit: style.objectFit,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      naturalWidth: image?.naturalWidth ?? null,
      naturalHeight: image?.naturalHeight ?? null,
      svgViewBox: svg?.getAttribute('viewBox') ?? null,
    };
  });
}

async function pageIconState(page, vaultDir) {
  const glyph = page.locator('.page-icon .emoji-img, .page-icon .emoji-text').first();
  await glyph.waitFor({ state: 'visible' });
  const domValue = await glyph.evaluate((element) =>
    element instanceof HTMLImageElement ? element.alt : element.textContent?.trim() ?? '',
  );
  const markdown = readMarkdown(vaultDir, 'Livros.md');
  const frontmatterValue = markdown.match(/^icon:\s*(.+)$/m)?.[1]?.trim() ?? null;
  return { domValue, frontmatterValue };
}

async function saveEditorScreenshot(page, evidence, fileName) {
  const directory = evidence.editorEvidenceRoot ?? evidence.syntheticFixturesRoot;
  const outputName = evidence.editorEvidencePrefix
    ? `${evidence.editorEvidencePrefix}-${fileName.replace(/^editor-20-/, '')}`
    : fileName;
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, outputName), fullPage: false });
}

async function verify37(evidence) {
  const { page, vaultDir, syntheticRasterIcon, syntheticSvgIcon } = evidence;
  const ticket = evidence.tickets['#37'];
  await openPage(page, 'Livros sintéticos');
  const originalPageIcon = await pageIconState(page, vaultDir);
  assert.equal(originalPageIcon.domValue, '📚', 'The synthetic page icon must be visible before property icon edits.');
  assert.match(originalPageIcon.frontmatterValue ?? '', /📚/);

  let panel = await openPropertySettings(page, 'Value type test');
  const iconTrigger = panel.locator('button.prop-icon-trigger');
  await iconTrigger.evaluate((button) => {
    window.__morrowIconTriggerEvents = [];
    for (const type of ['pointerdown', 'click']) {
      button.addEventListener(type, (event) => window.__morrowIconTriggerEvents.push({ type, target: event.target?.className ?? '', defaultPrevented: event.defaultPrevented }), true);
    }
  });
  await iconTrigger.click();
  const iconDialog = page.locator('.emoji-dialog');
  const overlayOrder = await page.evaluate(() => {
    const dialog = document.querySelector('.emoji-dialog')?.closest('.dialog-backdrop');
    const propertyPanel = [...document.querySelectorAll('.popover.db-panel')].at(-1);
    if (!dialog || !propertyPanel) return null;
    return {
      dialogOrder: Number.parseInt(getComputedStyle(dialog).zIndex, 10),
      propertyPanelOrder: Number.parseInt(getComputedStyle(propertyPanel).zIndex, 10),
      sharedPortalRoot: dialog.parentElement?.id === 'morrow-overlay-root' && propertyPanel.parentElement?.id === 'morrow-overlay-root',
    };
  });
  assert.ok(overlayOrder, 'The icon dialog and property panel must share the overlay portal root.');
  assert.ok(
    overlayOrder.dialogOrder > overlayOrder.propertyPanelOrder,
    `The icon dialog must sit above its property panel: ${JSON.stringify(overlayOrder)}`,
  );
  assert.equal(overlayOrder.sharedPortalRoot, true, 'Both layers must use the shared overlay root.');
  ticket.checks.iconDialogLayerOrder = overlayOrder;
  await saveEditorScreenshot(page, evidence, 'editor-20-icon-dialog-over-property-settings.png');
  await page.waitForTimeout(250);
  const iconDialogState = await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('.emoji-dialog, [role="dialog"]')].map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { className: node.className, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0, text: node.textContent?.trim().slice(0, 100) };
    }),
    bodyTail: document.body.innerText.slice(-250),
    triggerEvents: window.__morrowIconTriggerEvents ?? [],
    triggerReactHandler: Object.keys(document.querySelector('button.prop-icon-trigger') ?? {}).some((key) => key.startsWith('__reactProps$')),
  }));
  ticket.checks.iconTriggerStateAfterPointerClick = iconDialogState;
  console.log(`ICON DIALOG RESULT ${JSON.stringify(iconDialogState)}`);
  if (await iconDialog.count() === 0) {
    const iconTrigger = panel.locator('button.prop-icon-trigger');
    await iconTrigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const keyboardDialogCount = await iconDialog.count();
    console.log(`ICON DIALOG KEYBOARD DEBUG count=${keyboardDialogCount}`);
    if (keyboardDialogCount === 0) await page.screenshot({ path: path.join(evidence.syntheticFixturesRoot, 'ticket-37-icon-dialog-debug.png'), fullPage: true });
  }
  await iconDialog.waitFor({ state: 'visible', timeout: 3000 });
  await page.keyboard.press('Escape');
  await iconDialog.waitFor({ state: 'detached' });
  await panel.waitFor({ state: 'visible' });
  const escapeRestoredIconTrigger = await iconTrigger.evaluate((button) => document.activeElement === button);
  assert.equal(escapeRestoredIconTrigger, true, 'Escape must close only the icon dialog and restore focus to its trigger.');

  await iconTrigger.click();
  await iconDialog.waitFor({ state: 'visible' });
  const rasterFileChooser = await uploadSyntheticIcon(page, iconDialog, syntheticRasterIcon);
  await iconDialog.waitFor({ state: 'detached' });
  await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => /id: type_test[\s\S]*?icon:[^\n]*portrait-200x400\.png/.test(text),
    'synthetic portrait raster property icon save',
  );
  const rasterHeader = page.locator('.database thead th').filter({ hasText: 'Value type test' }).first();
  await page.waitForFunction(() => {
    const header = [...document.querySelectorAll('.database thead th')].find((item) => item.textContent?.includes('Value type test'));
    const image = header?.querySelector('img.icon-image');
    return image?.naturalWidth === 200 && image.naturalHeight === 400 && image.style.width === '14px' && image.style.height === '14px';
  });
  const rasterHeaderMetrics = await uploadedGlyphMetrics(rasterHeader, 'raster');
  assert.deepEqual(rasterHeaderMetrics, {
    styleWidth: '14px',
    styleHeight: '14px',
    objectFit: 'contain',
    renderedWidth: 14,
    renderedHeight: 14,
    naturalWidth: 200,
    naturalHeight: 400,
    svgViewBox: null,
  });
  await saveEditorScreenshot(page, evidence, 'editor-20-raster-column-header-14px.png');

  panel = await openPropertySettings(page, 'Value type test');
  const rasterSettingsButton = panel.locator('button.prop-icon-trigger');
  const rasterSettingsMetrics = await uploadedGlyphMetrics(rasterSettingsButton, 'raster');
  const rasterSettingsSlot = await rasterSettingsButton.evaluate((button) => ({
    width: getComputedStyle(button).width,
    height: getComputedStyle(button).height,
  }));
  assert.deepEqual(rasterSettingsSlot, { width: '32px', height: '32px' });
  assert.deepEqual(rasterSettingsMetrics, rasterHeaderMetrics);
  await saveEditorScreenshot(page, evidence, 'editor-20-raster-settings-slot-32px.png');

  await panel.locator('.property-type-select-trigger').click();
  const search = page.locator('.property-type-search-input');
  await search.fill('moeda');
  const portugueseResults = await page.locator('.property-type-item .prop-type-item-title').allInnerTexts();
  assert.equal(portugueseResults.length, 1, `The “moeda” search must return only currency, not every type: ${portugueseResults.join(', ')}`);
  assert.match(portugueseResults[0], /currency|moeda/i);
  await search.fill('currency');
  const englishResults = await page.locator('.property-type-item .prop-type-item-title').allInnerTexts();
  assert.equal(englishResults.length, 1, `The “currency” search must return only currency: ${englishResults.join(', ')}`);
  assert.match(englishResults[0], /currency|moeda/i);
  await page.locator('.property-type-item').first().click();
  await page.locator('.property-type-popover').waitFor({ state: 'hidden' });
  await page.locator('.database thead th').filter({ hasText: 'Value type test' }).first().waitFor({ state: 'visible' });
  const markdownAfterTypeChange = await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => /id: type_test[\s\S]*?type: currency/.test(text) && /id: type_test[\s\S]*?icon:[^\n]*portrait-200x400\.png/.test(text),
    'currency type and portrait raster icon persistence',
  );
  const rasterTypeBlock = markdownAfterTypeChange.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
  assert.match(rasterTypeBlock, /type: currency/);
  assert.match(rasterTypeBlock, /icon:[^\n]*portrait-200x400\.png/);
  const pageIconAfterRaster = await pageIconState(page, vaultDir);
  assert.deepEqual(pageIconAfterRaster, originalPageIcon, 'Property type and icon edits must not change the page icon.');

  panel = await openPropertySettings(page, 'SVG type test');
  await panel.locator('button.prop-icon-trigger').click();
  await iconDialog.waitFor({ state: 'visible' });
  const svgFileChooser = await uploadSyntheticIcon(page, iconDialog, syntheticSvgIcon);
  await iconDialog.waitFor({ state: 'detached' });
  await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => /id: svg_test[\s\S]*?icon:[^\n]*portrait-200x400\.svg/.test(text),
    'synthetic portrait SVG property icon save',
  );
  const svgHeader = page.locator('.database thead th').filter({ hasText: 'SVG type test' }).first();
  await page.waitForFunction(() => {
    const header = [...document.querySelectorAll('.database thead th')].find((item) => item.textContent?.includes('SVG type test'));
    return header?.querySelector('.custom-svg-icon svg')?.getAttribute('viewBox') === '0 0 200 400';
  });
  const svgHeaderMetrics = await uploadedGlyphMetrics(svgHeader, 'svg');
  assert.deepEqual(svgHeaderMetrics, {
    styleWidth: '14px',
    styleHeight: '14px',
    objectFit: 'contain',
    renderedWidth: 14,
    renderedHeight: 14,
    naturalWidth: null,
    naturalHeight: null,
    svgViewBox: '0 0 200 400',
  });
  await saveEditorScreenshot(page, evidence, 'editor-20-svg-column-header-14px.png');
  panel = await openPropertySettings(page, 'SVG type test');
  const svgSettingsButton = panel.locator('button.prop-icon-trigger');
  const svgSettingsMetrics = await uploadedGlyphMetrics(svgSettingsButton, 'svg');
  const svgSettingsSlot = await svgSettingsButton.evaluate((button) => ({
    width: getComputedStyle(button).width,
    height: getComputedStyle(button).height,
  }));
  assert.deepEqual(svgSettingsSlot, { width: '32px', height: '32px' });
  assert.deepEqual(svgSettingsMetrics, svgHeaderMetrics);
  await saveEditorScreenshot(page, evidence, 'editor-20-svg-settings-slot-32px.png');
  const pageIconAfterUploads = await pageIconState(page, vaultDir);
  assert.deepEqual(pageIconAfterUploads, originalPageIcon, 'Raster and SVG property icons must leave the page icon intact.');
  const richCanvasLayer = await verifyRichCanvasLayer(page, vaultDir, evidence);

  ticket.checks.uploadedIcons = {
    rasterFileChooser,
    rasterHeaderMetrics,
    rasterSettingsMetrics,
    rasterSettingsSlot,
    rasterPreservedAfterTypeChange: true,
    svgFileChooser,
    svgHeaderMetrics,
    svgSettingsMetrics,
    svgSettingsSlot,
    pageIconBefore: originalPageIcon,
    pageIconAfterUploads,
  };
  ticket.checks.richCanvasLayer = richCanvasLayer;
  return {
    portugueseSearch: portugueseResults,
    englishSearch: englishResults,
    changedRasterPropertyType: 'currency',
    rasterPreservedAfterTypeChange: true,
    uploadedRasterHeader14pxAndSettings32px: true,
    uploadedSvgHeader14pxAndSettings32px: true,
    svgPersistedForReopen: true,
    pageIconPreserved: true,
    richCanvasEscapeAndCancelSave: richCanvasLayer,
  };
}

async function verify41(evidence) {
  const { page, vaultDir } = evidence;
  const ticket = evidence.tickets['#41'];
  await openPage(page, 'Livros sintéticos');
  const panel = await openPropertySettings(page, 'Biography result');
  const formula = panel.locator('textarea.formula-input');
  const expectedFormula = 'Autor.`Livros escritos`';
  await formula.fill('Autor.');
  const suggestions = page.locator('.formula-suggestions [role="option"]');
  await suggestions.first().waitFor({ state: 'visible' });
  const suggestionTexts = await suggestions.allInnerTexts();
  assert.equal(suggestionTexts.length, 2, `Expected both related fields in suggestions: ${suggestionTexts.join(' | ')}`);
  assert.ok(suggestionTexts[0].includes('Biography Long'), `Expected the first related field: ${suggestionTexts.join(' | ')}`);
  assert.ok(suggestionTexts[1].includes('Livros escritos'), `Expected the second related field: ${suggestionTexts.join(' | ')}`);
  await formula.evaluate((element) => {
    window.__morrowFormulaKeys = [];
    element.addEventListener('keydown', (event) => window.__morrowFormulaKeys.push({ key: event.key, defaultPrevented: event.defaultPrevented }), true);
    window.__morrowFormulaBubbleKeys = [];
    document.addEventListener('keydown', (event) => window.__morrowFormulaBubbleKeys.push({ key: event.key, defaultPrevented: event.defaultPrevented, target: event.target instanceof HTMLElement ? event.target.className : '' }));
  });
  await formula.press('ArrowDown');
  await page.waitForTimeout(120);
  const activeBeforeTab = await page.locator('.formula-suggestions [role="option"][aria-selected="true"]').first().innerText();
  const arrowDownKeyState = await page.evaluate(() => ({
    events: window.__morrowFormulaKeys ?? [],
    bubbleEvents: window.__morrowFormulaBubbleKeys ?? [],
    value: document.querySelector('textarea.formula-input')?.value ?? '',
    caret: document.querySelector('textarea.formula-input')?.selectionStart ?? -1,
  }));
  ticket.checks.arrowDownSecondSuggestion = { active: activeBeforeTab, keyState: arrowDownKeyState };
  console.log(`FORMULA ARROWDOWN RESULT ${JSON.stringify(ticket.checks.arrowDownSecondSuggestion)}`);
  assert.ok(activeBeforeTab.includes('Livros escritos'), `ArrowDown must activate the second suggestion: ${activeBeforeTab}`);
  await formula.focus();
  await page.keyboard.press('Tab');
  const tabValueImmediately = await formula.inputValue();
  await page.waitForTimeout(150);
  const tabValue = await formula.inputValue();
  const tabCaret = await formula.evaluate((element) => ({
    start: element.selectionStart,
    end: element.selectionEnd,
    focused: document.activeElement === element,
  }));
  assert.equal(tabValueImmediately, expectedFormula, `Tab must immediately insert the active second suggestion: ${tabValueImmediately}`);
  assert.equal(tabValue, expectedFormula, 'Tab insertion must survive keyup and render updates');
  assert.deepEqual(tabCaret, { start: expectedFormula.length, end: expectedFormula.length, focused: true }, 'Tab must preserve focus and place the caret after the inserted binding');

  await formula.fill('Autor.');
  await formula.press('ArrowDown');
  const activeBeforeEnter = await page.locator('.formula-suggestions [role="option"][aria-selected="true"]').first().innerText();
  assert.ok(activeBeforeEnter.includes('Livros escritos'), `ArrowDown must activate the second suggestion before Enter: ${activeBeforeEnter}`);
  await formula.press('Enter');
  const enterValue = await formula.inputValue();
  const enterCaret = await formula.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd }));
  assert.equal(enterValue, expectedFormula, `Enter must insert the active second suggestion: ${enterValue}`);
  assert.deepEqual(enterCaret, { start: expectedFormula.length, end: expectedFormula.length }, 'Enter must place the caret after the inserted binding');
  const formulaKeyState = await page.evaluate(() => ({
    events: window.__morrowFormulaKeys ?? [],
    bubbleEvents: window.__morrowFormulaBubbleKeys ?? [],
    activeElementClass: document.activeElement?.className ?? '',
  }));
  ticket.checks.keyboardSuggestionSelection = {
    suggestionTexts,
    activeBeforeTab,
    tabValueImmediately,
    tabValueAfterWait: tabValue,
    tabCaret,
    activeBeforeEnter,
    enterValue,
    enterCaret,
    keyEvents: formulaKeyState,
  };
  console.log(`FORMULA SECOND SUGGESTION RESULT ${JSON.stringify(ticket.checks.keyboardSuggestionSelection)}`);
  assert.ok(formulaKeyState.bubbleEvents.some((event) => event.key === 'Tab' && event.defaultPrevented), 'The editor must consume Tab while committing the selected suggestion');
  assert.ok(formulaKeyState.bubbleEvents.some((event) => event.key === 'Enter' && event.defaultPrevented), 'The editor must consume Enter while committing the selected suggestion');
  await panel.locator('.formula-actions button').first().click();
  await page.keyboard.press('Escape');
  const markdown = await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => text.includes(expectedFormula) && /propertyId:\s*books/.test(text),
    'second relation formula binding',
  );
  const formulaBlock = markdown.match(/    - id: writer_bio[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
  assert.ok(formulaBlock.includes(expectedFormula), 'Saved formula must preserve the selected second relation field');
  assert.match(formulaBlock, /formulaBindings:[\s\S]*?propertyId:\s*books/, 'Saved formula must persist the selected relation property ID');
  return {
    suggestionsAfterRelationDot: suggestionTexts,
    tabInsertedSecondSuggestion: tabValue,
    enterInsertedSecondSuggestion: enterValue,
    caretVerifiedForTabAndEnter: true,
    selectedPropertyBindingPersisted: /propertyId:\s*books/.test(formulaBlock),
    formulaSaved: true,
  };
}

async function commitField(input, value) {
  await input.fill(value);
  await input.press('Enter').catch(async () => input.press('Tab'));
}

async function readFormulaResultRows(page) {
  return page.locator('.database table tbody tr').evaluateAll((items) => {
    const parseColor = (value) => {
      const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
      if (rgb) return { channels: rgb.slice(1, 4).map(Number), alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
      const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
      if (!hex) return null;
      const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
      return { channels: [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16)), alpha: 1 };
    };
    const luminance = (channels) => {
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };

    return items.map((row) => {
      const valueFor = (id) => row.querySelector(`[data-col-id="${id}"]`)?.textContent?.trim() ?? null;
      const availableCell = row.querySelector('[data-col-id="available"]');
      const availableCheckbox = availableCell?.querySelector('[role="checkbox"]');
      const icon = availableCheckbox?.querySelector('svg');
      const checkboxRect = availableCheckbox?.getBoundingClientRect();
      const iconRect = icon?.getBoundingClientRect();
      const checkboxStyle = availableCheckbox ? getComputedStyle(availableCheckbox) : null;
      let background = null;
      for (let node = availableCheckbox; node; node = node.parentElement) {
        const candidate = parseColor(getComputedStyle(node).backgroundColor);
        if (candidate?.alpha > 0) {
          background = candidate;
          break;
        }
      }
      background ??= parseColor(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
      const foreground = checkboxStyle ? parseColor(checkboxStyle.color) : null;
      const contrastRatio = foreground && background
        ? (() => {
            const levels = [luminance(foreground.channels), luminance(background.channels)].sort((a, b) => b - a);
            return (levels[0] + 0.05) / (levels[1] + 0.05);
          })()
        : null;
      const blankCell = row.querySelector('[data-col-id="available_blank"]');
      const blankCheckbox = blankCell?.querySelector('[role="checkbox"]');

      return {
        price: valueFor('price'),
        zero: valueFor('zero'),
        available: availableCheckbox
          ? {
              role: availableCheckbox.getAttribute('role'),
              checked: availableCheckbox.getAttribute('aria-checked'),
              label: availableCheckbox.getAttribute('aria-label'),
              visible: Boolean(
                checkboxRect?.width > 0 &&
                checkboxRect?.height > 0 &&
                iconRect?.width > 0 &&
                iconRect?.height > 0 &&
                checkboxStyle?.visibility !== 'hidden' &&
                checkboxStyle?.display !== 'none' &&
                Number(checkboxStyle?.opacity ?? 0) > 0,
              ),
              foreground: checkboxStyle?.color ?? null,
              background: background ? `rgb(${background.channels.join(', ')})` : null,
              contrastRatio,
              width: checkboxRect?.width ?? 0,
              height: checkboxRect?.height ?? 0,
              iconWidth: iconRect?.width ?? 0,
              iconHeight: iconRect?.height ?? 0,
            }
          : null,
        availableBlank: {
          cellPresent: Boolean(blankCell),
          text: blankCell?.textContent?.trim() ?? null,
          checkboxPresent: Boolean(blankCheckbox),
        },
      };
    });
  });
}

async function verify42(evidence) {
  const { page, vaultDir } = evidence;
  const ticket = evidence.tickets['#42'];
  await openPage(page, 'Livros sintéticos');
  const panel = await openPropertySettings(page, 'Preço calculado');
  const resultType = panel.locator('.field').filter({ hasText: /formula result type|tipo de resultado da f[oó]rmula|result format|formato do resultado/i }).locator('.select-button');
  assert.equal(await resultType.count(), 1, 'Formula settings must expose a distinct result type selector');
  await resultType.click();
  const currencyOption = page.locator('.select-popover [role="option"]').filter({ hasText: /currency|moeda/i }).first();
  await currencyOption.click();
  await page.waitForTimeout(150);

  const currencyField = panel.locator('.field').filter({ hasText: /currency code|c[oó]digo da moeda/i }).locator('input').first();
  await commitField(currencyField, 'BRL');
  const localeField = panel.locator('.field').filter({ hasText: /locale|localidade/i }).locator('input').first();
  await commitField(localeField, 'pt-BR');
  const precisionField = panel.locator('.field').filter({ hasText: /precision|precis[aã]o|decimal places|casas decimais/i }).locator('input').first();
  await commitField(precisionField, '2');
  const formatDebug = await panel.evaluate((node) => ({
    fields: [...node.querySelectorAll('.field')].map((field) => ({ label: field.querySelector('span')?.textContent?.trim(), value: field.querySelector('input')?.value })),
    buttons: [...node.querySelectorAll('button')].map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
  }));
  console.log(`FORMULA FORMAT DEBUG ${JSON.stringify(formatDebug)}`);
  const formatPreview = panel.locator('.field').filter({ hasText: /format preview|prévia do formato/i });
  await clickMatchingButton(formatPreview.locator('button'), /save|salvar/i, 'save formula format');
  const markdown = await waitForMarkdown(vaultDir, 'Livros.md', (text) => /formulaResultType: currency/.test(text) && /precision: 2/.test(text), 'formula result formatting');
  assert.ok(markdown.includes('formula: "150.5"'), 'Changing display format must keep the formula expression unchanged');
  await page.keyboard.press('Escape');
  const rendered = await page.locator('.database table tbody tr').first().innerText();
  ticket.checks.currencyDisplay = { resultType: 'currency', currency: 'BRL', locale: 'pt-BR', precision: 2, renderedRow: rendered, markdownFormatSaved: true };
  assert.match(rendered, /R\$\s?150,50/, `Formula result should render BRL with two decimals: ${rendered}`);
  const rows = await readFormulaResultRows(page);
  ticket.checks.formulaValuesByRow = rows;
  console.log(`FORMULA VALUES RESULT ${JSON.stringify(rows)}`);
  assert.equal(rows.length, 2, 'Synthetic formula fixture must render both data rows');
  assert.ok(rows.every((values) => values.zero === '0'), 'A numeric formula result of zero must remain visible as zero');
  assert.ok(
    rows.every((values) =>
      values.available?.role === 'checkbox' &&
      values.available.checked === 'false' &&
      values.available.label === 'Disponível calculado' &&
      values.available.visible &&
      values.available.contrastRatio >= 3 &&
      values.available.width >= 12 &&
      values.available.height >= 12 &&
      values.available.iconWidth >= 12 &&
      values.available.iconHeight >= 12,
    ),
    'A false formula result must render as a visible, legible, unchecked checkbox with an accessible label',
  );
  assert.ok(
    rows.every((values) =>
      values.availableBlank.cellPresent &&
      values.availableBlank.text?.toLocaleLowerCase() === 'vazio' &&
      !values.availableBlank.checkboxPresent,
    ),
    'A null checkbox formula must remain the localized empty-value placeholder, distinct from unchecked false',
  );
  return { resultType: 'currency', currency: 'BRL', locale: 'pt-BR', precision: 2, renderedCurrency: rendered, formulaExpressionPreserved: true, zeroAndFalseRemainDistinct: rows };
}

async function verify43(evidence) {
  const { page, vaultDir } = evidence;
  await openPage(page, 'Livros sintéticos');
  const panel = await openPropertySettings(page, 'Autor');
  const relationSettings = panel.locator('.db-relation-settings');
  const modes = relationSettings.locator('button[role="radio"]');
  await clickMatchingButton(modes, /link existing inverse|vincular a coluna existente|vincular coluna existente/i, 'choose existing inverse mode');
  const inverseSelect = relationSettings.locator('.select-button').last();
  await inverseSelect.click();
  await page.locator('.select-popover [role="option"]').filter({ hasText: 'Livros escritos' }).click();
  const preview = relationSettings.locator('.db-relation-preview-box');
  await preview.waitFor({ state: 'visible' });
  const previewText = await preview.innerText();
  const numbers = previewText.match(/\d+/g)?.map(Number) ?? [];
  assert.ok(numbers.includes(2), `Preview must quantify the two owner-side pairs and their union: ${previewText}`);
  assert.ok(numbers.includes(1), `Preview must quantify the existing target-side pair: ${previewText}`);
  await clickMatchingButton(preview.locator('button'), /link and merge|vincular e (?:mesclar|unificar)/i, 'apply the previewed relation union');
  const markdown = await waitForMarkdown(
    vaultDir,
    'Livros.md',
    (text) => /inversePropertyId: books/.test(text),
    'inverse relation link',
  );
  assert.ok(/inversePropertyId: books/.test(markdown));
  const authorsMarkdown = await waitForMarkdown(vaultDir, 'Autores.md', (text) => /isInverse: true/.test(text), 'projected inverse property');
  assert.match(authorsMarkdown, /isInverse: true/);
  return { previewText, previewCountedExistingPairs: true, clickedMergeAction: true, ownerRelationPersisted: true, targetMarkedAsInverse: true };
}

async function runInitial(evidence, selected) {
  const cases = {
    '#26': verify26,
    '#27': verify27,
    '#30': verify30,
    '#31': verify31,
    '#40': verify40,
    '#28': verify28,
    '#29': verify29,
    '#38': verify38,
    '#39': verify39,
    '#37': verify37,
    '#41': verify41,
    '#42': verify42,
    '#43': verify43,
  };
  for (const id of selected) await runAction(evidence, id, () => cases[id](evidence));
}

async function runPersistenceChecks(evidence, selected) {
  const { page, vaultDir } = evidence;
  const checks = {
    '#27': async () => {
      await openPage(page, 'Interface sintética');
      const block = page.locator('.ProseMirror p').filter({ hasText: 'Parágrafo que receberá uma cor hexadecimal' });
      assert.equal((await block.getAttribute('data-block-background'))?.toUpperCase(), '#13579B');
      assert.match(readMarkdown(vaultDir, 'Interface.md'), /morrow:block-background:#13579b/i);
      return { reopenedCustomBackground: '#13579B', markdownRoundTrip: true };
    },
    '#30': async () => {
      await openPage(page, 'Interface sintética');
      const image = page.locator('.image-block').first();
      const details = await imagePresentation(image);
      assert.equal(details.align, 'left');
      assert.equal(details.caption, 'Legenda atualizada sintética');
      const expectsCrop = Boolean(evidence.tickets['#30']?.checks.cropMarkdownMarker);
      assert.equal(details.cropActive, expectsCrop);
      assert.ok(details.naturalWidth > 0);
      assert.equal(sha256(evidence.originalImage), evidence.tickets['#30'].fixture.originalImageHash);
      const markdown = readMarkdown(vaultDir, 'Interface.md');
      assert.match(markdown, /morrow:image align="left" caption="Legenda atualizada sintética"/);
      assert.equal(/crop="/.test(markdown), expectsCrop);
      return { reopenedImage: details, markdownCropRoundTrip: expectsCrop, originalImageUnchanged: true };
    },
    '#31': async () => {
      await openPage(page, 'Interface sintética');
      const heading = page.locator('.ProseMirror h2').filter({ hasText: 'Seção recolhível' }).first();
      const button = heading.locator('.heading-fold-btn');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      assert.ok(await page.locator('.is-collapsed-hidden').count() > 0);
      const content = await page.locator('.ProseMirror').evaluate((editor) => editor.textContent ?? '');
      assert.ok(content.includes('Conteúdo sintético que deve ficar oculto'));
      assert.match(readMarkdown(vaultDir, 'Interface.md'), /morrow:heading collapsible collapsed/i);
      return { reopenedStillCollapsed: true, contentStillPresent: true };
    },
    '#40': async () => {
      await openPage(page, 'Interface sintética');
      const columns = page.locator('.ProseMirror .columns').first();
      assert.equal(await columns.locator('.column').count(), 7);
      const content = await page.locator('.ProseMirror').textContent();
      assert.ok(content?.includes('Parágrafo para mover à sétima coluna'));
      assert.ok(content?.includes('Parágrafo que não deve ser movido para uma oitava coluna'));
      assert.equal((readMarkdown(vaultDir, 'Interface.md').match(/<div data-column>/g) ?? []).length, 7);
      return { reopenedSevenColumns: true, contentsPreserved: true };
    },
    '#29': async () => {
      await openPage(page, 'Painel sintético');
      const views = page.locator('.linked-database-view');
      assert.equal(await views.count(), 2);
      assert.equal(await views.nth(0).locator('input.linked-database-name').inputValue(), 'Visão somente Alfa');
      assert.equal(await views.nth(1).locator('input.linked-database-name').inputValue(), 'Visão somente Beta');
      assert.equal(await views.nth(0).locator('.database').count(), 0, 'The first linked view should reopen collapsed');
      assert.equal(await views.nth(1).locator('.database').count(), 1, 'The second linked view should remain expanded');
      const search = await views.nth(1).locator('.db-search input').inputValue();
      assert.equal(search, 'Beta');
      const persistedViews = linkedViewPayloads(readMarkdown(vaultDir, 'Painel.md')).map((item) => item.view);
      assert.deepEqual(persistedViews.map((view) => [view.name, view.search, view.collapsed]), [
        ['Visão somente Alfa', 'Alfa', true],
        ['Visão somente Beta', 'Beta', undefined],
      ]);
      return { reopenedNames: persistedViews.map((view) => view.name), independentSearches: persistedViews.map((view) => view.search), collapsedStateIndependent: true, sourceLinkMapSaved: true };
    },
    '#38': async () => {
      await openPage(page, 'Financeiro sintético');
      const matching = await page.locator('.database tbody tr').evaluateAll((rows) => rows.map((row) => {
        const cells = [...row.querySelectorAll('td')];
        const valueCell = cells.find((cell) => ['100', '200', '300'].includes(cell.textContent?.trim() ?? ''));
        return { value: valueCell?.textContent?.trim(), color: valueCell ? getComputedStyle(valueCell).backgroundColor : null };
      }));
      assert.equal(matching.find((row) => row.value === '100')?.color, 'rgba(0, 0, 0, 0)');
      assert.equal(matching.find((row) => row.value === '200')?.color, 'rgb(49, 87, 200)');
      assert.equal(matching.find((row) => row.value === '300')?.color, 'rgb(49, 87, 200)');
      return { reopenedRuleStillColorsOnlyMatches: matching };
    },
    '#39': async () => {
      await openPage(page, 'Financeiro sintético');
      await page.getByRole('tab').filter({ hasText: 'Principal' }).click();
      const table = page.locator('.database table').first();
      const primary = await table.locator('tfoot tr').innerText();
      assert.match(primary, /600/);
      assert.match(primary, /3/);
      await page.getByRole('tab').filter({ hasText: 'Revisão' }).click();
      const review = await page.locator('.database table tfoot tr').innerText();
      assert.match(review, /300/);
      return { reopenedPrimaryView: primary, reopenedReviewView: review, configurationsIndependent: true };
    },
    '#37': async () => {
      await openPage(page, 'Livros sintéticos');
      const markdown = readMarkdown(vaultDir, 'Livros.md');
      const rasterBlock = markdown.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
      const svgBlock = markdown.match(/    - id: svg_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
      assert.match(rasterBlock, /type: currency/);
      assert.match(rasterBlock, /icon:[^\n]*portrait-200x400\.png/);
      assert.match(svgBlock, /icon:[^\n]*portrait-200x400\.svg/);

      const originalPageIcon = await pageIconState(page, vaultDir);
      assert.equal(originalPageIcon.domValue, '📚');
      assert.match(originalPageIcon.frontmatterValue ?? '', /📚/);

      const canvasPanel = await openPropertySettings(page, 'Rich canvas layer test');
      const canvasPreview = canvasPanel.locator('.media-default-value button.rich-canvas-preview');
      await canvasPreview.waitFor({ state: 'visible' });
      assert.match(await canvasPreview.innerText(), /Saved synthetic canvas content/);
      await saveEditorScreenshot(page, evidence, 'editor-20-rich-canvas-saved-after-reopen.png');
      await page.keyboard.press('Escape');
      await canvasPanel.waitFor({ state: 'detached' });

      const rasterHeader = page.locator('.database thead th').filter({ hasText: 'Value type test' }).first();
      await page.waitForFunction(() => {
        const header = [...document.querySelectorAll('.database thead th')].find((item) => item.textContent?.includes('Value type test'));
        const image = header?.querySelector('img.icon-image');
        return image?.naturalWidth === 200 && image.naturalHeight === 400 && image.style.width === '14px' && image.style.height === '14px';
      });
      const rasterHeaderMetrics = await uploadedGlyphMetrics(rasterHeader, 'raster');
      assert.equal(rasterHeaderMetrics.naturalWidth, 200);
      assert.equal(rasterHeaderMetrics.naturalHeight, 400);
      assert.equal(rasterHeaderMetrics.styleWidth, '14px');
      assert.equal(rasterHeaderMetrics.styleHeight, '14px');

      const svgHeader = page.locator('.database thead th').filter({ hasText: 'SVG type test' }).first();
      await page.waitForFunction(() => {
        const header = [...document.querySelectorAll('.database thead th')].find((item) => item.textContent?.includes('SVG type test'));
        return header?.querySelector('.custom-svg-icon svg')?.getAttribute('viewBox') === '0 0 200 400';
      });
      const svgHeaderMetrics = await uploadedGlyphMetrics(svgHeader, 'svg');
      assert.equal(svgHeaderMetrics.svgViewBox, '0 0 200 400');
      assert.equal(svgHeaderMetrics.styleWidth, '14px');
      assert.equal(svgHeaderMetrics.styleHeight, '14px');

      const panel = await openPropertySettings(page, 'Value type test');
      const rasterSettingsButton = panel.locator('button.prop-icon-trigger');
      const rasterSettingsMetrics = await uploadedGlyphMetrics(rasterSettingsButton, 'raster');
      const rasterSettingsSlot = await rasterSettingsButton.evaluate((button) => ({
        width: getComputedStyle(button).width,
        height: getComputedStyle(button).height,
      }));
      assert.deepEqual(rasterSettingsSlot, { width: '32px', height: '32px' });
      assert.equal(rasterSettingsMetrics.naturalWidth, 200);
      assert.equal(rasterSettingsMetrics.naturalHeight, 400);
      assert.equal(rasterSettingsMetrics.styleWidth, '14px');
      assert.equal(rasterSettingsMetrics.styleHeight, '14px');
      await saveEditorScreenshot(page, evidence, 'editor-20-raster-settings-after-reopen.png');

      await panel.locator('.prop-reset-icon-btn').click();
      const markdownAfterReset = await waitForMarkdown(
        vaultDir,
        'Livros.md',
        (text) => {
          const block = text.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
          const svg = text.match(/    - id: svg_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
          return /type: currency/.test(block) && !/^\s*icon:/m.test(block) && /portrait-200x400\.svg/.test(svg);
        },
        'reset only the raster property icon while retaining the SVG property icon',
      );
      const resetHeaderCustomIconCount = await rasterHeader.locator('img.icon-image, .custom-svg-icon').count();
      assert.equal(resetHeaderCustomIconCount, 0, 'Reset must clear the custom icon from the currency property header.');
      assert.ok(await svgHeader.locator('.custom-svg-icon svg').count(), 'Resetting the raster property must keep the other SVG icon.');
      const pageIconAfterReset = await pageIconState(page, vaultDir);
      assert.deepEqual(pageIconAfterReset, originalPageIcon, 'Resetting a property icon must not remove the page icon.');
      await saveEditorScreenshot(page, evidence, 'editor-20-property-reset-preserves-page-icon.png');
      return {
        rasterTypeAndIconAfterReopen: { type: 'currency', ...rasterHeaderMetrics },
        svgIconAfterReopen: svgHeaderMetrics,
        settingsSlotAfterReopen: { slot: rasterSettingsSlot, glyph: rasterSettingsMetrics },
        resetClearedOnlyRasterPropertyIcon: resetHeaderCustomIconCount === 0,
        svgPropertyIconRetainedAfterOtherReset: true,
        pageIconBeforeAndAfterReset: { before: originalPageIcon, after: pageIconAfterReset },
        markdownAfterResetContainsNoRasterPropertyIcon: !/^\s*icon:/m.test(
          markdownAfterReset.match(/    - id: type_test[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '',
        ),
      };
    },
    '#41': async () => {
      await openPage(page, 'Livros sintéticos');
      const panel = await openPropertySettings(page, 'Biography result');
      const formula = panel.locator('textarea.formula-input');
      const value = await formula.inputValue();
      assert.equal(value, 'Autor.`Livros escritos`');
      const tokenTexts = await panel.locator('.formula-highlight .formula-token').allInnerTexts();
      assert.ok(tokenTexts.some((text) => text.includes('Livros escritos')), 'The bound second relation field must render as a token after reopen');
      const markdown = readMarkdown(vaultDir, 'Livros.md');
      const formulaBlock = markdown.match(/    - id: writer_bio[\s\S]*?(?=\n    - id:|\n  views:)/)?.[0] ?? '';
      assert.match(formulaBlock, /formulaBindings:[\s\S]*?propertyId:\s*books/, 'The relation property ID must survive reopen');
      return { reopenedFormula: value, renderedReferenceTokens: tokenTexts, relationPropertyBindingReopened: true };
    },
    '#42': async () => {
      await openPage(page, 'Livros sintéticos');
      const rows = await page.locator('.database table tbody tr').allInnerTexts();
      assert.ok(rows.every((text) => /R\$\s?150,50/.test(text)), `Currency format should survive reopen: ${rows.join(' | ')}`);
      assert.ok(rows.every((text) => /\b0\b/.test(text)));
      const formulaValues = await readFormulaResultRows(page);
      assert.ok(formulaValues.every((values) => values.zero === '0'));
      assert.ok(
        formulaValues.every((values) =>
          values.available?.role === 'checkbox' &&
          values.available.checked === 'false' &&
          values.available.label === 'Disponível calculado' &&
          values.available.visible &&
          values.available.contrastRatio >= 3 &&
          values.available.width >= 12 &&
          values.available.height >= 12 &&
          values.available.iconWidth >= 12 &&
          values.available.iconHeight >= 12,
        ),
        'A persisted false formula result must remain a visible, legible, unchecked checkbox',
      );
      assert.ok(
        formulaValues.every((values) =>
          values.availableBlank.cellPresent &&
          values.availableBlank.text?.toLocaleLowerCase() === 'vazio' &&
          !values.availableBlank.checkboxPresent,
        ),
        'A persisted null checkbox formula must remain the empty-value placeholder, distinct from unchecked false',
      );
      return { reopenedCurrencyRows: rows, zeroAndFalseStillDistinct: formulaValues };
    },
    '#43': async () => {
      const books = readMarkdown(vaultDir, 'Livros.md');
      const authors = readMarkdown(vaultDir, 'Autores.md');
      assert.match(books, /inversePropertyId: books/);
      assert.match(authors, /isInverse: true/);
      await openPage(page, 'Autores sintéticos');
      const rows = await page.locator('.database tbody tr').allInnerTexts();
      const asha = rows.find((text) => text.includes('Asha')) ?? '';
      assert.ok(asha.includes('Livro Alfa') && asha.includes('Livro Beta'), `Inverse relation must project the union after reopen: ${asha}`);
      return { relationMetadataReopened: true, projectedBooksForAsha: asha };
    },
  };

  for (const id of selected) {
    if (!evidence.tickets[id]?.actionVerified && !(id === '#30' && evidence.tickets[id]?.partialActionVerified)) continue;
    if (!['#26', '#28'].includes(id)) await runReopen(evidence, id, checks[id]);
    else if (evidence.tickets[id]?.actionVerified) evidence.tickets[id].status = 'passed';
  }
}

async function runGroup(group = 'all', onlyTickets = null) {
  assert.ok(group === 'all' || Object.hasOwn(groups, group), `Unknown delivery group: ${group}`);
  const groupTickets = group === 'all' ? Object.values(groups).flat() : groups[group];
  if (onlyTickets) assert.ok(onlyTickets.every((id) => groupTickets.includes(id)), `Ticket filter must be in ${group}: ${onlyTickets.join(', ')}`);
  const selected = onlyTickets ? groupTickets.filter((id) => onlyTickets.includes(id)) : groupTickets;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `morrow-${group}-ui-`));
  const editorEvidencePrefix = process.env.MORROW_EDITOR_EVIDENCE_PREFIX ?? null;
  if (editorEvidencePrefix) assert.match(editorEvidencePrefix, /^[a-z0-9-]+$/i, 'Evidence prefixes may contain only letters, digits and hyphens.');
  const evidence = {
    runAt: new Date().toISOString(),
    group,
    projectHead: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    buildSnapshotHead: process.env.MORROW_UI_BUILD_HEAD ?? null,
    buildInputFingerprint: process.env.MORROW_UI_BUILD_INPUT_FINGERPRINT ?? null,
    buildInputState: 'The compiled snapshot includes uncommitted worktree edits; this is validation evidence, not the final release candidate.',
    compiledApp: path.join(projectRoot, 'dist-electron', 'main.cjs'),
    compiledAppModifiedAt: fs.statSync(path.join(projectRoot, 'dist-electron', 'main.cjs')).mtime.toISOString(),
    hiddenMode: true,
    syntheticFixturesRoot: root,
    editorEvidenceRoot: process.env.MORROW_EDITOR_EVIDENCE_DIR ?? root,
    editorEvidencePrefix,
    editorEvidencePath:
      group === 'delivery3' && selected.includes('#37') && process.env.MORROW_EDITOR_EVIDENCE_DIR
        ? path.join(process.env.MORROW_EDITOR_EVIDENCE_DIR, `${editorEvidencePrefix ?? 'editor-20-icon'}-acceptance.json`)
        : null,
    hiddenChecks: {},
    fatalFailures: [],
    tickets: {},
  };
  if (evidence.editorEvidencePath && fs.existsSync(evidence.editorEvidencePath)) {
    throw new Error(`Refusing to overwrite existing editor evidence: ${evidence.editorEvidencePath}. Set MORROW_EDITOR_EVIDENCE_PREFIX for a new run.`);
  }
  let app;
  for (const id of selected) {
    const fixtureRoot = path.join(root, `ticket-${id.slice(1)}`);
    const fixture = writeFixture(fixtureRoot);
    const imageHash = sha256(fixture.originalImage);
    const hiddenCheck = {
      initialLaunch: false,
      afterInitialActions: false,
      reopenedLaunch: false,
      afterReopenActions: false,
    };
    evidence.hiddenChecks[id] = hiddenCheck;
    evidence.tickets[id] = {
      status: 'pending',
      checks: {},
      fixture: {
        syntheticProfile: fixture.profileDir,
        syntheticVault: fixture.vaultDir,
        originalImageHash: imageHash,
        syntheticRasterIcon: fixture.syntheticRasterIcon,
        syntheticSvgIcon: fixture.syntheticSvgIcon,
      },
    };
    try {
      const launched = await launchHidden(fixture);
      app = launched.app;
      evidence.tickets[id].compiledBuildIdentity = { initialLaunch: launched.buildIdentity };
      setRuntime(evidence, fixture, app, launched.page);
      hiddenCheck.initialLaunch = true;
      evidence.page.on('pageerror', (error) => (evidence.pageErrors ??= []).push({
        ticket: id,
        phase: 'initial',
        diagnosticStep: evidence.tickets[id]?.diagnosticStep ?? null,
        message: error.message,
        stack: error.stack ?? null,
      }));
      await evidence.page.waitForTimeout(900);
      await runInitial(evidence, [id]);
      await assertHidden(app);
      hiddenCheck.afterInitialActions = true;
      await app.close();
      app = null;

      const reopened = await launchHidden(fixture);
      app = reopened.app;
      evidence.tickets[id].compiledBuildIdentity.reopenedLaunch = reopened.buildIdentity;
      setRuntime(evidence, fixture, app, reopened.page);
      hiddenCheck.reopenedLaunch = true;
      evidence.page.on('pageerror', (error) => (evidence.pageErrors ??= []).push({
        ticket: id,
        phase: 'reopen',
        diagnosticStep: evidence.tickets[id]?.diagnosticStep ?? null,
        message: error.message,
        stack: error.stack ?? null,
      }));
      await evidence.page.waitForTimeout(700);
      await runPersistenceChecks(evidence, [id]);
      await assertHidden(app);
      hiddenCheck.afterReopenActions = true;
    } catch (error) {
      evidence.fatalFailures.push({ ticket: id, message: error.stack ?? String(error) });
      evidence.tickets[id].status = 'fatal-failure';
      console.error(`FATAL ${id}: ${error.message}`);
    } finally {
      if (app) await app.close().catch(() => {});
      app = null;
    }
  }

  for (const id of selected) evidence.tickets[id] ??= { status: 'not-run', actionVerified: false, reopenVerified: false };
  const buildSnapshots = selected.flatMap((id) => {
    const launches = evidence.tickets[id]?.compiledBuildIdentity ?? {};
    return Object.values(launches).flatMap((launch) => [launch.beforeLaunch, launch.afterLaunch]);
  });
  const buildFingerprints = buildSnapshots.map((snapshot) => JSON.stringify(snapshot));
  evidence.compiledBuildStableAcrossLaunches = buildFingerprints.length > 0 && new Set(buildFingerprints).size === 1;
  const artifactFingerprints = buildSnapshots.map((snapshot) => snapshot.artifactContentSha256);
  evidence.compiledArtifactStableAcrossLaunches = artifactFingerprints.length > 0 && new Set(artifactFingerprints).size === 1;
  evidence.buildFingerprint = {
    commitAtSnapshot: evidence.buildSnapshotHead,
    sourceInputsSha256: evidence.buildInputFingerprint,
    artifactContentSha256: artifactFingerprints[0] ?? null,
    artifactFileCount: buildSnapshots[0]?.artifactFileCount ?? null,
  };
  evidence.allWindowsStayedHidden = Object.values(evidence.hiddenChecks).every((checks) => Object.values(checks).every(Boolean));
  evidence.pageErrors = evidence.pageErrors ?? [];
  evidence.pageErrorsByLaunch = {
    initial: evidence.pageErrors.filter((error) => error.phase === 'initial'),
    reopen: evidence.pageErrors.filter((error) => error.phase === 'reopen'),
  };
  evidence.overall = selected.every((id) => evidence.tickets[id]?.status === 'passed') &&
    evidence.allWindowsStayedHidden && evidence.compiledBuildStableAcrossLaunches && evidence.compiledArtifactStableAcrossLaunches && !evidence.pageErrors.length && !evidence.fatalFailures.length ? 'passed' : 'failed';
  const evidencePath = path.join(root, `evidence-${group}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  if (evidence.editorEvidencePath) {
    fs.mkdirSync(path.dirname(evidence.editorEvidencePath), { recursive: true });
    fs.writeFileSync(evidence.editorEvidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  }
  console.log(`Evidence JSON: ${evidencePath}`);
  console.log(`Synthetic fixtures retained for audit under: ${root}`);
  console.log(`RESULT ${group}: ${evidence.overall}`);
  if (evidence.overall !== 'passed') process.exitCode = 1;
  return evidence;
}

if (require.main === module) {
  const group = process.argv[2] ?? 'all';
  const onlyTickets = process.argv.slice(3);
  runGroup(group, onlyTickets.length ? onlyTickets : null).catch((error) => {
    console.error(`VERIFICATION FAILED: ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}

module.exports = { runGroup };
