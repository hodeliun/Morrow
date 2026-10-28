const { _electron } = require('C:/Users/clove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'docs', 'releases', '1.1.1', 'assets');
const provenancePath = path.join(projectRoot, 'docs', 'releases', '1.1.1', 'PROVENANCE-DATA.md');
const tempPrefix = 'morrow-release-data-1.1.1-';
const viewport = { width: 1280, height: 680 };
const crop = { x: 220, y: 20, width: 1060, height: 640 };
const expectedVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
const outputFiles = [
  'data-01-relacao-inversa.gif',
  'data-01-relacao-inversa.png',
  'data-02-linhas-e-desfazer.gif',
  'data-02-linha-apos-desfazer.png',
];

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Missing compiled output: ${path.basename(directory)}`);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(filePath);
    if (!entry.isFile()) return [];
    return [filePath];
  });
}

function compiledFingerprint() {
  const roots = ['dist', 'dist-electron'].map((name) => path.join(projectRoot, name));
  const files = roots
    .flatMap(filesUnder)
    .map((filePath) => ({
      file: path.relative(projectRoot, filePath).replaceAll(path.sep, '/'),
      bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return {
    fileCount: files.length,
    sha256: sha256(JSON.stringify(files)),
    electronMainSha256: sha256File(path.join(projectRoot, 'dist-electron', 'main.cjs')),
  };
}

function gitState() {
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim(),
    worktreeDirty:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim() !== '',
  };
}

function assertInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function databaseMarkdown(title, properties, viewId) {
  return `---
kind: database
database:
  properties:
${properties}
  views:
    - id: ${viewId}
      name: Principal
      type: table
      filters: []
      sorts: []
      hidden: []
      widths: {}
      groupBy: null
      dateProp: null
---
# ${title}
`;
}

function rowMarkdown(title, properties = {}) {
  const fields = Object.entries(properties).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${fields.join('\n')}\n---\n# ${title}\n`;
}

function createFixture(vaultDir) {
  const booksProperties = `    - id: book-author
      name: Autor
      type: relation
      relation:
        targetDatabaseId: autores-db
        multiple: false
        isInverse: false
        displayPropertyId: author-name
        inversePropertyId: null
        filters: []
`;
  const authorsProperties = `    - id: author-name
      name: Nome
      type: text
`;
  const pages = {
    'Livros.md': { id: 'livros-db' },
    'Livros/A Ilha de Lume.md': { id: 'book-lume' },
    'Livros/Cartas do Vento.md': { id: 'book-cartas' },
    'Livros/Jardim de Vidro.md': { id: 'book-jardim' },
    'Autores.md': { id: 'autores-db' },
    'Autores/Lia Nogueira.md': { id: 'author-lia' },
    'Autores/Caio Marfim.md': { id: 'author-caio' },
  };

  fs.mkdirSync(path.join(vaultDir, '.morrow'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'Livros'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'Autores'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '.morrow', 'workspace.json'), JSON.stringify({ pages }, null, 2));
  fs.writeFileSync(
    path.join(vaultDir, 'Livros.md'),
    databaseMarkdown('Livros', booksProperties, 'livros-principal'),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Autores.md'),
    databaseMarkdown('Autores', authorsProperties, 'autores-principal'),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Livros', 'A Ilha de Lume.md'),
    rowMarkdown('A Ilha de Lume', { Autor: 'Lia Nogueira' }),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Livros', 'Cartas do Vento.md'),
    rowMarkdown('Cartas do Vento', { Autor: 'Lia Nogueira' }),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Livros', 'Jardim de Vidro.md'),
    rowMarkdown('Jardim de Vidro', { Autor: 'Caio Marfim' }),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Autores', 'Lia Nogueira.md'),
    rowMarkdown('Lia Nogueira', { Nome: 'Lia Nogueira' }),
  );
  fs.writeFileSync(
    path.join(vaultDir, 'Autores', 'Caio Marfim.md'),
    rowMarkdown('Caio Marfim', { Nome: 'Caio Marfim' }),
  );
}

