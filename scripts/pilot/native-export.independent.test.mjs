// Independent end-to-end proof for provider-owned row literals and static website export.
// The sole intercepted boundary is the public window.morrow.saveFile bridge.
import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { unzipSync } from 'fflate';
import { Window } from 'happy-dom';

const CAPTURE_KEY = '__morrowE182IndependentSaveFileCapture';
const WEBDRIVER_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const EXPECTED_FORMULA = 'Quantity * Price';
const EXPECTED_COMMAND = 'Publish everything as a website';
const POLL_MS = 50;
const CAPTURE_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const EXTRA_CALL_SETTLE_MS = 250;
const MARKDOWN_FILES = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];

function fail(message) {
  throw new Error(message);
}

function requireThat(condition, message) {
  if (!condition) fail(message);
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function watchdogError(label) {
  const error = new Error(`${label} exceeded its deadline.`);
  error.watchdogExpired = true;
  return error;
}

async function boundedByDeadline(operation, deadlineAt, label) {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw watchdogError(label);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(watchdogError(label)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bounded(operationOrPromise, label, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const operation = typeof operationOrPromise === 'function'
    ? operationOrPromise
    : () => operationOrPromise;
  return boundedByDeadline(operation, performance.now() + timeoutMs, label);
}

async function recordBounded(recordStep, name, details = {}) {
  return bounded(recordStep(name, details), `Record evidence step ${name}`);
}

async function waitForCondition(probe, description, timeoutMs = CAPTURE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await bounded(probe(), `Observe ${description}`);
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await pause(POLL_MS);
  }
  const suffix = lastError ? `; most recent observation failed: ${lastError?.message ?? lastError}` : '';
  fail(`Timed out waiting for ${description}${suffix}`);
}

function elementIdentifier(reference) {
  return reference?.[WEBDRIVER_ELEMENT] ?? reference?.ELEMENT ?? null;
}

async function clickReference(driver, reference, description) {
  const identifier = elementIdentifier(reference);
  if (!identifier) fail(`WebDriver returned no element handle for ${description}.`);
  return bounded(driver.request('POST', driver.path(`/element/${identifier}/click`), {}), `Click ${description}`);
}

function canonicalPaletteTitleFromOption(option) {
  const title = option.querySelector('.palette-item-title');
  if (!title) return null;
  const directText = [...title.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.nodeValue ?? '')
    .join('')
    .trim();
  return directText || null;
}

export function selectUniqueCanonicalPaletteOption(inventory, expectedTitle = EXPECTED_COMMAND) {
  const matching = inventory.flatMap((option, index) => (
    option?.visible === true && option.canonicalTitle === expectedTitle ? [{ index, reference: option.reference }] : []
  ));
  if (matching.length === 1) return { status: 'unique', ...matching[0] };
  if (matching.length > 1) return { status: 'ambiguous', indexes: matching.map((option) => option.index) };
  return { status: 'missing', indexes: [] };
}

export function assertPaletteSelectionUnitCases() {
  const sandbox = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  let inventory;
  const createPageReference = { optionId: 'create-page' };
  const publishReference = { optionId: 'publish-exact' };
  try {
    const container = sandbox.document.createElement('div');
    container.innerHTML = `<div role="option"><div class="palette-item-title">Create a page called “${EXPECTED_COMMAND}”</div><div class="palette-snippet">${EXPECTED_COMMAND}</div></div>
      <div role="option"><div class="palette-item-title">${EXPECTED_COMMAND}<span class="palette-item-detail"> Website</span></div><div class="palette-snippet">Create a page</div></div>`;
    inventory = [...container.querySelectorAll('[role="option"]')].map((option, index) => ({
      reference: index === 0 ? createPageReference : publishReference,
      visible: true,
      canonicalTitle: canonicalPaletteTitleFromOption(option),
      domAggregate: option.textContent?.trim() ?? '',
      getAggregate: option.textContent?.trim() ?? '',
    }));
  } finally {
    sandbox.close();
  }
  requireThat(inventory[1].canonicalTitle === EXPECTED_COMMAND && inventory[1].domAggregate !== EXPECTED_COMMAND,
    'Canonical title extraction must exclude the command detail and snippet aggregates.');
  const unique = selectUniqueCanonicalPaletteOption(inventory);
  requireThat(unique.status === 'unique' && unique.index === 1 && unique.reference === publishReference,
    'Canonical title selection must ignore Create page and preserve the exact reference paired with the Publish title.');
  const duplicate = selectUniqueCanonicalPaletteOption([inventory[1], { ...inventory[1] }]);
  requireThat(duplicate.status === 'ambiguous' && duplicate.indexes.length === 2,
    'Canonical title selection must reject duplicate visible exact options.');
  const hidden = selectUniqueCanonicalPaletteOption([{ ...inventory[1], visible: false }]);
  requireThat(hidden.status === 'missing', 'Canonical title selection must ignore hidden exact options.');
  return true;
}

async function readPaletteOptionInventory(driver) {
  const dom = await bounded(() => driver.execute(`const dialogs = [...document.querySelectorAll('.palette[role="dialog"]')];
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const inputCount = dialog?.querySelectorAll('input[role="combobox"]').length ?? 0;
    const options = dialog ? [...dialog.querySelectorAll('[role="option"]')] : [];
    return {
      paletteCount: dialogs.length,
      inputCount,
      options: options.map((option, index) => {
        const canonicalTitle = (${canonicalPaletteTitleFromOption.toString()})(option);
        const aggregate = option.innerText ?? option.textContent ?? '';
        const style = getComputedStyle(option);
        const rect = option.getBoundingClientRect();
        const list = option.closest('.palette-results');
        const listRect = list?.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0
          && (!listRect || (rect.bottom > listRect.top && rect.top < listRect.bottom));
        return {
          reference: option,
          index,
          dataIndex: option.getAttribute('data-index'),
          canonicalTitle,
          canonicalTitleCodePoints: canonicalTitle === null ? [] : [...canonicalTitle].map((character) => character.codePointAt(0)),
          domAggregate: aggregate.trim(),
          visible,
          getAggregate: null,
          getAggregateType: null,
        };
      }),
    };`), 'Read public command palette option DOM inventory');
  const observations = Array.isArray(dom?.options) ? dom.options : [];
  const references = observations.map((item) => item.reference);
  const inventory = observations.map((item) => {
    const metadata = { ...item };
    delete metadata.reference;
    return metadata;
  });
  return {
    paletteCount: dom?.paletteCount ?? 0,
    inputCount: dom?.inputCount ?? 0,
    referenceCount: references.length,
    references,
    inventory,
    // Each reference and its DOM facts are returned together by this single execute call.
    observations,
    aligned: references.length === inventory.length
      && observations.every((item, index) => item.index === index && Boolean(elementIdentifier(item.reference))),
  };
}

async function readPaletteOptionGetAggregate(driver, reference, deadlineAt) {
  const identifier = elementIdentifier(reference);
  if (!identifier) throw new Error('WebDriver returned no element handle for a command palette option.');
  return boundedByDeadline(
    () => driver.request('GET', driver.path(`/element/${identifier}/text`)),
    deadlineAt,
    'Read WebDriver aggregate text for command palette option',
  );
}

async function addPaletteGetAggregates(driver, references, inventory, deadlineAt) {
  for (const [index, reference] of references.entries()) {
    if (!inventory[index] || performance.now() >= deadlineAt) break;
    try {
      const aggregate = await readPaletteOptionGetAggregate(driver, reference, deadlineAt);
      inventory[index].getAggregate = aggregate;
      inventory[index].getAggregateType = typeof aggregate;
    } catch (error) {
      inventory[index].getAggregateError = error instanceof Error ? error.message : String(error);
      if (error?.watchdogExpired || performance.now() >= deadlineAt) break;
    }
  }
  return inventory;
}

async function recordPaletteFailureDiagnostic(driver, references, inventory, recordStep, eventName, details) {
  const deadlineAt = performance.now() + CLEANUP_TIMEOUT_MS;
  try {
    await addPaletteGetAggregates(driver, references, inventory, deadlineAt);
    if (performance.now() < deadlineAt) {
      await boundedByDeadline(
        () => recordStep(eventName, { ...details, options: inventory }),
        deadlineAt,
        `Record ${eventName}`,
      );
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function locateWorkspacePageIds(workspace) {
  const pages = workspace?.pages ?? {};
  const ids = {
    source: pages['Inventory.md']?.id,
    row: pages['Inventory/Widget.md']?.id,
    note: pages['Views.md']?.id,
  };
  if (!Object.values(ids).every((id) => typeof id === 'string' && id.length > 0)) {
    fail('The synthetic workspace does not contain stable Inventory, Widget, and Views page IDs.');
  }
  return ids;
}

async function readSyntheticFile(vaultRoot, relative) {
  const resolvedRoot = path.resolve(vaultRoot);
  const file = path.resolve(resolvedRoot, relative);
  const relativeToRoot = path.relative(resolvedRoot, file);
  if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    fail(`Synthetic file escaped its isolated vault: ${relative}`);
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Expected a regular synthetic file at ${relative}.`);
  const bytes = await readFile(file);
  return { path: file, bytes, size: bytes.byteLength, mtimeMs: info.mtimeMs, sha256: hashBytes(bytes) };
}

async function markdownSnapshot(vaultRoot) {
  const result = {};
  for (const file of MARKDOWN_FILES) {
    const item = await readSyntheticFile(vaultRoot, file);
    result[file] = { sha256: item.sha256, size: item.size, mtimeMs: item.mtimeMs };
  }
  return result;
}

function formulaSourceFromMarkdown(markdown) {
  const lines = markdown.match(/^\s*formula:\s*(.*?)\s*$/gim) ?? [];
  const values = lines.map((line) => line.replace(/^\s*formula:\s*/i, '').trim());
  return values.length === 1 ? values[0] : null;
}

function scalarFromMarkdown(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`, 'im').exec(markdown);
  return match?.[1] ?? null;
}

function sameContent(left, right, label) {
  for (const file of MARKDOWN_FILES) {
    if (left[file]?.sha256 !== right[file]?.sha256
      || left[file]?.size !== right[file]?.size
      || left[file]?.mtimeMs !== right[file]?.mtimeMs) {
      fail(`${label}: ${file} changed during the export flow.`);
    }
  }
}

async function clickPageTreeItem(driver, pageId, label) {
  const selector = `[role="treeitem"][data-page-id="${pageId}"]`;
  const item = await waitForCondition(async () => {
    const matches = await driver.elements(selector);
    return matches.length === 1 ? matches[0] : false;
  }, `one visible sidebar tree entry for ${label}`);
  await clickReference(driver, item, `${label} sidebar entry`);
}

async function waitForProviderSource(driver) {
  return waitForCondition(async () => {
    const state = await driver.execute(`const providers = [...document.querySelectorAll('[data-provider="polaris-dados"]')];
      const title = document.querySelector('textarea.page-title');
      const rows = [...document.querySelectorAll('[data-provider="polaris-dados"] tbody tr')];
      return {
        providerCount: providers.length,
        hasTable: providers.length === 1 && Boolean(providers[0].querySelector('table')),
        title: title?.value ?? null,
        widgetRows: rows.filter((row) => row.textContent?.trim().includes('Widget')).length,
      };`);
    return state.providerCount === 1 && state.hasTable && state.title === 'Inventory' && state.widgetRows === 1
      ? state
      : false;
  }, 'the real Inventory provider table with one Widget row');
}

async function routeToPage(driver, pageId, label) {
  await bounded(() => driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [pageId]), `Navigate to ${label} through the public page route`);
}

async function readWidgetProperties(driver) {
  return driver.execute(`const title = document.querySelector('textarea.page-title');
    const properties = [...document.querySelectorAll('.row-props .row-prop')].map((item) => ({
      name: item.querySelector('.row-prop-name')?.textContent?.trim() ?? '',
      value: item.querySelector('.row-prop-value')?.textContent?.trim() ?? '',
    }));
    const formulaNodes = [...document.querySelectorAll('.row-props .formula-source-literal')];
    const propertyNames = properties.map((property) => property.name);
    return {
      title: title?.value ?? null,
      titleReadOnly: title?.readOnly ?? false,
      properties,
      propertyNames,
      propertyEditors: document.querySelectorAll('.row-props input, .row-props textarea, .row-props select, .row-props .row-prop-button, .row-props .row-prop-actions').length,
      providerNavigationLinks: document.querySelectorAll('.row-props .row-props-provider-link').length,
      formulaLiteralCount: formulaNodes.length,
      formulaLiteral: formulaNodes[0]?.textContent?.trim() ?? null,
    };`);
}

function inspectExportHtml(htmlBytes, archiveName) {
  const html = new TextDecoder('utf-8', { fatal: true }).decode(htmlBytes);
  const sandbox = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  try {
    const document = new sandbox.DOMParser().parseFromString(html, 'text/html');
    const matchingArticles = [...document.querySelectorAll('main article')].filter((article) =>
      article.querySelector('h1')?.textContent?.trim() === 'Inventory');
    if (matchingArticles.length !== 1) {
      fail(`${archiveName}: expected one page article headed Inventory, found ${matchingArticles.length}.`);
    }
    const article = matchingArticles[0];
    const fallback = [...article.querySelectorAll('.provider-fallback')]
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .find((text) => text.includes('This export is read only.') && text.includes('formula cells show their source.')) ?? null;
    if (!fallback) fail(`${archiveName}: provider export is missing its visible read-only notice.`);

    const editableControls = article.querySelectorAll('input, textarea, select, button, [contenteditable="true"], script').length;
    if (editableControls !== 0) fail(`${archiveName}: Inventory export has ${editableControls} editable controls or scripts.`);

    const propertyNames = ['Name', 'Quantity', 'Price', 'Total'];
    const matchingTables = [];
    const observedHeaders = [];
    for (const table of article.querySelectorAll('table')) {
      const rows = [...table.querySelectorAll('tr')];
      const headerIndex = rows.findIndex((row) => row.querySelector('th'));
      if (headerIndex < 0) continue;
      const headerCells = [...rows[headerIndex].querySelectorAll('th')];
      const headers = headerCells.map((cell) => cell.textContent?.trim() ?? '');
      observedHeaders.push(headers);
      const propertyHeaders = headers.slice(1);
      if (headers[0] !== 'Name'
        || propertyNames.some((name) => propertyHeaders.filter((header) => header === name).length !== 1)) continue;
      const index = Object.fromEntries(propertyNames.map((name) => [name, propertyHeaders.indexOf(name) + 1]));
      const rowMatches = rows.slice(headerIndex + 1).filter((row) => {
        const cells = [...row.querySelectorAll('th, td')];
        return cells[0]?.textContent?.trim() === 'Widget'
          && cells[index.Name]?.textContent?.trim() === 'Widget';
      });
      if (rowMatches.length !== 1) continue;
      const cells = [...rowMatches[0].querySelectorAll('th, td')];
      matchingTables.push({
        headers,
        rowTitle: cells[0]?.textContent?.trim() ?? null,
        name: cells[index.Name]?.textContent?.trim() ?? null,
        quantity: cells[index.Quantity]?.textContent?.trim() ?? null,
        price: cells[index.Price]?.textContent?.trim() ?? null,
        total: cells[index.Total]?.textContent?.trim() ?? null,
      });
    }
    if (matchingTables.length !== 1) {
      fail(`${archiveName}: expected one Inventory table with one Widget row; got ${matchingTables.length}, headers=${JSON.stringify(observedHeaders)}.`);
    }
    const inventoryRow = matchingTables[0];
    if (inventoryRow.quantity !== '2' || inventoryRow.price !== '10') {
      fail(`${archiveName}: stored Widget values changed: ${JSON.stringify(inventoryRow)}.`);
    }
    if (inventoryRow.total !== EXPECTED_FORMULA) {
      fail(`${archiveName}: Total must contain the literal formula ${JSON.stringify(EXPECTED_FORMULA)}, got ${JSON.stringify(inventoryRow.total)}.`);
    }
    return {
      archiveName,
      pageTitle: document.querySelector('title')?.textContent?.trim() ?? null,
      heading: 'Inventory',
      readOnlyNotice: fallback,
      editableControlCount: editableControls,
      table: inventoryRow,
    };
  } finally {
    sandbox.close();
  }
}

function examineWebsiteArchive(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) fail('The captured website payload is empty or not a byte buffer.');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('The captured website payload does not have a ZIP signature.');
  const files = unzipSync(bytes);
  const names = Object.keys(files).sort();
  const htmlNames = names.filter((name) => /\.html$/i.test(name));
  if (htmlNames.length < 2) fail(`The website ZIP must include multiple static pages, found ${htmlNames.length}.`);
  for (const name of htmlNames) {
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0')
      || path.posix.isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail(`The website ZIP contains an unsafe HTML archive path: ${JSON.stringify(name)}.`);
    }
  }
  const inventoryNames = htmlNames.filter((name) => path.posix.basename(name).toLowerCase() === 'inventory.html');
  if (inventoryNames.length !== 1) fail(`The website ZIP must contain one Inventory.html page, found ${inventoryNames.length}.`);
  const inventoryName = inventoryNames[0];
  const inspected = inspectExportHtml(files[inventoryName], inventoryName);
  const htmlDigests = htmlNames.map((name) => ({ name, size: files[name].byteLength, sha256: hashBytes(files[name]) }));
  return {
    summary: {
      entryCount: names.length,
      entries: names,
      htmlPageCount: htmlNames.length,
      htmlDigests,
      inventory: inspected,
    },
    htmlFiles: htmlNames.map((name) => ({ name, bytes: files[name] })),
  };
}

async function retainWebsiteHtml(candidate, htmlFiles) {
  const evidenceRoot = await realpath(candidate.evidence);
  const directory = path.resolve(evidenceRoot, 'native-export-independent-html');
  const relativeDirectory = path.relative(evidenceRoot, directory);
  if (!relativeDirectory || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    fail('The independent retained HTML directory escaped its evidence root.');
  }
  await bounded(() => mkdir(directory, { mode: 0o700 }), 'Create retained website HTML directory');
  const actualDirectory = await realpath(directory);
  if (actualDirectory !== directory) fail('The retained website HTML directory resolved through an unexpected path.');

  const retained = [];
  for (const [index, entry] of htmlFiles.entries()) {
    const baseName = path.posix.basename(entry.name).replace(/[^A-Za-z0-9._-]/g, '_');
    const filename = `${String(index + 1).padStart(3, '0')}-${baseName || 'page.html'}`;
    const target = path.resolve(directory, filename);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(`Retained HTML output escaped its new evidence directory: ${entry.name}`);
    }
    await bounded(() => writeFile(target, entry.bytes, { flag: 'wx', mode: 0o600 }), `Retain HTML ${entry.name}`);
    const info = await bounded(() => lstat(target), `Inspect retained HTML ${entry.name}`);
    if (!info.isFile() || info.isSymbolicLink()) fail(`Retained HTML output is not a regular file: ${filename}`);
    const copied = await bounded(() => readFile(target), `Read retained HTML ${entry.name}`);
    const digest = hashBytes(entry.bytes);
    if (copied.byteLength !== entry.bytes.byteLength || hashBytes(copied) !== digest) {
      fail(`Retained HTML bytes differ from ZIP entry ${entry.name}.`);
    }
    retained.push({
      archiveName: entry.name,
      path: target,
      size: copied.byteLength,
      sha256: digest,
    });
  }
  return { directory, files: retained };
}

