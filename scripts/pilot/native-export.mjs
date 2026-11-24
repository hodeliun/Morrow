#!/usr/bin/env node

// Isolated native UI proof for the row formula and website export. The only
// intercepted product boundary is the existing public window.morrow.saveFile.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { Window } from 'happy-dom';

const CAPTURE_KEY = '__morrowE182SaveFileCapture';
const WAIT_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const FORMULA = 'Quantity * Price';
const PUBLISH_COMMAND = 'Publish everything as a website';

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function watchdogError(label) {
  const error = new Error(`Timed out waiting for ${label}.`);
  error.watchdogExpired = true;
  return error;
}

export async function withAbsoluteDeadline(operation, deadlineAt, label) {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw watchdogError(label);

  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(watchdogError(label)), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function observeAndFinalizeCapture(readState, finalizeCapture, deadlineAt) {
  let state = null;
  try {
    state = await withAbsoluteDeadline(readState, deadlineAt, 'public saveFile capture cleanup observation');
    const finalized = await withAbsoluteDeadline(
      () => finalizeCapture(state),
      deadlineAt,
      'public saveFile capture cleanup finalization',
    );
    return { state, finalized };
  } catch (error) {
    if (state && error && typeof error === 'object') error.captureState = state;
    throw error;
  }
}

// This function is serialized into the WebView by the test runner. Keep it
// self-contained so the wrapper is the same code tested below and never calls
// the captured original, including malformed, repeated, or reentrant calls.
export function installPublicSaveFileCapture(bridge, stateTarget, stateKey) {
  if (!bridge || (typeof bridge !== 'object' && typeof bridge !== 'function')) {
    throw new Error('The public window.morrow bridge is unavailable before export UI.');
  }
  if (!stateTarget || typeof stateKey !== 'string' || !stateKey) {
    throw new Error('The export capture state target is invalid.');
  }
  if (Object.hasOwn(stateTarget, stateKey)) throw new Error('The isolated export capture key is already occupied.');
  if (!Object.isExtensible(stateTarget)) throw new Error('The isolated export capture state target is not extensible.');

  const ownDescriptor = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
  let originalDescriptor = ownDescriptor;
  let originalOwner = bridge;
  let ownerDepth = 0;
  if (!originalDescriptor) {
    originalOwner = Object.getPrototypeOf(bridge);
    ownerDepth = 1;
    while (originalOwner && !(originalDescriptor = Object.getOwnPropertyDescriptor(originalOwner, 'saveFile'))) {
      originalOwner = Object.getPrototypeOf(originalOwner);
      ownerDepth += 1;
    }
  }
  if (!originalDescriptor || !Object.hasOwn(originalDescriptor, 'value') || typeof originalDescriptor.value !== 'function') {
    throw new Error('The public saveFile descriptor is missing, accessor-backed, or not callable.');
  }
  if (ownDescriptor && ownDescriptor.configurable === false && ownDescriptor.writable !== true) {
    throw new Error('The own public saveFile descriptor cannot be patched safely.');
  }
  if (!ownDescriptor && !Object.isExtensible(bridge)) {
    throw new Error('The public bridge cannot accept a temporary saveFile shadow.');
  }

  const descriptor = originalDescriptor ? {
    ownerDepth,
    configurable: originalDescriptor.configurable,
    enumerable: originalDescriptor.enumerable,
    writable: Object.hasOwn(originalDescriptor, 'writable') ? originalDescriptor.writable : null,
    accessor: !Object.hasOwn(originalDescriptor, 'value'),
    valueType: Object.hasOwn(originalDescriptor, 'value') ? typeof originalDescriptor.value : null,
    valueName: typeof originalDescriptor.value === 'function' ? originalDescriptor.value.name : null,
    hasGetter: typeof originalDescriptor.get === 'function',
    hasSetter: typeof originalDescriptor.set === 'function',
  } : null;
  const state = {
    installed: false,
    ownerKind: ownDescriptor ? 'own' : 'prototype',
    descriptor,
    invocationCount: 0,
    extraCalls: 0,
    reentrantCalls: 0,
    invalidCalls: 0,
    firstCallSeen: false,
    inCall: false,
    capture: null,
    captureError: null,
    publishStarted: false,
    watchdogExpired: false,
    deferredRestore: false,
    restoreStatus: 'not-requested',
    installedAt: new Date().toISOString(),
    original: originalDescriptor.value,
    wrapper: null,
    restore: null,
  };
  const resolvePromise = Promise.resolve.bind(Promise);
  const cancelled = () => resolvePromise({ ok: false, error: null });
  const toBase64 = (bytes) => {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  };
  const wrapper = function morrowExportSaveFileCancel(name, data) {
    state.invocationCount += 1;
    if (state.inCall) {
      state.reentrantCalls += 1;
      state.extraCalls += 1;
      return cancelled();
    }
    if (state.firstCallSeen) {
      state.extraCalls += 1;
      return cancelled();
    }
    state.firstCallSeen = true;
    state.inCall = true;
    try {
      if (typeof name !== 'string' || !(data instanceof ArrayBuffer)) {
        state.invalidCalls += 1;
        state.captureError = 'saveFile did not receive a string name and ArrayBuffer.';
        return cancelled();
      }
      const copiedBytes = new Uint8Array(new Uint8Array(data));
      state.capture = {
        name,
        byteLength: copiedBytes.byteLength,
        bytesBase64: toBase64(copiedBytes),
        capturedAt: new Date().toISOString(),
      };
      return cancelled();
    } catch (error) {
      state.captureError = error instanceof Error ? error.message : String(error);
      return cancelled();
    } finally {
      state.inCall = false;
    }
  };
  state.wrapper = wrapper;
  state.restore = () => {
    const current = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
    if (!current || current.value !== wrapper) {
      state.restoreStatus = 'skipped-current-descriptor-changed';
      return false;
    }
    const sameDescriptor = (left, right) => Boolean(
      left && right &&
      left.configurable === right.configurable &&
      left.enumerable === right.enumerable &&
      (Object.hasOwn(left, 'value') === Object.hasOwn(right, 'value')) &&
      (Object.hasOwn(left, 'value') ? left.value === right.value && left.writable === right.writable : left.get === right.get && left.set === right.set),
    );
    try {
      if (ownDescriptor) Object.defineProperty(bridge, 'saveFile', ownDescriptor);
      else if (!Reflect.deleteProperty(bridge, 'saveFile')) {
        state.restoreStatus = 'failed-to-delete-temporary-shadow';
        return false;
      }
      const restored = Object.getOwnPropertyDescriptor(bridge, 'saveFile');
      const matchesOriginal = ownDescriptor
        ? sameDescriptor(restored, ownDescriptor)
        : restored === undefined && sameDescriptor(Object.getOwnPropertyDescriptor(originalOwner, 'saveFile'), originalDescriptor);
      state.restoreStatus = matchesOriginal ? 'restored-original-descriptor' : 'restored-conditionally-with-prototype-visible';
      return true;
    } catch (error) {
      state.restoreStatus = `restore-failed:${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  };

  Object.defineProperty(stateTarget, stateKey, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: state,
  });
  try {
    if (ownDescriptor) {
      Object.defineProperty(bridge, 'saveFile', { ...ownDescriptor, value: wrapper });
    } else {
      Object.defineProperty(bridge, 'saveFile', {
        configurable: true,
        enumerable: originalDescriptor.enumerable,
        writable: originalDescriptor.writable,
        value: wrapper,
      });
    }
  } catch (error) {
    Reflect.deleteProperty(stateTarget, stateKey);
    throw new Error(`Could not install the public saveFile cancellation wrapper: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  state.installed = true;
  return {
    installed: true,
    ownerKind: state.ownerKind,
    descriptor: state.descriptor,
    originalName: originalDescriptor.value.name,
  };
}

export function summarizeSaveFileCapture(state) {
  if (!state) return null;
  return {
    installed: state.installed === true,
    ownerKind: state.ownerKind,
    descriptor: state.descriptor,
    invocationCount: state.invocationCount,
    extraCalls: state.extraCalls,
    reentrantCalls: state.reentrantCalls,
    invalidCalls: state.invalidCalls,
    firstCallSeen: state.firstCallSeen,
    capture: state.capture
      ? {
          name: state.capture.name,
          byteLength: state.capture.byteLength,
          bytesBase64: state.capture.bytesBase64,
          capturedAt: state.capture.capturedAt,
        }
      : null,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    installedAt: state.installedAt,
  };
}

export function finalizeSaveFileCapture(bridge, stateTarget, stateKey, publishStarted, watchdogExpired = false) {
  const state = stateTarget?.[stateKey];
  if (!state || !state.installed) throw new Error('The installed public saveFile capture state is missing.');
  state.publishStarted = publishStarted === true;
  state.watchdogExpired = state.watchdogExpired || watchdogExpired === true;
  if (state.publishStarted) {
    state.deferredRestore = true;
    state.restoreStatus = 'deferred-until-isolated-app-teardown';
  } else {
    state.restore?.();
  }
  return {
    installed: state.installed === true,
    ownerKind: state.ownerKind,
    descriptor: state.descriptor,
    invocationCount: state.invocationCount,
    extraCalls: state.extraCalls,
    reentrantCalls: state.reentrantCalls,
    invalidCalls: state.invalidCalls,
    firstCallSeen: state.firstCallSeen,
    capture: state.capture
      ? { name: state.capture.name, byteLength: state.capture.byteLength, bytesBase64: state.capture.bytesBase64, capturedAt: state.capture.capturedAt }
      : null,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    installedAt: state.installedAt,
  };
}

export async function waitForSaveFileCapture(readState, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS } = {}) {
  const deadline = performance.now() + timeoutMs;
  let latest = null;
  while (performance.now() < deadline) {
    try {
      latest = await withAbsoluteDeadline(readState, deadline, 'the real website ZIP at public window.morrow.saveFile');
    } catch (error) {
      if (error?.watchdogExpired) {
        const timeoutError = watchdogError('the real website ZIP at public window.morrow.saveFile');
        timeoutError.captureState = latest;
        throw timeoutError;
      }
      throw error;
    }
    if (performance.now() >= deadline) {
      const timeoutError = watchdogError('the real website ZIP at public window.morrow.saveFile');
      timeoutError.captureState = latest;
      throw timeoutError;
    }
    if (latest?.capture) return latest;
    if (latest?.captureError) throw new Error(`The public saveFile sink rejected its payload: ${latest.captureError}`);
    if (performance.now() >= deadline) break;
    try {
      await withAbsoluteDeadline(
        () => new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - performance.now())))),
        deadline,
        'the real website ZIP at public window.morrow.saveFile',
      );
    } catch (error) {
      if (error?.watchdogExpired) break;
      throw error;
    }
  }
  const error = watchdogError('the real website ZIP at public window.morrow.saveFile');
  error.captureState = latest;
  throw error;
}