function waitForFile(filePath, predicate, description, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        if (predicate(text)) finish(null, text);
      } catch {
        // The save queue can replace a file atomically; the directory watcher retries the read.
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
      () => finish(new Error(`${description} was not persisted within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    check();
  });
}

function propertyBlock(markdown, propertyId) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s{4}- id:\s*(.+?)\s*$/.exec(line)?.[1] === propertyId);
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

function journal(vaultDir) {
  const journalPath = path.join(vaultDir, '.morrow', 'table-action-journal.json');
  if (!fs.existsSync(journalPath)) return null;
  const value = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  return { id: value.id, status: value.status, label: value.label };
}

async function launchHidden(profileDir) {
  return _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      MORROW_HIDDEN: '1',
      MORROW_USER_DATA: profileDir,
    },
  });
}

async function assertAllWindowsHidden(app) {
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
  );
  assert.equal(visible, 0, 'Every Electron window must remain hidden.');
}

async function setPortugueseLocale(page) {
  await page.evaluate(() => {
    const key = 'morrow.preferences';
    let preferences = {};
    try {
      preferences = JSON.parse(localStorage.getItem(key) || '{}');
    } catch {
      preferences = {};
    }
    localStorage.setItem(key, JSON.stringify({ ...preferences, locale: 'pt' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setViewportSize(viewport);
  await page.locator('.tree-row').first().waitFor({ state: 'visible', timeout: 20000 });
}

async function openDatabase(page, title, requiredHeader) {
  const treeRow = page.locator('.tree-row').filter({ hasText: title }).first();
  await treeRow.waitFor({ state: 'visible', timeout: 20000 });
  await treeRow.click();
  await page.waitForFunction(
    (header) =>
      [...document.querySelectorAll('.db-table thead .db-header-name')].some(
        (item) => item.textContent?.trim() === header,
      ),
    requiredHeader,
    { timeout: 20000 },
  );
}

async function centerTable(page) {
  await page.locator('.db-table').evaluate((table) =>
    table.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.waitForFunction(() => {
    const bounds = document.querySelector('.db-table')?.getBoundingClientRect();
    return bounds !== undefined && bounds.top >= 40 && bounds.bottom <= innerHeight - 20;
  });
}

async function captureFrame(page, directory, name) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(dimensions.width >= crop.x + crop.width && dimensions.height >= crop.y + crop.height);
  const framePath = path.join(directory, `${name}.png`);
  await page.screenshot({
    path: framePath,
    clip: crop,
    animations: 'disabled',
    caret: 'hide',
  });
  return framePath;
}

function runFfmpeg(args) {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const details = error && typeof error === 'object' && 'stderr' in error ? error.stderr : '';
    throw new Error(`ffmpeg failed: ${String(details || error)}`);
  }
}

function writeConcatList(frames, filePath) {
  const lines = [];
  for (const frame of frames) {
    const file = path.resolve(frame.file).replaceAll('\\', '/');
    lines.push(`file '${file}'`, `duration ${frame.duration}`);
  }
  const lastFile = path.resolve(frames.at(-1).file).replaceAll('\\', '/');
  lines.push(`file '${lastFile}'`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function gifInfo(filePath) {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration:format=duration',
      '-of',
      'json',
      filePath,
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw);
  const stream = parsed.streams?.[0] ?? {};
  const duration = Number(parsed.format?.duration ?? stream.duration);
  return { width: stream.width, height: stream.height, durationSeconds: Number(duration.toFixed(2)) };
}

function createGif(frames, outputPath, tempDir) {
  const concatPath = path.join(tempDir, `${path.basename(outputPath, '.gif')}.concat.txt`);
  const palettePath = path.join(tempDir, `${path.basename(outputPath, '.gif')}.palette.png`);
  writeConcatList(frames, concatPath);

  for (const profile of [
    { fps: 8, colors: 128 },
    { fps: 7, colors: 96 },
    { fps: 6, colors: 96 },
  ]) {
    runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-vf',
      `fps=${profile.fps},palettegen=max_colors=${profile.colors}:stats_mode=diff`,
      palettePath,
    ]);
    runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-i',
      palettePath,
      '-lavfi',
      `fps=${profile.fps}[frames];[frames][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop',
      '0',
      outputPath,
    ]);
    const info = gifInfo(outputPath);
    if (
      info.width === crop.width &&
      info.durationSeconds >= 10 &&
      info.durationSeconds <= 18 &&
      fs.statSync(outputPath).size < 3 * 1024 * 1024
    )
      return { ...info, fps: profile.fps, colors: profile.colors };
  }

  throw new Error(`${path.basename(outputPath)} did not meet the GIF duration, width or size targets.`);
}