// This self-contained WebView function shadows only the public saveFile method.
// Every branch cancels; the original implementation is intentionally never invoked.
function installPublicSinkCapture(windowTarget, stateKey) {
  const bridge = windowTarget?.morrow;
  if (!bridge || (typeof bridge !== 'object' && typeof bridge !== 'function')) {
    throw new Error('Public window.morrow bridge is missing before Publish.');
  }
  if (Object.hasOwn(windowTarget, stateKey)) throw new Error('Independent export capture key is already occupied.');
  const ownDescriptor = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
  let owner = bridge;
  let sourceDescriptor = ownDescriptor;
  let depth = 0;
  if (!sourceDescriptor) {
    owner = Object.getPrototypeOf(bridge);
    depth = 1;
    while (owner && !(sourceDescriptor = Object.getOwnPropertyDescriptor(owner, 'saveFile'))) {
      owner = Object.getPrototypeOf(owner);
      depth += 1;
    }
  }
  if (!sourceDescriptor || !Object.hasOwn(sourceDescriptor, 'value') || typeof sourceDescriptor.value !== 'function') {
    throw new Error('Public window.morrow.saveFile is not a data-property function.');
  }
  if (ownDescriptor && ownDescriptor.configurable === false && ownDescriptor.writable !== true) {
    throw new Error('Public saveFile is an immutable own descriptor; refusing to publish without safe capture.');
  }
  if (!ownDescriptor && !Object.isExtensible(bridge)) {
    throw new Error('The public saveFile bridge cannot accept a temporary method shadow.');
  }
  const state = {
    installed: false,
    invocationCount: 0,
    extraCallCount: 0,
    invalidCallCount: 0,
    firstCallSeen: false,
    inFirstCall: false,
    captureError: null,
    capture: null,
    publishStarted: false,
    watchdogExpired: false,
    deferredRestore: false,
    restoreStatus: 'not-requested',
    ownerDepth: depth,
    originalOwnDescriptor: ownDescriptor,
    originalOwner: owner,
    originalDescriptor: sourceDescriptor,
    originalFunction: sourceDescriptor.value,
    wrapper: null,
  };
  const cancelled = () => Promise.resolve({ ok: false, error: null });
  const base64 = (bytes) => {
    let raw = '';
    for (let index = 0; index < bytes.length; index += 0x4000) {
      raw += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x4000, bytes.length)));
    }
    return windowTarget.btoa(raw);
  };
  const intercepted = function independentWebsiteSaveFileCancel(name, data) {
    state.invocationCount += 1;
    if (state.firstCallSeen || state.inFirstCall) {
      state.extraCallCount += 1;
      return cancelled();
    }
    state.firstCallSeen = true;
    state.inFirstCall = true;
    try {
      if (typeof name !== 'string' || !(data instanceof windowTarget.ArrayBuffer)) {
        state.invalidCallCount += 1;
        state.captureError = 'Public saveFile expected a file name and ArrayBuffer.';
        return cancelled();
      }
      const copy = new Uint8Array(new Uint8Array(data));
      state.capture = {
        name,
        byteLength: copy.byteLength,
        bytesBase64: base64(copy),
        capturedAt: new Date().toISOString(),
      };
      return cancelled();
    } catch (error) {
      state.captureError = error instanceof Error ? error.message : String(error);
      return cancelled();
    } finally {
      state.inFirstCall = false;
    }
  };
  state.wrapper = intercepted;
  try {
    Object.defineProperty(windowTarget, stateKey, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: state,
    });
    if (ownDescriptor) {
      Object.defineProperty(bridge, 'saveFile', { ...ownDescriptor, value: intercepted });
    } else {
      Object.defineProperty(bridge, 'saveFile', {
        configurable: true,
        enumerable: sourceDescriptor.enumerable,
        writable: sourceDescriptor.writable,
        value: intercepted,
      });
    }
  } catch (error) {
    Reflect.deleteProperty(windowTarget, stateKey);
    throw new Error(`Could not install the public saveFile canceller: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  state.installed = true;
  return {
    installed: true,
    ownerDepth: depth,
    descriptorEnumerable: sourceDescriptor.enumerable,
    descriptorConfigurable: sourceDescriptor.configurable,
    descriptorWritable: Object.hasOwn(sourceDescriptor, 'writable') ? sourceDescriptor.writable : null,
    originalFunctionType: typeof sourceDescriptor.value,
  };
}

function captureSnapshot(windowTarget, stateKey, includeBytes = false) {
  const state = windowTarget?.[stateKey];
  if (!state) return null;
  return {
    installed: state.installed,
    invocationCount: state.invocationCount,
    extraCallCount: state.extraCallCount,
    invalidCallCount: state.invalidCallCount,
    firstCallSeen: state.firstCallSeen,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    capture: state.capture ? {
      name: state.capture.name,
      byteLength: state.capture.byteLength,
      capturedAt: state.capture.capturedAt,
      ...(includeBytes ? { bytesBase64: state.capture.bytesBase64 } : {}),
    } : null,
  };
}

function notePublishAction(windowTarget, stateKey) {
  const state = windowTarget?.[stateKey];
  if (!state?.installed) throw new Error('Cannot mark Publish: the public saveFile canceller is not installed.');
  state.publishStarted = true;
  state.publishAttemptedAt = new Date().toISOString();
  return true;
}

function finishCaptureLifecycle(windowTarget, stateKey, publishStarted, watchdogExpired) {
  const state = windowTarget?.[stateKey];
  if (!state?.installed) throw new Error('The independent public saveFile state disappeared before teardown.');
  const snapshot = () => ({
    installed: state.installed,
    invocationCount: state.invocationCount,
    extraCallCount: state.extraCallCount,
    invalidCallCount: state.invalidCallCount,
    firstCallSeen: state.firstCallSeen,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    capture: state.capture ? {
      name: state.capture.name,
      byteLength: state.capture.byteLength,
      capturedAt: state.capture.capturedAt,
    } : null,
  });
  state.publishStarted = state.publishStarted || publishStarted === true;
  state.watchdogExpired = state.watchdogExpired || watchdogExpired === true;
  if (state.publishStarted) {
    state.deferredRestore = true;
    state.restoreStatus = 'deferred-until-common-runner-app-shutdown';
    return snapshot();
  }
  const bridge = windowTarget.morrow;
  const visibleDescriptor = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
  if (!visibleDescriptor || visibleDescriptor.value !== state.wrapper) {
    state.restoreStatus = 'skipped-public-descriptor-changed';
    return snapshot();
  }
  try {
    if (state.originalOwnDescriptor) {
      Object.defineProperty(bridge, 'saveFile', state.originalOwnDescriptor);
    } else if (!Reflect.deleteProperty(bridge, 'saveFile')) {
      state.restoreStatus = 'could-not-remove-temporary-public-shadow';
      return snapshot();
    }
    const now = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
    const same = (left, right) => Boolean(left && right
      && left.configurable === right.configurable
      && left.enumerable === right.enumerable
      && Object.hasOwn(left, 'value') === Object.hasOwn(right, 'value')
      && (Object.hasOwn(left, 'value')
        ? left.value === right.value && left.writable === right.writable
        : left.get === right.get && left.set === right.set));
    const matches = state.originalOwnDescriptor
      ? same(now, state.originalOwnDescriptor)
      : now === undefined && same(Object.getOwnPropertyDescriptor(state.originalOwner, 'saveFile'), state.originalDescriptor);
    state.restoreStatus = matches ? 'original-descriptor-restored-before-publish' : 'restored-with-prototype-visible';
  } catch (error) {
    state.restoreStatus = `restore-failed:${error instanceof Error ? error.message : String(error)}`;
  }
  return snapshot();
}

function assertSerializedFinalizer() {
  const makeTarget = () => {
    const original = function originalSaveFile() {};
    const wrapper = function cancelledSaveFile() {};
    const descriptor = { configurable: true, enumerable: false, writable: true, value: original };
    const bridge = {};
    Object.defineProperty(bridge, 'saveFile', { ...descriptor, value: wrapper });
    const state = {
      installed: true,
      invocationCount: 0,
      extraCallCount: 0,
      invalidCallCount: 0,
      firstCallSeen: false,
      captureError: null,
      capture: null,
      publishStarted: false,
      watchdogExpired: false,
      deferredRestore: false,
      restoreStatus: 'not-requested',
      wrapper,
      originalOwnDescriptor: descriptor,
      originalOwner: bridge,
      originalDescriptor: descriptor,
    };
    return { windowTarget: { morrow: bridge, [CAPTURE_KEY]: state }, bridge, original, wrapper };
  };
  const deferred = makeTarget();
  const source = `(${finishCaptureLifecycle.toString()})(window, ${JSON.stringify(CAPTURE_KEY)}, true, true);`;
  const deferredResult = runInNewContext(source, { window: deferred.windowTarget });
  requireThat(deferredResult.deferredRestore === true
    && deferredResult.restoreStatus === 'deferred-until-common-runner-app-shutdown'
    && deferred.bridge.saveFile === deferred.wrapper,
  'Serialized WebView finalizer did not retain the public canceller after Publish.');

  const prePublish = makeTarget();
  const restoreSource = `(${finishCaptureLifecycle.toString()})(window, ${JSON.stringify(CAPTURE_KEY)}, false, false);`;
  const restoredResult = runInNewContext(restoreSource, { window: prePublish.windowTarget });
  requireThat(restoredResult.restoreStatus === 'original-descriptor-restored-before-publish'
    && prePublish.bridge.saveFile === prePublish.original,
  'Serialized WebView finalizer did not restore the original descriptor before Publish.');

  const inheritedOriginal = function inheritedSaveFile() {};
  const inheritedWrapper = function cancelledInheritedSaveFile() {};
  const inheritedDescriptor = { configurable: true, enumerable: false, writable: false, value: inheritedOriginal };
  const prototype = {};
  Object.defineProperty(prototype, 'saveFile', inheritedDescriptor);
  const inheritedBridge = Object.create(prototype);
  Object.defineProperty(inheritedBridge, 'saveFile', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: inheritedWrapper,
  });
  const inheritedState = {
    installed: true,
    invocationCount: 0,
    extraCallCount: 0,
    invalidCallCount: 0,
    firstCallSeen: false,
    captureError: null,
    capture: null,
    publishStarted: false,
    watchdogExpired: false,
    deferredRestore: false,
    restoreStatus: 'not-requested',
    wrapper: inheritedWrapper,
    originalOwnDescriptor: null,
    originalOwner: prototype,
    originalDescriptor: inheritedDescriptor,
  };
  const inheritedWindow = { morrow: inheritedBridge, [CAPTURE_KEY]: inheritedState };
  const inheritedResult = runInNewContext(restoreSource, { window: inheritedWindow });
  requireThat(inheritedResult.restoreStatus === 'original-descriptor-restored-before-publish'
    && !Object.hasOwn(inheritedBridge, 'saveFile')
    && inheritedBridge.saveFile === inheritedOriginal,
  'Serialized WebView finalizer did not remove the temporary inherited-method shadow.');
}

async function installCapture(driver) {
  return bounded(driver.execute(`return (${installPublicSinkCapture.toString()})(window, arguments[0]);`, [CAPTURE_KEY]), 'Install public saveFile capture');
}

async function readCapture(driver, includeBytes = false) {
  const deadlineAt = performance.now() + CLEANUP_TIMEOUT_MS;
  return readCaptureByDeadline(driver, includeBytes, deadlineAt);
}

async function readCaptureByDeadline(driver, includeBytes, deadlineAt) {
  return boundedByDeadline(
    () => driver.execute(`return (${captureSnapshot.toString()})(window, arguments[0], arguments[1]);`, [CAPTURE_KEY, includeBytes]),
    deadlineAt,
    'Read public saveFile capture state',
  );
}

async function markPublishStarted(driver) {
  return bounded(driver.execute(`return (${notePublishAction.toString()})(window, arguments[0]);`, [CAPTURE_KEY]), 'Mark Publish action started');
}

async function finishCapture(driver, publishStarted, timedOut) {
  return bounded(
    () => driver.execute(`return (${finishCaptureLifecycle.toString()})(window, arguments[0], arguments[1], arguments[2]);`, [CAPTURE_KEY, publishStarted, timedOut]),
    'Finalize public saveFile capture',
    CLEANUP_TIMEOUT_MS,
  );
}

async function awaitCapturedBytes(driver, timeoutMs = CAPTURE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let last = null;
  try {
    while (performance.now() < deadline) {
      last = await readCaptureByDeadline(driver, false, deadline);
      if (last?.captureError) {
        const error = new Error(`Public saveFile rejected the website payload: ${last.captureError}`);
        error.captureState = last;
        throw error;
      }
      if (last?.capture) {
        let stableFrom = performance.now();
        let lastCount = last.invocationCount;
        while (performance.now() - stableFrom < EXTRA_CALL_SETTLE_MS && performance.now() < deadline) {
          await pause(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
          if (performance.now() >= deadline) break;
          last = await readCaptureByDeadline(driver, false, deadline);
          if (last?.captureError) {
            const error = new Error(`Public saveFile rejected the website payload: ${last.captureError}`);
            error.captureState = last;
            throw error;
          }
          if (last.invocationCount !== lastCount) {
            lastCount = last.invocationCount;
            stableFrom = performance.now();
          }
        }
        if (performance.now() - stableFrom >= EXTRA_CALL_SETTLE_MS) {
          return await readCaptureByDeadline(driver, true, deadline);
        }
        break;
      }
      await pause(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      error.watchdogExpired = error.watchdogExpired === true || performance.now() >= deadline;
      error.captureState = last;
    }
    throw error;
  }
  const error = new Error('Timed out waiting for the website ZIP at public window.morrow.saveFile.');
  error.watchdogExpired = true;
  error.captureState = last;
  throw error;
}

async function assertCapturePollingDeadline() {
  const startedAt = performance.now();
  let observed;
  try {
    await awaitCapturedBytes({ execute: () => new Promise(() => {}) }, 20);
  } catch (error) {
    observed = error;
  }
  const elapsedMs = performance.now() - startedAt;
  requireThat(observed?.watchdogExpired === true && elapsedMs < 500,
    `A never-resolving capture read escaped its absolute deadline (${Math.round(elapsedMs)}ms).`);
}

async function evidencePath(candidate, filename) {
  const folder = await realpath(candidate.evidence);
  const target = path.resolve(folder, filename);
  const relative = path.relative(folder, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Evidence output escaped its isolated evidence folder: ${filename}`);
  }
  return target;
}