export function inspectInventoryHtml(html, filename = 'Inventory.html') {
  if (typeof html !== 'string') fail('Inventory HTML must be decoded text.');
  const parserWindow = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  try {
    const document = new parserWindow.DOMParser().parseFromString(html, 'text/html');
    const fallbackText = [...document.querySelectorAll('.provider-fallback')]
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .find((text) => text.includes('This export is read only.') && text.includes('formula cells show their source.')) ?? null;
    if (!fallbackText) fail(`${filename}: missing the provider's read-only export fallback note.`);
    const controls = document.querySelectorAll('input, textarea, select, button, [contenteditable="true"], script').length;
    if (controls !== 0) fail(`${filename}: exported provider page contains ${controls} interactive control(s) or scripts.`);

    const requiredHeaders = ['Name', 'Quantity', 'Price', 'Total'];
    const matches = [];
    const headerInventories = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.querySelectorAll('tr')];
      const headerIndex = rows.findIndex((row) => row.querySelector('th'));
      if (headerIndex < 0) continue;
      const headers = [...rows[headerIndex].querySelectorAll('th')].map((cell) => cell.textContent?.trim() ?? '');
      if (requiredHeaders.some((header) => !headers.includes(header))) {
        headerInventories.push(headers);
        continue;
      }
      const totalIndex = headers.indexOf('Total');
      const quantityIndex = headers.indexOf('Quantity');
      const priceIndex = headers.indexOf('Price');
      const widgetRows = rows.slice(headerIndex + 1).filter((row) => {
        const cells = [...row.querySelectorAll('th, td')];
        return cells[0]?.textContent?.trim() === 'Widget';
      });
      if (widgetRows.length !== 1) continue;
      const cells = [...widgetRows[0].querySelectorAll('th, td')];
      matches.push({
        headers,
        quantity: cells[quantityIndex]?.textContent?.trim() ?? null,
        price: cells[priceIndex]?.textContent?.trim() ?? null,
        total: cells[totalIndex]?.textContent?.trim() ?? null,
      });
    }
    if (matches.length !== 1) {
      const suffix = matches.length === 0 ? `; observed headers: ${JSON.stringify(headerInventories)}` : '';
      fail(`${filename}: expected one Inventory table with Name/Quantity/Price/Total headers and one Widget row, found ${matches.length}${suffix}.`);
    }
    const inventory = matches[0];
    if (inventory.quantity !== '2' || inventory.price !== '10') {
      fail(`${filename}: exported Widget values changed: ${JSON.stringify(inventory)}.`);
    }
    if (inventory.total !== FORMULA) {
      fail(`${filename}: Total cell must contain only the literal formula ${JSON.stringify(FORMULA)}, got ${JSON.stringify(inventory.total)}.`);
    }
    return {
      filename,
      title: document.querySelector('title')?.textContent?.trim() ?? null,
      fallbackText,
      interactiveControlCount: controls,
      inventoryTable: inventory,
    };
  } finally {
    parserWindow.close();
  }
}