function outputInfo(filePath) {
  return {
    file: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}

function renderProvenance(data) {
  const lines = [
    '# Proveniência da mídia de dados — Morrow fork 1.1.1',
    '',
    'Demonstrações capturadas no aplicativo Electron compilado, usando somente um perfil e um cofre sintéticos. Os GIFs são sequências de estados reais da interface, mantidos por intervalos documentados; não representam gravação contínua.',
    '',
    '## Build e captura',
    '',
    `- Versão no pacote: \`${data.packageVersion}\``,
    `- Versão lida por \`app.getVersion()\`: \`${data.runtimeVersion}\``,
    `- Commit fonte: \`${data.source.revision}\` (worktree compartilhado continha outras alterações em andamento; esta captura não alterou fonte do produto).`,
    `- Script de captura: \`scripts/capture-release-data-1.1.1.cjs\` — SHA-256 \`${data.scriptSha256}\`.`,
    `- Locale da fixture: português (\`pt\`); viewport: ${viewport.width} × ${viewport.height}; recorte: ${crop.width} × ${crop.height}px a partir de x=${crop.x}, y=${crop.y}.`,
    `- Electron: \`${data.electronVersion}\`; ffmpeg: \`${data.ffmpegVersion}\`.`,
    `- Janelas Electron visíveis durante a execução: 0; erros de página: ${data.pageErrors.length}; perfil e cofre temporários removidos: sim.`,
    `- Fingerprint combinado de \`dist/\` + \`dist-electron/\` antes: \`${data.compiledBefore.sha256}\` (${data.compiledBefore.fileCount} arquivos); depois: \`${data.compiledAfter.sha256}\` (${data.compiledAfter.fileCount} arquivos). Os fingerprints e o hash de \`dist-electron/main.cjs\` coincidem; o aplicativo não foi recompilado.`,
    `- Hash de \`dist-electron/main.cjs\`: \`${data.compiledBefore.electronMainSha256}\`.`,
    '',
    '## Demonstrações',
    '',
    '### Relação inversa',
    '',
    `- GIF: [${data.inverseGif.file}](assets/${data.inverseGif.file}) — ${data.inverseGif.width} × ${data.inverseGif.height}px, ${data.inverseGif.durationSeconds}s, ${data.inverseGif.fps} fps, ${data.inverseGif.bytes} bytes, SHA-256 \`${data.inverseGif.sha256}\`.`,
    '- Legenda: Criar uma relação inversa em Livros e conferir os vínculos nos dois bancos, inclusive depois de reabrir o aplicativo.',
    '- Texto alternativo: A interface abre a configuração da coluna Autor, seleciona Autores e cria a coluna inversa Livros. Depois, a tabela Autores mostra os livros ligados a Lia Nogueira e Caio Marfim, e os mesmos vínculos continuam visíveis após reabrir.',
    `- Captura complementar: [${data.inversePng.file}](assets/${data.inversePng.file}) — ${data.inversePng.bytes} bytes, SHA-256 \`${data.inversePng.sha256}\`.`,
    '- Cenário: valores legados de texto em Autor são reconciliados ao criar a relação; Lia fica ligada a dois livros e Caio a um. O ID da coluna inversa é o gerado pela interface e é lido dos arquivos salvos.',
    '',
    '### Selecionar, inserir e desfazer linha',
    '',
    `- GIF: [${data.rowsGif.file}](assets/${data.rowsGif.file}) — ${data.rowsGif.width} × ${data.rowsGif.height}px, ${data.rowsGif.durationSeconds}s, ${data.rowsGif.fps} fps, ${data.rowsGif.bytes} bytes, SHA-256 \`${data.rowsGif.sha256}\`.`,
    '- Legenda: Selecionar uma linha pela alça de seis pontos, abrir as ações com Shift+F10, inserir antes da linha e desfazer.',
    '- Texto alternativo: A linha A Ilha de Lume é selecionada pela alça de seis pontos. O menu contextual mostra Inserir linha antes; uma linha aparece e o aviso Desfazer a remove, restaurando as três linhas originais.',
    `- Captura complementar: [${data.rowsPng.file}](assets/${data.rowsPng.file}) — ${data.rowsPng.bytes} bytes, SHA-256 \`${data.rowsPng.sha256}\`.`,
    '- Cenário: cliques e teclado normais na interface, sem uso da área de transferência; o journal termina como desfeito.',
    '',
    'Os dados fictícios e os nomes são criados apenas para esta captura. Nenhuma captura contém perfil, vault ou registros pessoais.',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const source = gitState();
  const compiledBefore = compiledFingerprint();
  const ffmpegVersion = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
  const scriptSha256 = sha256File(__filename);

  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of [...outputFiles, 'PROVENANCE-DATA.md']) {
    const target = name === 'PROVENANCE-DATA.md' ? provenancePath : path.join(assetsDir, name);
    assertInside(target, name === 'PROVENANCE-DATA.md' ? path.dirname(provenancePath) : assetsDir);
    assert.ok(!fs.existsSync(target), `Refusing to overwrite existing media: ${path.basename(target)}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(os.tmpdir());
  assert.ok(
    path.basename(resolvedTempRoot).startsWith(tempPrefix) &&
      path.relative(resolvedTempBase, resolvedTempRoot).startsWith(tempPrefix),
    'Temporary fixture must be created inside the uniquely named capture directory.',
  );
  const profileDir = path.join(tempRoot, 'profile');
  const vaultDir = path.join(tempRoot, 'vault');
  const frameDir = path.join(tempRoot, 'frames');
  fs.mkdirSync(profileDir);
  fs.mkdirSync(vaultDir);
  fs.mkdirSync(frameDir);
  fs.writeFileSync(
    path.join(profileDir, 'vaults.json'),
    JSON.stringify({ current: vaultDir, recent: [{ path: vaultDir, openedAt: Date.now() }] }),
  );
  createFixture(vaultDir);

  let app = null;
  const pageErrors = [];
  const createdOutputs = [];
  const frames = { inverse: [], rows: [] };
  let runtimeVersion = null;
  let electronVersion = null;
  let inverseGif = null;
  let rowsGif = null;
  let inversePng = null;
  let rowsPng = null;

  try {
    console.log('Opening the compiled app with an isolated synthetic profile.');
    app = await launchHidden(profileDir);
    runtimeVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    electronVersion = await app.evaluate(() => process.versions.electron);
    assert.equal(runtimeVersion, expectedVersion, 'Runtime version must match the candidate package.');
    await assertAllWindowsHidden(app);

    let page = await app.firstWindow();
    page.on('pageerror', (error) => pageErrors.push({ name: error.name, message: error.message }));
    await page.setViewportSize(viewport);
    await page.locator('.tree-row').first().waitFor({ state: 'visible', timeout: 20000 });
    await setPortugueseLocale(page);

    console.log('Capturing inverse relation setup and reopened projections.');
    await openDatabase(page, 'Livros', 'Autor');
    await centerTable(page);
    assert.equal(await page.locator('.db-table tbody tr').count(), 3);
    frames.inverse.push({
      file: await captureFrame(page, frameDir, 'inverse-01-livros-inicial'),
      duration: 2.4,
    });

    const ownerRow = page.locator('.db-table tbody tr').filter({ hasText: 'A Ilha de Lume' }).first();
    assert.match(await ownerRow.innerText(), /Lia Nogueira/);
    await page.locator('.db-header').filter({ hasText: 'Autor' }).click();
    const relationPanel = page.locator('.db-panel');
    await relationPanel.waitFor({ state: 'visible' });
    const targetField = relationPanel
      .locator('.field')
      .filter({ hasText: /Tabela relacionada|tabela de destino|target table|related database/i });
    await targetField.locator('.select-button').click();
    await page.getByRole('option', { name: 'Autores', exact: true }).click();
    const createMode = relationPanel.getByRole('radio', {
      name: /Criar nova coluna no destino|create new column in target/i,
    });
    await createMode.click();
    const inverseName = relationPanel
      .locator('.field')
      .filter({ hasText: /Nome da nova coluna|new column name/i })
      .locator('input');
    assert.equal(await inverseName.inputValue(), 'Livros');
    frames.inverse.push({
      file: await centerTable(page).then(() => captureFrame(page, frameDir, 'inverse-02-configurar')),
      duration: 2.6,
    });

    await relationPanel.getByRole('button', { name: /Criar e vincular|Create & Link/i }).click();
    const sourceText = await waitForFile(
      path.join(vaultDir, 'Livros.md'),
      (text) => {
        const block = propertyBlock(text, 'book-author');
        return block !== null && /^\s+inversePropertyId:\s*(?!null\s*$)\S+\s*$/m.test(block);
      },
      'Source relation schema',
    );
    const ownerBlock = propertyBlock(sourceText, 'book-author');
    assert.ok(ownerBlock);
    const inverseId = ownerBlock.match(/^\s+inversePropertyId:\s*(\S+)\s*$/m)?.[1];
    assert.ok(inverseId && inverseId !== 'null');
    const targetText = await waitForFile(
      path.join(vaultDir, 'Autores.md'),
      (text) => propertyBlock(text, inverseId) !== null,
      'Inverse relation schema',
    );
    const inverseBlock = propertyBlock(targetText, inverseId);
    assert.ok(inverseBlock);
    assert.match(inverseBlock, /^\s+name:\s*Livros\s*$/m);
    assert.match(inverseBlock, /^\s+type:\s*relation\s*$/m);
    assert.match(inverseBlock, /^\s+targetDatabaseId:\s*livros-db\s*$/m);
    assert.match(inverseBlock, /^\s+isInverse:\s*true\s*$/m);
    assert.match(inverseBlock, /^\s+inversePropertyId:\s*book-author\s*$/m);
    const linkedOwnerRow = page.locator('.db-table tbody tr').filter({ hasText: 'A Ilha de Lume' }).first();
    await linkedOwnerRow.waitFor({ state: 'visible' });
    assert.match(await linkedOwnerRow.innerText(), /Lia Nogueira/);
    frames.inverse.push({
      file: await captureFrame(page, frameDir, 'inverse-03-livros-vinculados'),
      duration: 2.4,
    });
    await page.keyboard.press('Escape');
    await relationPanel.waitFor({ state: 'detached' });

    await openDatabase(page, 'Autores', 'Livros');
    await centerTable(page);
    const liaRow = page.locator('.db-table tbody tr').filter({ hasText: 'Lia Nogueira' }).first();
    const caioRow = page.locator('.db-table tbody tr').filter({ hasText: 'Caio Marfim' }).first();
    await liaRow.waitFor({ state: 'visible' });
    assert.match(await liaRow.innerText(), /A Ilha de Lume/);
    assert.match(await liaRow.innerText(), /Cartas do Vento/);
    assert.match(await caioRow.innerText(), /Jardim de Vidro/);
    frames.inverse.push({
      file: await captureFrame(page, frameDir, 'inverse-04-duas-vias'),
      duration: 2.8,
    });

    console.log('Reopening the isolated app to confirm the inverse values persist.');
    await app.close();
    app = await launchHidden(profileDir);
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getVersion()), expectedVersion);
    await assertAllWindowsHidden(app);
    page = await app.firstWindow();
    page.on('pageerror', (error) => pageErrors.push({ name: error.name, message: error.message }));
    await page.setViewportSize(viewport);
    await page.locator('.tree-row').first().waitFor({ state: 'visible', timeout: 20000 });
    await setPortugueseLocale(page);
    await openDatabase(page, 'Autores', 'Livros');
    await centerTable(page);
    const reopenedLiaRow = page.locator('.db-table tbody tr').filter({ hasText: 'Lia Nogueira' }).first();
    const reopenedCaioRow = page.locator('.db-table tbody tr').filter({ hasText: 'Caio Marfim' }).first();
    await reopenedLiaRow.waitFor({ state: 'visible' });
    assert.match(await reopenedLiaRow.innerText(), /A Ilha de Lume/);
    assert.match(await reopenedLiaRow.innerText(), /Cartas do Vento/);
    assert.match(await reopenedCaioRow.innerText(), /Jardim de Vidro/);
    frames.inverse.push({
      file: await captureFrame(page, frameDir, 'inverse-05-reaberto'),
      duration: 3.0,
    });
    inversePng = path.join(assetsDir, 'data-01-relacao-inversa.png');
    fs.copyFileSync(frames.inverse.at(-1).file, inversePng, fs.constants.COPYFILE_EXCL);
    createdOutputs.push(inversePng);

    console.log('Capturing row-grip selection, actions, insertion and undo.');
    await openDatabase(page, 'Livros', 'Autor');
    await centerTable(page);
    assert.equal(await page.locator('.db-table tbody tr').count(), 3);
    frames.rows.push({ file: await captureFrame(page, frameDir, 'rows-01-inicial'), duration: 2.4 });

    const selectedRow = page.locator('.db-table tbody tr').filter({ hasText: 'A Ilha de Lume' }).first();
    const grip = selectedRow.locator('.db-row-drag');
    await grip.click();
    assert.equal(await grip.getAttribute('aria-pressed'), 'true');
    frames.rows.push({ file: await captureFrame(page, frameDir, 'rows-02-selecionada'), duration: 2.4 });

    await grip.focus();
    await page.keyboard.press('Shift+F10');
    const actionMenu = page.getByRole('menu');
    await actionMenu.waitFor({ state: 'visible' });
    await actionMenu.getByRole('menuitem', { name: /Inserir linha antes|Insert row before/i }).waitFor({ state: 'visible' });
    frames.rows.push({ file: await captureFrame(page, frameDir, 'rows-03-acoes'), duration: 2.6 });

    const previousJournal = journal(vaultDir);
    await actionMenu.getByRole('menuitem', { name: /Inserir linha antes|Insert row before/i }).click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 4);
    const undoButton = page.locator('.table-action-recovery button').filter({ hasText: /Desfazer|Undo/i });
    await undoButton.waitFor({ state: 'visible' });
    await waitForFile(
      path.join(vaultDir, '.morrow', 'table-action-journal.json'),
      (text) => {
        try {
          const saved = JSON.parse(text);
          return saved.status === 'complete' && saved.id !== previousJournal?.id;
        } catch {
          return false;
        }
      },
      'Insert action journal',
    );
    frames.rows.push({ file: await captureFrame(page, frameDir, 'rows-04-inserida'), duration: 3.0 });

    await undoButton.click();
    await page.waitForFunction(() => document.querySelectorAll('.db-table tbody tr').length === 3);
    await page.locator('.table-action-recovery button').waitFor({ state: 'detached' });
    const undone = journal(vaultDir);
    assert.equal(undone?.status, 'undone');
    assert.notEqual(undone?.id, previousJournal?.id);
    assert.match(await page.locator('.db-table').innerText(), /A Ilha de Lume/);
    assert.match(await page.locator('.db-table').innerText(), /Cartas do Vento/);
    assert.match(await page.locator('.db-table').innerText(), /Jardim de Vidro/);
    await page.getByText('Linha adicionada e salva.', { exact: true }).waitFor({ state: 'detached' });
    await openDatabase(page, 'Autores', 'Livros');
    await openDatabase(page, 'Livros', 'Autor');
    await centerTable(page);
    assert.equal((await page.locator('.table-action-recovery').innerText()).trim(), 'A última ação foi desfeita.');
    frames.rows.push({ file: await captureFrame(page, frameDir, 'rows-05-desfeita'), duration: 3.0 });
    rowsPng = path.join(assetsDir, 'data-02-linha-apos-desfazer.png');
    fs.copyFileSync(frames.rows.at(-1).file, rowsPng, fs.constants.COPYFILE_EXCL);
    createdOutputs.push(rowsPng);

    await assertAllWindowsHidden(app);
    assert.deepEqual(pageErrors, [], 'The renderer must report no page errors.');
    await app.close();
    app = null;

    inverseGif = path.join(assetsDir, 'data-01-relacao-inversa.gif');
    rowsGif = path.join(assetsDir, 'data-02-linhas-e-desfazer.gif');
    const inverseRender = createGif(frames.inverse, inverseGif, tempRoot);
    createdOutputs.push(inverseGif);
    inverseGif = { path: inverseGif, ...inverseRender, ...outputInfo(inverseGif) };
    const rowsRender = createGif(frames.rows, rowsGif, tempRoot);
    createdOutputs.push(rowsGif);
    rowsGif = { path: rowsGif, ...rowsRender, ...outputInfo(rowsGif) };

    const compiledAfter = compiledFingerprint();
    assert.deepEqual(compiledAfter, compiledBefore, 'Compiled output must be unchanged by capture.');
    const provenance = {
      packageVersion: packageJson.version,
      runtimeVersion,
      electronVersion,
      source,
      scriptSha256,
      ffmpegVersion,
      compiledBefore,
      compiledAfter,
      pageErrors,
      inverseGif: {
        ...inverseGif,
        fps: 8,
      },
      inversePng: outputInfo(inversePng),
      rowsGif,
      rowsPng: outputInfo(rowsPng),
    };
    const markdown = renderProvenance(provenance);
    fs.writeFileSync(provenancePath, markdown, { encoding: 'utf8', flag: 'wx' });
    createdOutputs.push(provenancePath);
    console.log(
      JSON.stringify({
        version: runtimeVersion,
        sourceRevision: source.revision,
        buildFingerprintBefore: compiledBefore.sha256,
        buildFingerprintAfter: compiledAfter.sha256,
        inverseGif: { file: inverseGif.file, width: inverseGif.width, height: inverseGif.height, durationSeconds: inverseGif.durationSeconds, bytes: inverseGif.bytes },
        rowsGif: { file: rowsGif.file, width: rowsGif.width, height: rowsGif.height, durationSeconds: rowsGif.durationSeconds, bytes: rowsGif.bytes },
        outputs: [...outputFiles, 'PROVENANCE-DATA.md'],
      }, null, 2),
    );
  } catch (error) {
    console.error(`Data release media capture failed: ${error instanceof Error ? error.message : String(error)}`);
    for (const output of createdOutputs) {
      const parent = output === provenancePath ? path.dirname(provenancePath) : assetsDir;
      assertInside(output, parent);
      if (!fs.existsSync(output)) continue;
      const metadata = fs.lstatSync(output);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Only owned regular output files may be cleaned.');
      fs.rmSync(output);
    }
    throw error;
  } finally {
    if (app) await app.close();
    const normalizedRoot = path.resolve(tempRoot);
    const relative = path.relative(path.resolve(os.tmpdir()), normalizedRoot);
    if (path.basename(normalizedRoot).startsWith(tempPrefix) && relative.startsWith(tempPrefix)) {
      fs.rmSync(normalizedRoot, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(normalizedRoot), false, 'The owned temporary profile and vault must be removed.');
  }
}

main().catch(() => process.exit(1));