function compactCapture(state) {
  if (!state) return null;
  return {
    installed: state.installed,
    invocationCount: state.invocationCount,
    extraCallCount: state.extraCallCount,
    invalidCallCount: state.invalidCallCount,
    firstCallSeen: state.firstCallSeen,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    capture: state.capture ? {
      name: state.capture.name,
      byteLength: state.capture.byteLength,
      capturedAt: state.capture.capturedAt,
      sha256: state.capture.sha256 ?? null,
    } : null,
  };
}

async function writeIndependentEvidence(candidate, evidence) {
  const file = await evidencePath(candidate, 'native-export-independent-scenario.json');
  evidence.reportPath = file;
  await bounded(() => writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 }), 'Write independent export evidence');
  return file;
}

export async function runIndependentNativeExportScenario(context) {
  assertSerializedFinalizer();
  await assertCapturePollingDeadline();
  assertPaletteSelectionUnitCases();
  const { candidate, prepared, recordStep } = context;
  const driver = context.driver;
  requireThat(driver && candidate?.vault && candidate?.databaseId && candidate?.evidence,
    'The independent export scenario requires the isolated driver, vault, source ID, and evidence directory.');
  requireThat(prepared?.bankBefore && typeof recordStep === 'function',
    'The independent export scenario requires the runner-prepared synthetic baseline and evidence recorder.');

  const vaultRoot = await realpath(candidate.vault);
  const workspace = JSON.parse(await readFile(path.join(vaultRoot, '.morrow', 'workspace.json'), 'utf8'));
  const ids = locateWorkspacePageIds(workspace);
  requireThat(ids.source === candidate.databaseId, 'The real synthetic Inventory database ID differs from the prepared candidate.');
  const initialMarkdown = await markdownSnapshot(vaultRoot);
  const inventoryFile = await readSyntheticFile(vaultRoot, 'Inventory.md');
  const rowFile = await readSyntheticFile(vaultRoot, 'Inventory/Widget.md');
  const noteFile = await readSyntheticFile(vaultRoot, 'Views.md');
  requireThat(noteFile.bytes.toString('utf8').includes('Origin Views'), 'Views.md must be the fixture note before export.');
  const originalConfig = await readSyntheticFile(vaultRoot, '.morrow/plugins.json');
  const configValue = JSON.parse(originalConfig.bytes.toString('utf8'));
  requireThat(Array.isArray(configValue.enabled) && configValue.enabled.includes('polaris-dados'),
    'The synthetic Polaris Dados plugin must be enabled for website publication.');
  for (const [relative, current] of [['Inventory.md', inventoryFile], ['Inventory/Widget.md', rowFile]]) {
    const baseline = prepared.bankBefore[relative];
    requireThat(baseline && baseline.hash === current.sha256 && baseline.size === current.size && baseline.mtimeMs === current.mtimeMs,
      `Prepared synthetic baseline no longer matches ${relative}.`);
  }
  requireThat(formulaSourceFromMarkdown(inventoryFile.bytes.toString('utf8')) === EXPECTED_FORMULA,
    'Inventory.md must contain exactly one literal Quantity * Price formula.');
  requireThat(scalarFromMarkdown(rowFile.bytes.toString('utf8'), 'Quantity') === '2'
    && scalarFromMarkdown(rowFile.bytes.toString('utf8'), 'Price') === '10',
  'The isolated Widget fixture must start with stored Quantity 2 and Price 10.');

  const evidence = {
    issue: 182,
    scenario: 'export-independent',
    sourceDatabaseId: ids.source,
    widgetPageId: ids.row,
    viewsPageId: ids.note,
    formulaLiteral: EXPECTED_FORMULA,
    publishCommand: EXPECTED_COMMAND,
    initialMarkdown,
    initialPluginConfiguration: { sha256: originalConfig.sha256, size: originalConfig.size, enabled: configValue.enabled },
    publishStarted: false,
    captureInstalled: false,
    watchdogExpired: false,
    capture: null,
    archive: null,
    finalMarkdown: null,
    originalSaveFileNeverInvoked: true,
    deferredRestore: false,
    restoreStatus: 'not-installed',
    failure: null,
  };
  let captureInstalled = false;
  let publishStarted = false;
  let watchdogExpired = false;
  let failure = null;
  let captureStateBeforeFinalize = null;
  let zipEvidenceFile = null;
  let archiveBytes;

  try {
    await clickPageTreeItem(driver, ids.source, 'Inventory');
    const providerReady = await waitForProviderSource(driver);
    await recordBounded(recordStep, 'independent-182-inventory-provider-ready', {
      sourceId: ids.source,
      providerCount: providerReady.providerCount,
      tablePresent: providerReady.hasTable,
      widgetRows: providerReady.widgetRows,
    });
    await routeToPage(driver, ids.row, 'Widget');
    const widgetState = await waitForCondition(async () => {
      const state = await readWidgetProperties(driver);
      return state.title === 'Widget' ? state : false;
    }, 'real Widget page properties');
    requireThat(widgetState.titleReadOnly === true, 'The Widget title must be read-only.');
    requireThat(widgetState.providerNavigationLinks === 1, 'The Widget row must retain exactly one visible provider navigation link.');
    requireThat(widgetState.propertyEditors === 0, 'The Widget row title/formula/properties must not expose edit controls.');
    requireThat(widgetState.propertyNames.length === 4
      && ['Name', 'Quantity', 'Price', 'Total'].every((name) => widgetState.propertyNames.includes(name)),
    'The Widget row must show the four expected property names.');
    const rowValues = Object.fromEntries(widgetState.properties.map((property) => [property.name, property.value]));
    requireThat(rowValues.Name === 'Widget' && rowValues.Quantity === '2' && rowValues.Price === '10',
      `Widget literal values differ from the fixture: ${JSON.stringify(rowValues)}.`);
    requireThat(rowValues.Total === EXPECTED_FORMULA && widgetState.formulaLiteral === EXPECTED_FORMULA && widgetState.formulaLiteralCount === 1,
      'The Widget row must show Total as one read-only literal Quantity * Price formula.');
    evidence.widgetPageReadOnly = widgetState;
    await recordBounded(recordStep, 'independent-182-widget-row-literal-is-readonly', {
      title: widgetState.title,
      titleReadOnly: widgetState.titleReadOnly,
      properties: widgetState.properties,
      propertyEditors: widgetState.propertyEditors,
      providerNavigationLinks: widgetState.providerNavigationLinks,
      formulaLiteralCount: widgetState.formulaLiteralCount,
    });

    const openInventoryLink = await waitForCondition(async () => {
      const links = await driver.elements('.row-props .row-props-provider-link');
      return links.length === 1 ? links[0] : false;
    }, 'Widget provider link back to Inventory');
    await clickReference(driver, openInventoryLink, 'Widget source database navigation link');
    await waitForProviderSource(driver);
    await clickPageTreeItem(driver, ids.note, 'Views');
    const noteReady = await waitForCondition(async () => driver.execute(`const title = document.querySelector('textarea.page-title');
      const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')];
      return { title: title?.value ?? null, editorCount: editor.length, text: editor[0]?.textContent ?? '' };`)
      .then((state) => state.title === 'Views' && state.editorCount === 1 ? state : false),
    'the Views note editor for the real command palette');
    requireThat(noteReady.text.includes('Origin Views') || noteReady.text.includes('linked views'),
      'The Views note must be the synthetic linked-view note before opening the command palette.');

    const editor = await waitForCondition(async () => {
      const matches = await driver.elements('.ProseMirror[contenteditable="true"]');
      return matches.length === 1 ? matches[0] : false;
    }, 'one real Views editor');
    await clickReference(driver, editor, 'Views note editor');
    await bounded(driver.sendKeys('.ProseMirror[contenteditable="true"]', '\uE009k'), 'Send Ctrl+K to Views editor');
    const paletteReady = await waitForCondition(async () => driver.execute(`const panel = document.querySelector('.palette[role="dialog"]');
      const input = panel?.querySelector('input[role="combobox"]');
      return panel && input ? { panelCount: document.querySelectorAll('.palette[role="dialog"]').length,
        inputCount: panel.querySelectorAll('input[role="combobox"]').length } : null;`)
      .then((state) => state?.panelCount === 1 && state.inputCount === 1 ? state : false),
    'Ctrl+K command palette');
    const paletteInput = '.palette[role="dialog"] input[role="combobox"]';
    await bounded(driver.clear(paletteInput), 'Clear command palette input');
    await bounded(driver.sendKeys(paletteInput, EXPECTED_COMMAND), 'Type exact Publish command');
    let lastOptionsInventory = [];
    let lastOptionReferences = [];
    let lastPaletteStructure = null;
    let optionSelection;
    const optionWaitDescription = `one visible command palette option with canonical title ${JSON.stringify(EXPECTED_COMMAND)}`;
    try {
      optionSelection = await waitForCondition(async () => {
        const snapshot = await readPaletteOptionInventory(driver);
        lastOptionsInventory = snapshot.inventory;
        lastOptionReferences = snapshot.references;
        lastPaletteStructure = {
          paletteCount: snapshot.paletteCount,
          inputCount: snapshot.inputCount,
          referenceCount: snapshot.referenceCount,
          aligned: snapshot.aligned,
        };
        if (snapshot.paletteCount !== 1 || snapshot.inputCount !== 1 || !snapshot.aligned) return false;

        const match = selectUniqueCanonicalPaletteOption(snapshot.observations);
        if (match.status === 'missing') return false;
        if (match.status === 'ambiguous') return { status: 'ambiguous', snapshot, match };

        const reference = match.reference;
        try {
          const getAggregate = await readPaletteOptionGetAggregate(
            driver,
            reference,
            performance.now() + CLEANUP_TIMEOUT_MS,
          );
          snapshot.inventory[match.index].getAggregate = getAggregate;
          snapshot.inventory[match.index].getAggregateType = typeof getAggregate;
          lastOptionsInventory = snapshot.inventory;
          return { status: 'selected', snapshot, match, reference };
        } catch (error) {
          snapshot.inventory[match.index].getAggregateError = error instanceof Error ? error.message : String(error);
          lastOptionsInventory = snapshot.inventory;
          return { status: 'get-error', snapshot, match, error };
        }
      }, optionWaitDescription);
    } catch (error) {
      // Keep the original wait error; bounded GET observations and step recording
      // add evidence without changing the failure that ended the wait.
      const diagnosticError = await recordPaletteFailureDiagnostic(
        driver,
        lastOptionReferences,
        lastOptionsInventory,
        recordStep,
        'independent-182-publish-palette-timeout-options',
        {
          error: error instanceof Error ? error.message : String(error),
          palette: paletteReady,
          observedPalette: lastPaletteStructure,
          optionCount: lastOptionReferences.length,
        },
      );
      if (error && typeof error === 'object') {
        error.lastOptionsInventory = { ...lastPaletteStructure, options: lastOptionsInventory };
        if (diagnosticError) error.optionsInventoryDiagnosticError = diagnosticError;
      }
      throw error;
    }

    if (optionSelection.status !== 'selected') {
      const message = optionSelection.status === 'ambiguous'
        ? `Expected one visible canonical title ${JSON.stringify(EXPECTED_COMMAND)}, found ${optionSelection.match.indexes.length}.`
        : `Could not read the WebDriver text for the exact canonical title ${JSON.stringify(EXPECTED_COMMAND)}.`;
      const error = new Error(message);
      lastOptionsInventory = optionSelection.snapshot.inventory;
      lastPaletteStructure = {
        paletteCount: optionSelection.snapshot.paletteCount,
        inputCount: optionSelection.snapshot.inputCount,
        referenceCount: optionSelection.snapshot.referenceCount,
        aligned: optionSelection.snapshot.aligned,
      };
      error.lastOptionsInventory = { ...lastPaletteStructure, options: lastOptionsInventory };
      const diagnosticError = await recordPaletteFailureDiagnostic(
        driver,
        optionSelection.snapshot.references,
        lastOptionsInventory,
        recordStep,
        'independent-182-publish-palette-selection-diagnostic',
        {
          error: message,
          palette: paletteReady,
          observedPalette: lastPaletteStructure,
          optionCount: optionSelection.snapshot.references.length,
        },
      );
      if (diagnosticError) error.optionsInventoryDiagnosticError = diagnosticError;
      throw error;
    }
    const optionHandles = {
      selected: optionSelection.reference,
      options: optionSelection.snapshot.references,
      inventory: optionSelection.snapshot.inventory,
    };
    const paletteEvidencePath = await bounded(() => evidencePath(candidate, 'native-export-independent-command-palette.png'), 'Resolve command palette evidence path');
    await bounded(() => driver.screenshot(paletteEvidencePath), 'Capture command palette screenshot');
    evidence.commandPalette = {
      ...paletteReady,
      exactCommand: EXPECTED_COMMAND,
      paletteCount: optionSelection.snapshot.paletteCount,
      inputCount: optionSelection.snapshot.inputCount,
      referencesAligned: optionSelection.snapshot.aligned,
      optionCount: optionHandles.options.length,
      options: optionHandles.inventory,
    };
    await recordBounded(recordStep, 'independent-182-exact-publish-command-ready', {
      command: EXPECTED_COMMAND,
      matchingOptionCount: 1,
      paletteCount: optionSelection.snapshot.paletteCount,
      inputCount: optionSelection.snapshot.inputCount,
      referencesAligned: optionSelection.snapshot.aligned,
      optionCount: optionHandles.options.length,
      options: optionHandles.inventory,
      screenshot: paletteEvidencePath,
    });

    const installResult = await installCapture(driver);
    captureInstalled = true;
    evidence.captureInstalled = true;
    evidence.publicSaveFileDescriptor = installResult;
    await recordBounded(recordStep, 'independent-182-public-savefile-canceller-installed', installResult);

    // Mark the attempt before the real click. From here on, any ambiguous outcome
    // must leave the canceller installed until the common runner closes the app.
    await markPublishStarted(driver);
    publishStarted = true;
    evidence.publishStarted = true;
    evidence.publishClickAttemptedAt = new Date().toISOString();
    await clickReference(driver, optionHandles.selected, 'exact Publish everything as a website command');
    await recordBounded(recordStep, 'independent-182-real-publish-command-clicked', {
      command: EXPECTED_COMMAND,
      publishStarted,
      saveFileOriginalInvoked: false,
    });

    let captured;
    try {
      captured = await awaitCapturedBytes(driver);
    } catch (error) {
      watchdogExpired = error?.watchdogExpired === true;
      evidence.watchdogExpired = watchdogExpired;
      captureStateBeforeFinalize = error?.captureState ?? null;
      throw error;
    }
    captureStateBeforeFinalize = captured;
    requireThat(captured.invocationCount === 1 && captured.extraCallCount === 0 && captured.invalidCallCount === 0,
      `Public saveFile must be called exactly once with a valid payload; observed ${JSON.stringify(compactCapture(captured))}.`);
    requireThat(captured.capture && typeof captured.capture.bytesBase64 === 'string', 'The public saveFile call did not provide capturable bytes.');
    requireThat(/\.zip$/i.test(captured.capture.name) && captured.capture.name.toLowerCase().includes('website'),
      `The public saveFile name is not a website ZIP: ${JSON.stringify(captured.capture.name)}.`);
    archiveBytes = Buffer.from(captured.capture.bytesBase64, 'base64');
    requireThat(archiveBytes.byteLength === captured.capture.byteLength
      && archiveBytes.toString('base64') === captured.capture.bytesBase64,
    'The one-shot byte copy did not round-trip as an exact ArrayBuffer.');
    const archiveSha = hashBytes(archiveBytes);
    zipEvidenceFile = await bounded(() => evidencePath(candidate, 'native-export-independent-website.zip'), 'Resolve website ZIP evidence path');
    await bounded(() => writeFile(zipEvidenceFile, archiveBytes, { flag: 'wx', mode: 0o600 }), 'Retain captured website ZIP');
    evidence.capture = {
      name: captured.capture.name,
      byteLength: captured.capture.byteLength,
      sha256: archiveSha,
      capturedAt: captured.capture.capturedAt,
      invocationCount: captured.invocationCount,
      extraCallCount: captured.extraCallCount,
      invalidCallCount: captured.invalidCallCount,
      publicOriginalInvoked: false,
      evidenceFile: zipEvidenceFile,
    };
    await recordBounded(recordStep, 'independent-182-real-website-zip-captured-on-public-sink', evidence.capture);

    const archiveResult = examineWebsiteArchive(archiveBytes);
    const retainedHtml = await retainWebsiteHtml(candidate, archiveResult.htmlFiles);
    const archiveCheck = { ...archiveResult.summary, retainedHtml };
    evidence.archive = archiveCheck;
    await recordBounded(recordStep, 'independent-182-zip-html-inventory-literal-verified', {
      entryCount: archiveCheck.entryCount,
      htmlPageCount: archiveCheck.htmlPageCount,
      inventory: archiveCheck.inventory,
      htmlDigests: archiveCheck.htmlDigests,
      retainedHtml: archiveCheck.retainedHtml.files,
      formulaLiteral: EXPECTED_FORMULA,
      totalCellMustEqualLiteral: true,
    });

    const afterMarkdown = await markdownSnapshot(vaultRoot);
    sameContent(initialMarkdown, afterMarkdown, 'Website export must preserve the synthetic Markdown files');
    const configAfter = await readSyntheticFile(vaultRoot, '.morrow/plugins.json');
    requireThat(configAfter.sha256 === originalConfig.sha256 && configAfter.size === originalConfig.size,
      'Website export must not change the synthetic plugin configuration.');
    evidence.finalMarkdown = afterMarkdown;
    evidence.finalPluginConfiguration = { sha256: configAfter.sha256, size: configAfter.size };
    await recordBounded(recordStep, 'independent-182-export-left-source-markdown-and-plugin-config-unchanged', {
      markdown: afterMarkdown,
      pluginConfigSha256Before: originalConfig.sha256,
      pluginConfigSha256After: configAfter.sha256,
    });
    evidence.result = 'passed';
  } catch (error) {
    failure = error;
    evidence.failure = {
      message: error instanceof Error ? error.message : String(error),
      ...(error?.lastOptionsInventory ? { lastOptionsInventory: error.lastOptionsInventory } : {}),
      ...(error?.optionsInventoryDiagnosticError ? { optionsInventoryDiagnosticError: error.optionsInventoryDiagnosticError } : {}),
    };
    if (captureInstalled && !captureStateBeforeFinalize) {
      try {
        captureStateBeforeFinalize = await readCapture(driver, false);
      } catch (readError) {
        evidence.failure.captureReadError = readError instanceof Error ? readError.message : String(readError);
      }
    }
    try {
      const diagnosticPath = await bounded(() => evidencePath(candidate, 'native-export-independent-failure.png'), 'Resolve export failure screenshot path');
      await bounded(() => driver.screenshot(diagnosticPath), 'Capture export failure screenshot');
      evidence.failure.screenshot = diagnosticPath;
    } catch (screenshotError) {
      evidence.failure.screenshotError = screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
    }
    try {
      await recordBounded(recordStep, 'independent-182-export-failure-captured', {
        error: evidence.failure.message,
        publishStarted,
        watchdogExpired,
        capture: compactCapture(captureStateBeforeFinalize),
        zipEvidenceFile,
      });
    } catch {
      // Preserve the original scenario failure; the runner also captures its own run error.
    }
  } finally {
    if (captureInstalled) {
      try {
        const finalCaptureState = await finishCapture(driver, publishStarted, watchdogExpired);
        evidence.finalCaptureState = compactCapture(finalCaptureState);
        evidence.deferredRestore = finalCaptureState?.deferredRestore === true;
        evidence.restoreStatus = finalCaptureState?.restoreStatus ?? 'unknown';
        await recordBounded(recordStep, 'independent-182-public-savefile-finalized', {
          publishStarted,
          watchdogExpired,
          deferredRestore: evidence.deferredRestore,
          restoreStatus: evidence.restoreStatus,
          invocationCount: finalCaptureState?.invocationCount ?? null,
          extraCallCount: finalCaptureState?.extraCallCount ?? null,
          originalInvoked: false,
        });
      } catch (finalizeError) {
        evidence.finalizationError = finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
        if (publishStarted) {
          evidence.deferredRestore = true;
          evidence.restoreStatus = 'deferred-until-common-runner-app-shutdown-finalization-unconfirmed';
        }
        if (!failure) failure = finalizeError;
      }
    }
  }

  if (!failure && (!publishStarted || !evidence.deferredRestore || evidence.restoreStatus !== 'deferred-until-common-runner-app-shutdown')) {
    failure = new Error('A successful Publish must leave the public saveFile canceller installed until common-runner shutdown.');
  }
  if (!failure && (!evidence.archive?.inventory?.table || evidence.archive.inventory.table.total !== EXPECTED_FORMULA)) {
    failure = new Error('The captured website did not preserve the exact literal Total formula in Inventory.html.');
  }
  if (failure) {
    evidence.result = 'failed';
    evidence.failure ??= { message: failure instanceof Error ? failure.message : String(failure) };
  }
  try {
    await bounded(() => writeIndependentEvidence(candidate, evidence), 'Write final independent export evidence');
  } catch (writeError) {
    if (!failure) failure = writeError;
  }
  if (failure) throw failure;
  return {
    capture: evidence.capture,
    archive: evidence.archive,
    widgetPageReadOnly: evidence.widgetPageReadOnly,
    deferredRestore: evidence.deferredRestore,
    reportPath: evidence.reportPath,
  };
}