export function extractWebsiteHtml(zipBytes) {
  const archive = unzipSync(zipBytes);
  const htmlFiles = Object.entries(archive)
    .filter(([name]) => /\.html$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => ({ name, bytes }));
  if (!htmlFiles.length) fail('The captured website ZIP contains no HTML pages.');
  return htmlFiles;
}

export function inspectWebsiteHtmlFiles(htmlFiles) {
  const inventoryFiles = htmlFiles.filter((file) => path.posix.basename(file.name).toLowerCase() === 'inventory.html');
  if (inventoryFiles.length !== 1) {
    fail(`The captured website ZIP must contain one Inventory.html page, found ${inventoryFiles.length}.`);
  }
  const htmlInventory = htmlFiles.map(({ name, bytes }) => ({ name, size: bytes.byteLength, sha256: sha256(bytes) }));
  const { name: inventoryName, bytes: inventoryBytes } = inventoryFiles[0];
  const parsedInventory = inspectInventoryHtml(new TextDecoder('utf-8', { fatal: true }).decode(inventoryBytes), inventoryName);
  return { htmlInventory, inventory: parsedInventory };
}

export function inspectWebsiteZip(zipBytes) {
  return inspectWebsiteHtmlFiles(extractWebsiteHtml(zipBytes));
}

function elementId(element) {
  const value = element?.[ELEMENT_KEY] ?? element?.ELEMENT;
  if (typeof value !== 'string' || !value) fail('WebDriver returned an element without a W3C element ID.');
  return value;
}

async function clickElement(driver, element) {
  await driver.request('POST', driver.path(`/element/${elementId(element)}/click`), {});
}

async function sendKeysToElement(driver, element, text) {
  await driver.request('POST', driver.path(`/element/${elementId(element)}/value`), { text, value: [...text] });
}

async function waitFor(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  const suffix = lastError ? `; last error: ${lastError?.message ?? lastError}` : '';
  fail(`Timed out waiting for ${label}${suffix}`);
}

function findPathId(root, wantedPath) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && value.path === wantedPath && typeof value.id === 'string') return value.id;
    for (const [key, child] of Object.entries(value)) {
      if (key === wantedPath && child && typeof child === 'object' && typeof child.id === 'string') return child.id;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

async function readFixtureIds(vault) {
  const workspace = JSON.parse(await readFile(path.join(vault, '.morrow', 'workspace.json'), 'utf8'));
  const rowId = findPathId(workspace, 'Inventory/Widget.md');
  const sourceId = findPathId(workspace, 'Inventory.md');
  const noteId = findPathId(workspace, 'Views.md');
  if (!rowId || !sourceId || !noteId) fail('The synthetic workspace is missing Widget, Inventory, or Views IDs.');
  return { rowId, sourceId, noteId };
}

async function captureFixture(vault) {
  const result = {};
  for (const relative of ['Inventory.md', 'Inventory/Widget.md']) {
    const file = path.join(vault, relative);
    const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    result[relative] = { sha256: sha256(bytes), size: info.size, mtimeMs: info.mtimeMs };
  }
  return result;
}

export async function retainWebsiteHtml(candidate, htmlFiles) {
  const root = path.join(candidate.evidence, 'native-export-html');
  await mkdir(root, { recursive: false, mode: 0o700 });
  const files = [];
  for (const entry of htmlFiles) {
    const archivePath = entry.name;
    if (typeof archivePath !== 'string' || archivePath.includes('\\') || path.posix.isAbsolute(archivePath)) {
      fail(`The website ZIP contains an unsafe HTML path: ${JSON.stringify(archivePath)}.`);
    }
    const segments = archivePath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      fail(`The website ZIP contains an unsafe HTML path: ${JSON.stringify(archivePath)}.`);
    }
    const destination = path.resolve(root, ...segments);
    const relative = path.relative(root, destination);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(`The website ZIP HTML escaped its evidence directory: ${JSON.stringify(archivePath)}.`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
    const copied = await readFile(destination);
    const digest = sha256(entry.bytes);
    if (copied.byteLength !== entry.bytes.byteLength || sha256(copied) !== digest) {
      fail(`Retained HTML bytes differ from the website ZIP entry ${archivePath}.`);
    }
    files.push({ archiveName: archivePath, path: destination, size: copied.byteLength, sha256: digest });
  }
  return { directory: root, files };
}

async function assertLiteralFixture(vault) {
  const schema = await readFile(path.join(vault, 'Inventory.md'), 'utf8');
  const row = await readFile(path.join(vault, 'Inventory', 'Widget.md'), 'utf8');
  const formula = schema.match(/^[ \t]*formula:[ \t]*(.*?)[ \t]*$/m)?.[1] ?? null;
  const quantity = row.match(/^[ \t]*Quantity:[ \t]*(.*?)[ \t]*$/m)?.[1] ?? null;
  const price = row.match(/^[ \t]*Price:[ \t]*(.*?)[ \t]*$/m)?.[1] ?? null;
  if (formula !== FORMULA || quantity !== '2' || price !== '10') {
    fail(`Synthetic Inventory fixture no longer has the exact literal source values: ${JSON.stringify({ formula, quantity, price })}`);
  }
  return { formula, quantity, price };
}

async function navigateToPage(driver, pageId, label, expectedText) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [pageId]);
  return waitFor(async () => {
    const state = await driver.execute(`return {
      title: document.querySelector('textarea.page-title')?.value ?? null,
      editorCount: document.querySelectorAll('.ProseMirror[contenteditable="true"]').length,
      editorText: document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText ?? '',
      rowProps: document.querySelectorAll('.row-props .row-prop').length,
    }`);
    return state.title === expectedText || (expectedText === 'Views' && state.editorCount === 1 && state.editorText.includes('linked views'))
      ? state
      : false;
  }, label);
}

async function inspectLiveWidgetRow(driver, rowId) {
  await driver.execute(`location.hash = '#/page/' + encodeURIComponent(arguments[0]);`, [rowId]);
  const state = await waitFor(async () => {
    const current = await driver.execute(`const title = document.querySelector('textarea.page-title');
      const rows = [...document.querySelectorAll('.row-props .row-prop')];
      const properties = Object.fromEntries(rows.map((row) => [
        row.querySelector('.row-prop-name')?.textContent?.trim() ?? '',
        row.querySelector('.row-prop-value')?.textContent?.trim() ?? '',
      ]));
      return {
        title: title?.value ?? null,
        titleReadonly: title?.readOnly ?? false,
        editablePropertyNames: document.querySelectorAll('.row-props .row-prop-name.row-prop-button').length,
        propertyEditors: document.querySelectorAll('.row-props input, .row-props textarea, .row-props select, .row-props .row-prop-actions button').length,
        providerLinkCount: document.querySelectorAll('.row-props-provider-link').length,
        formulaLiteral: document.querySelector('.formula-source-literal')?.textContent?.trim() ?? null,
        formulaLiteralCount: document.querySelectorAll('.formula-source-literal').length,
        properties,
      };`);
    return current.title === 'Widget' ? current : false;
  }, 'real Widget row properties page');
  if (
    !state.titleReadonly ||
    state.editablePropertyNames !== 0 ||
    state.propertyEditors !== 0 ||
    state.providerLinkCount !== 1 ||
    state.properties.Quantity !== '2' ||
    state.properties.Price !== '10' ||
    state.properties.Total !== FORMULA ||
    state.formulaLiteral !== FORMULA ||
    state.formulaLiteralCount !== 1
  ) {
    fail(`Widget row page did not show the opted-in literal formula as read-only: ${JSON.stringify(state)}`);
  }
  return state;
}

async function installCaptureInWebView(driver) {
  return driver.execute(`return (${installPublicSaveFileCapture.toString()})(window.morrow, window, arguments[0]);`, [CAPTURE_KEY]);
}

async function readCaptureState(driver) {
  return driver.execute(`return (${summarizeSaveFileCapture.toString()})(window[arguments[0]]);`, [CAPTURE_KEY]);
}

async function finalizeCaptureInWebView(driver, publishStarted, watchdogExpired = false) {
  return driver.execute(`return (${finalizeSaveFileCapture.toString()})(window.morrow, window, arguments[0], arguments[1], arguments[2]);`, [CAPTURE_KEY, publishStarted, watchdogExpired]);
}

async function openPublishPalette(driver, evidence, recordStep) {
  const editors = await driver.elements('.ProseMirror[contenteditable="true"]');
  if (editors.length !== 1) fail(`Expected one real note editor before Ctrl+K, got ${editors.length}.`);
  await sendKeysToElement(driver, editors[0], '\uE009k');
  const input = await waitFor(async () => {
    const found = await driver.elements('.palette[role="dialog"] input[role="combobox"]');
    return found.length === 1 ? found[0] : false;
  }, 'Ctrl+K command palette');
  await clickElement(driver, input);
  await sendKeysToElement(driver, input, '\uE009a');
  await sendKeysToElement(driver, input, PUBLISH_COMMAND);
  const titles = await waitFor(async () => {
    const found = await driver.execute(`return [...document.querySelectorAll('.palette-item[role="option"] .palette-item-title')]
      .map((item) => item.textContent?.trim() ?? '')`);
    return found.includes(PUBLISH_COMMAND) ? found : false;
  }, `exact palette command ${JSON.stringify(PUBLISH_COMMAND)}`);
  const index = titles.indexOf(PUBLISH_COMMAND);
  if (index < 0 || titles.lastIndexOf(PUBLISH_COMMAND) !== index) {
    fail(`The command palette did not expose exactly one exact ${JSON.stringify(PUBLISH_COMMAND)} entry.`);
  }
  const options = await driver.elements('.palette-item[role="option"]');
  if (options.length !== titles.length) fail('Command palette title and option inventories diverged.');
  await driver.screenshot(path.join(evidence, 'native-export-command-palette.png'));
  await recordStep('export-exact-publish-command-ready', { command: PUBLISH_COMMAND, optionCount: options.length, index });
  return options[index];
}

async function writeScenarioEvidence(candidate, evidence) {
  await writeFile(path.join(candidate.evidence, 'native-export-scenario.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
}

function publicCaptureEvidence(state) {
  if (!state) return null;
  return {
    installed: state.installed,
    ownerKind: state.ownerKind,
    descriptor: state.descriptor,
    invocationCount: state.invocationCount,
    extraCalls: state.extraCalls,
    reentrantCalls: state.reentrantCalls,
    invalidCalls: state.invalidCalls,
    firstCallSeen: state.firstCallSeen,
    captureError: state.captureError,
    publishStarted: state.publishStarted,
    watchdogExpired: state.watchdogExpired,
    deferredRestore: state.deferredRestore,
    restoreStatus: state.restoreStatus,
    installedAt: state.installedAt,
    capture: state.capture ? {
      name: state.capture.name,
      byteLength: state.capture.byteLength,
      sha256: state.capture.bytesBase64 ? sha256(Buffer.from(state.capture.bytesBase64, 'base64')) : null,
      capturedAt: state.capture.capturedAt,
    } : null,
  };
}

export async function runNativeExportScenario({ driver, candidate, prepared, recordStep }) {
  if (!driver || !candidate?.vault || !candidate?.databaseId || !candidate?.evidence || !prepared?.bankBefore || typeof recordStep !== 'function') {
    fail('The native website export scenario requires the isolated driver, prepared candidate, and evidence callback.');
  }
  if (candidate.databaseId !== findPathId(JSON.parse(await readFile(path.join(candidate.vault, '.morrow', 'workspace.json'), 'utf8')), 'Inventory.md')) {
    fail('Candidate Inventory.md ID differs from the prepared synthetic workspace.');
  }

  const ids = await readFixtureIds(candidate.vault);
  const literalFixture = await assertLiteralFixture(candidate.vault);
  const fixtureBefore = await captureFixture(candidate.vault);
  for (const relative of Object.keys(fixtureBefore)) {
    const preparedFile = prepared.bankBefore[relative];
    if (!preparedFile || preparedFile.hash !== fixtureBefore[relative].sha256 || preparedFile.size !== fixtureBefore[relative].size || preparedFile.mtimeMs !== fixtureBefore[relative].mtimeMs) {
      fail(`Prepared source baseline differs from the current synthetic fixture for ${relative}.`);
    }
  }

  let publishStarted = false;
  let captureInstalled = false;
  let finalCaptureState = null;
  let archiveEvidence = null;
  let row = null;
  let failure = null;
  let cleanupDeadline = null;
  const cleanupDeadlineAt = () => {
    cleanupDeadline ??= performance.now() + CLEANUP_TIMEOUT_MS;
    return cleanupDeadline;
  };
  const cleanupOperation = (operation, label) => withAbsoluteDeadline(operation, cleanupDeadlineAt(), label);
  try {
    row = await inspectLiveWidgetRow(driver, ids.rowId);
    await driver.screenshot(path.join(candidate.evidence, 'native-export-widget-row.png'));
    await recordStep('export-live-widget-row-literal-readonly', { rowId: ids.rowId, properties: row });

    // Prove descriptor patchability before any palette/UI action that can publish.
    const patch = await installCaptureInWebView(driver);
    captureInstalled = patch?.installed === true;
    if (!captureInstalled || !['own', 'prototype'].includes(patch.ownerKind)) {
      fail(`The public saveFile interception did not install safely: ${JSON.stringify(patch)}`);
    }
    await recordStep('export-public-saveFile-interceptor-installed', patch);

    const note = await navigateToPage(driver, ids.noteId, 'Views.md editor', 'Views');
    if (note.editorCount !== 1) fail('Views.md did not expose one real editor for Ctrl+K.');
    const option = await openPublishPalette(driver, candidate.evidence, recordStep);
    // Set the fail-closed flag before the UI click. A lost WebDriver response
    // after this point is treated as dispatched, so no possible late chooser
    // can reach the original native saveFile method.
    await driver.execute(`window[arguments[0]].publishStarted = true;`, [CAPTURE_KEY]);
    publishStarted = true;
    await clickElement(driver, option);
    await recordStep('export-publish-command-dispatched', { command: PUBLISH_COMMAND, route: 'Ctrl+K command palette' });

    const captured = await waitForSaveFileCapture(() => readCaptureState(driver));
    if (captured.invocationCount !== 1 || captured.extraCalls !== 0 || captured.reentrantCalls !== 0 || captured.invalidCalls !== 0 || captured.capture?.byteLength < 1) {
      fail(`Public saveFile invocation was not a single valid one-shot capture: ${JSON.stringify({ ...captured, capture: captured.capture && { name: captured.capture.name, byteLength: captured.capture.byteLength } })}`);
    }
    const zipBytes = Buffer.from(captured.capture.bytesBase64, 'base64');
    if (zipBytes.byteLength !== captured.capture.byteLength) fail('Captured website ZIP byte length changed during transfer from the WebView.');
    const zipSha256 = sha256(zipBytes);
    if (!captured.capture.name.endsWith('.zip') || !captured.capture.name.includes('-website-')) {
      fail(`Public saveFile received an unexpected website filename: ${JSON.stringify(captured.capture.name)}.`);
    }
    const zipPath = path.join(candidate.evidence, 'native-export-website.zip');
    await writeFile(zipPath, zipBytes, { flag: 'wx', mode: 0o600 });
    archiveEvidence = {
      path: zipPath,
      saveFileName: captured.capture.name,
      size: zipBytes.byteLength,
      sha256: zipSha256,
      htmlFiles: [],
      htmlInventory: [],
      inventory: null,
    };
    const htmlFiles = extractWebsiteHtml(zipBytes);
    const retainedHtml = await retainWebsiteHtml(candidate, htmlFiles);
    archiveEvidence.htmlFiles = retainedHtml.files;
    archiveEvidence.htmlInventory = htmlFiles.map(({ name, bytes }) => ({ name, size: bytes.byteLength, sha256: sha256(bytes) }));
    const inspected = inspectWebsiteHtmlFiles(htmlFiles);
    archiveEvidence.inventory = inspected.inventory;
    await recordStep('export-real-zip-captured-and-parsed-offline', {
      saveFileName: archiveEvidence.saveFileName,
      size: archiveEvidence.size,
      sha256: archiveEvidence.sha256,
      htmlFiles: archiveEvidence.htmlInventory,
      retainedHtmlFiles: retainedHtml.files,
      inventory: inspected.inventory,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const cleanup = await observeAndFinalizeCapture(
      () => readCaptureState(driver),
      () => finalizeCaptureInWebView(driver, true),
      cleanupDeadlineAt(),
    );
    const settledState = cleanup.state;
    if (settledState.invocationCount !== 1 || settledState.extraCalls !== 0 || settledState.reentrantCalls !== 0) {
      fail(`Additional public saveFile calls arrived during the settle window: ${JSON.stringify(publicCaptureEvidence(settledState))}`);
    }
    finalCaptureState = cleanup.finalized;
    const fixtureAfter = await captureFixture(candidate.vault);
    if (JSON.stringify(fixtureAfter) !== JSON.stringify(fixtureBefore)) {
      fail('Opening the row or publishing the synthetic site changed fixture bytes, sizes, or mtimes.');
    }
    if (finalCaptureState.restoreStatus !== 'deferred-until-isolated-app-teardown' || finalCaptureState.deferredRestore !== true) {
      fail('The public saveFile canceller was not retained until isolated app teardown after Publish.');
    }
    await recordStep('export-canceller-deferred-until-app-teardown', {
      publishStarted,
      deferredRestore: finalCaptureState.deferredRestore,
      restoreStatus: finalCaptureState.restoreStatus,
    });
  } catch (error) {
    failure = error;
    if (publishStarted) {
      let observedState;
      try {
        const cleanup = await observeAndFinalizeCapture(
          () => readCaptureState(driver),
          () => finalizeCaptureInWebView(driver, true, Boolean(error?.watchdogExpired)),
          cleanupDeadlineAt(),
        );
        observedState = cleanup.state;
        finalCaptureState = cleanup.finalized;
      } catch (finalizeError) {
        observedState = finalizeError?.captureState ?? null;
        error.finalizeError = finalizeError?.message ?? String(finalizeError);
      }
      if (observedState?.capture?.bytesBase64 && !archiveEvidence) {
        try {
          const bytes = Buffer.from(observedState.capture.bytesBase64, 'base64');
          const zipPath = path.join(candidate.evidence, 'native-export-website-failed.zip');
          await cleanupOperation(() => writeFile(zipPath, bytes, { flag: 'wx', mode: 0o600 }), 'failed website ZIP evidence write');
          archiveEvidence = { path: zipPath, size: bytes.byteLength, sha256: sha256(bytes), capturedOnFailure: true };
        } catch (evidenceError) {
          error.evidenceError = evidenceError?.message ?? String(evidenceError);
        }
      }
    }
  } finally {
    if (captureInstalled && !publishStarted) {
      try {
        finalCaptureState = await cleanupOperation(
          () => finalizeCaptureInWebView(driver, false),
          'pre-publish public saveFile descriptor restoration',
        );
      } catch (restoreError) {
        if (failure) failure.restoreError = restoreError?.message ?? String(restoreError);
        else failure = restoreError;
      }
    }
    let rawState = finalCaptureState;
    if (!rawState && captureInstalled) {
      try {
        rawState = await cleanupOperation(() => readCaptureState(driver), 'final public saveFile capture evidence observation');
      } catch (observationError) {
        if (failure) failure.evidenceObservationError = observationError?.message ?? String(observationError);
        else failure = observationError;
      }
    }
    let fixtureAfter = null;
    try {
      fixtureAfter = await cleanupOperation(() => captureFixture(candidate.vault), 'final synthetic fixture evidence observation');
    } catch (fixtureError) {
      if (failure) failure.fixtureEvidenceError = fixtureError?.message ?? String(fixtureError);
      else failure = fixtureError;
    }
    const safeEvidence = {
      observedAt: new Date().toISOString(),
      scenario: 'export',
      command: { route: 'Ctrl+K command palette', exactEnglishLabel: PUBLISH_COMMAND },
      row: { id: ids.rowId, properties: row },
      fixtureBefore,
      literalFixture,
      fixtureAfter,
      publishStarted,
      sink: publicCaptureEvidence(rawState),
      archive: archiveEvidence,
      outcome: failure ? 'failed' : 'passed',
      error: failure ? String(failure?.stack ?? failure) : null,
      boundary: 'WebView website generation/export through public window.morrow.saveFile; native Rust save_file and chooser were not called or tested.',
    };
    try {
      await cleanupOperation(() => writeScenarioEvidence(candidate, safeEvidence), 'native export scenario evidence write');
    } catch (evidenceError) {
      if (failure) failure.evidenceWriteError = evidenceError?.message ?? String(evidenceError);
      else failure = evidenceError;
    }
  }
  if (failure) throw failure;
}
