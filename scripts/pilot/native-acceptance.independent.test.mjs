// Independent native acceptance coverage for the three complementary locale/theme/zoom combinations.
// This callback owns its assertions and does not import the executor's acceptance helper or tests.
/* global document, window */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const LEGACY_ELEMENT_KEY = 'ELEMENT';
const WEBDRIVER_KEYS = Object.freeze({ Enter: '\uE007', Space: '\uE00D', Escape: '\uE00C' });
const MARKDOWN_PATHS = ['Inventory.md', 'Inventory/Widget.md', 'Views.md'];
const ZOOM_BASELINE_ID = 'pt-light-100';
const WAIT_LIMIT_MS = 25_000;
const POLL_MS = 100;
const COMMAND_LIMIT_MS = 5_000;
const LOCALES = {
  pt: {
    language: 'Idioma',
    languageOption: 'Português',
    settings: 'Configurações',
    general: 'Geral',
    languageSection: 'Idioma e região',
    appearance: 'Aparência',
    plugins: 'Plugins',
    closeSettings: 'Fechar configurações',
    theme: 'Tema',
    light: 'Claro',
    dark: 'Escuro',
    globalPlugins: 'Ativar plugins neste computador',
    providerRegion: 'Polaris Dados',
    databaseRegion: 'Banco de dados',
    quantity: 'Editar Quantity de Widget',
    save: 'Salvar',
    cancel: 'Cancelar',
    hostSaved: 'Salvo',
    hostSaving: 'Salvando…',
  },
  en: {
    language: 'Language',
    languageOption: 'English',
    settings: 'Settings',
    general: 'General',
    languageSection: 'Language and region',
    appearance: 'Appearance',
    plugins: 'Plugins',
    closeSettings: 'Close settings',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    globalPlugins: 'Turn on plugins on this computer',
    providerRegion: 'Polaris Data',
    databaseRegion: 'Database',
    quantity: 'Edit Quantity for Widget',
    save: 'Save',
    cancel: 'Cancel',
    hostSaved: 'Saved',
    hostSaving: 'Saving…',
  },
  es: {
    language: 'Idioma',
    languageOption: 'Español',
    settings: 'Ajustes',
    general: 'General',
    languageSection: 'Idioma y región',
    appearance: 'Apariencia',
    plugins: 'Complementos',
    closeSettings: 'Cerrar ajustes',
    theme: 'Tema',
    light: 'Claro',
    dark: 'Oscuro',
    globalPlugins: 'Activar complementos en este ordenador',
    providerRegion: 'Polaris Datos',
    databaseRegion: 'Base de datos',
    quantity: 'Editar Quantity para Widget',
    save: 'Guardar',
    cancel: 'Cancelar',
    hostSaved: 'Guardado',
    hostSaving: 'Guardando…',
  },
};
const COMBINATIONS = [
  { id: 'pt-light-100', locale: 'pt', theme: 'light', targetZoomPercent: 100 },
  { id: 'en-light-150', locale: 'en', theme: 'light', targetZoomPercent: 150 },
  { id: 'es-dark-125', locale: 'es', theme: 'dark', targetZoomPercent: 125 },
];

function fail(message) {
  throw new Error(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, label, timeoutMs = COMMAND_LIMIT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(read, predicate, label, timeoutMs = WAIT_LIMIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      lastValue = await bounded(
        Promise.resolve().then(read),
        label + ' observation',
        Math.min(COMMAND_LIMIT_MS, remaining),
      );
      lastError = null;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await pause(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  const detail = lastError
    ? String(lastError.message ?? lastError)
        .replace(/\s+/g, ' ')
        .slice(0, 240)
    : JSON.stringify(lastValue).slice(0, 500);
  fail('Timed out waiting for ' + label + (detail ? ': ' + detail : '.'));
}

function elementId(reference) {
  return reference?.[ELEMENT_KEY] ?? reference?.[LEGACY_ELEMENT_KEY] ?? null;
}

async function elementText(driver, id) {
  return bounded(driver.request('GET', driver.path('/element/' + id + '/text')), 'Read W3C element text');
}

async function elementAttribute(driver, id, name) {
  return bounded(
    driver.request('GET', driver.path('/element/' + id + '/attribute/' + encodeURIComponent(name))),
    'Read W3C element attribute',
  );
}

async function elementDisplayed(driver, id) {
  return bounded(
    driver.request('GET', driver.path('/element/' + id + '/displayed')),
    'Read W3C display state',
  );
}

async function findUniqueVisibleText(driver, selector, expectedText, label) {
  const references = await bounded(driver.elements(selector), 'Find ' + label);
  const matches = [];
  for (const reference of references) {
    const id = elementId(reference);
    if (!id) continue;
    const text = String((await elementText(driver, id)) ?? '').trim();
    const displayed = await elementDisplayed(driver, id);
    if (text === expectedText && displayed === true) matches.push({ id, text });
  }
  if (matches.length !== 1) {
    fail(
      label + ' expected one visible exact match for "' + expectedText + '", found ' + matches.length + '.',
    );
  }
  return matches[0];
}

async function findUniqueAttribute(driver, selector, attribute, expectedValue, label) {
  const references = await bounded(driver.elements(selector), 'Find ' + label);
  const matches = [];
  for (const reference of references) {
    const id = elementId(reference);
    if (!id) continue;
    const value = await elementAttribute(driver, id, attribute);
    if (value === expectedValue && (await elementDisplayed(driver, id)) === true) matches.push({ id, value });
  }
  if (matches.length !== 1) {
    fail(
      label +
        ' expected one visible element with ' +
        attribute +
        '="' +
        expectedValue +
        '", found ' +
        matches.length +
        '.',
    );
  }
  return matches[0];
}

function inspectKeyboardTarget(selector, expectedName, suppliedElement) {
  const accessibleName = (element) =>
    element?.getAttribute('aria-label') ||
    element?.getAttribute('title') ||
    element?.textContent?.trim() ||
    '';
  const matches = suppliedElement
    ? suppliedElement.isConnected &&
      suppliedElement.matches(selector) &&
      accessibleName(suppliedElement) === expectedName
      ? [suppliedElement]
      : []
    : [...document.querySelectorAll(selector)].filter((element) => accessibleName(element) === expectedName);
  const target = matches.length === 1 ? matches[0] : null;
  const rect = target?.getBoundingClientRect() ?? null;
  const style = target ? window.getComputedStyle(target) : null;
  const visible = Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    style?.display !== 'none' &&
    style?.visibility !== 'hidden' &&
    Number(style?.opacity || 1) !== 0,
  );
  const tagName = target?.tagName ?? null;
  const role =
    target?.getAttribute('role') ||
    ({ BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[tagName] ?? null);
  const nativeFocusable =
    Boolean(target?.matches('button,input,select,textarea,a[href],summary')) && target.tabIndex >= 0;
  const roleFocusable =
    ['button', 'switch', 'radio', 'option', 'menuitem', 'tab', 'checkbox'].includes(role) &&
    target?.tabIndex >= 0;
  const describe = (element) =>
    element
      ? {
          tagName: element.tagName,
          role:
            element.getAttribute('role') ||
            ({ BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[
              element.tagName
            ] ??
              null),
          accessibleName: accessibleName(element),
        }
      : null;
  const active = document.activeElement;
  const provider = document.querySelector('[data-provider="polaris-dados"]');
  const quantityButton = provider?.querySelector('button[data-action="edit"][data-field="quantity"]');
  const quantityInput = provider?.querySelector('input[data-field="quantity"]');
  const saveButton = provider?.querySelector('button[data-action="save"]');
  const cancelButton = provider?.querySelector('button[data-action="cancel"]');
  const saveStatus = document.querySelector('.save-status');
  const saveLabel = saveStatus?.querySelector('.save-label');
  return {
    count: matches.length,
    element: target,
    descriptor: target
      ? {
          tagName,
          role,
          accessibleName: accessibleName(target),
          focusable:
            !target.disabled &&
            target.getAttribute('aria-disabled') !== 'true' &&
            (nativeFocusable || roleFocusable),
          visible,
          rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        }
      : null,
    focus: { targetActive: target === active, activeElement: describe(active) },
    route: window.location.hash || '#/',
    state: {
      settingsOpen: Boolean(document.querySelector('.settings-dialog')),
      theme: document.documentElement.dataset.theme ?? null,
      selectedLocale: [
        ...document.querySelectorAll('[role="listbox"] [role="option"][aria-selected="true"]'),
      ].map((option) => option.textContent?.trim() ?? ''),
      providerCount: document.querySelectorAll('[data-provider="polaris-dados"]').length,
      persistedQuantity: quantityButton?.textContent?.trim() ?? null,
      draftQuantity: quantityInput?.value ?? null,
      saveVisible: Boolean(saveButton && saveButton.getClientRects().length > 0),
      cancelVisible: Boolean(cancelButton && cancelButton.getClientRects().length > 0),
      hostSaveLabel: saveLabel?.textContent?.trim() ?? null,
    },
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null,
    },
  };
}

async function waitForUniqueVisibleFocusableTextTarget(driver, selector, expectedName, label) {
  return waitFor(
    () =>
      bounded(
        driver.execute('return (' + inspectKeyboardTarget.toString() + ').apply(null, arguments);', [
          selector,
          expectedName,
          null,
        ]),
        label + ' exact target inspection',
        COMMAND_LIMIT_MS,
      ),
    (value) =>
      value?.count === 1 &&
      value.descriptor?.accessibleName === expectedName &&
      value.descriptor?.visible === true &&
      value.descriptor?.focusable === true &&
      Boolean(value.element),
    label + ' unique visible focusable target',
    5_000,
  );
}

async function activateByKeyboard(driver, selector, expectedName, key, label, suppliedElement = null) {
  if (!Object.hasOwn(WEBDRIVER_KEYS, key)) fail('Unsupported W3C activation key: ' + key);
  const before = await bounded(
    driver.execute('return (' + inspectKeyboardTarget.toString() + ').apply(null, arguments);', [
      selector,
      expectedName,
      suppliedElement,
    ]),
    label + ' target inspection',
    COMMAND_LIMIT_MS,
  );
  if (
    before?.count !== 1 ||
    !before.descriptor?.visible ||
    !before.descriptor?.focusable ||
    !before.element
  ) {
    fail(
      'Refusing keyboard activation for ' +
        label +
        ': expected one visible, enabled, focusable target; observed ' +
        JSON.stringify(before?.descriptor ?? null),
    );
  }
  const id = elementId(before.element);
  if (!id) fail('WebDriver did not expose the guarded target element for ' + label + '.');
  let commandError = null;
  try {
    await bounded(
      driver.request('POST', driver.path('/element/' + id + '/value'), {
        text: WEBDRIVER_KEYS[key],
        value: [WEBDRIVER_KEYS[key]],
      }),
      label + ' W3C element keyboard activation',
      COMMAND_LIMIT_MS,
    );
  } catch (error) {
    commandError = error;
  }
  let releaseError = null;
  try {
    await bounded(
      driver.request('DELETE', driver.path('/actions')),
      label + ' W3C keyboard action release',
      COMMAND_LIMIT_MS,
    );
  } catch (error) {
    releaseError = error;
  }
  if (commandError) {
    if (releaseError) commandError.releaseError = String(releaseError.message ?? releaseError);
    throw commandError;
  }
  if (releaseError) throw releaseError;
  const after = await bounded(
    driver.execute('return (' + inspectKeyboardTarget.toString() + ').apply(null, arguments);', [
      selector,
      expectedName,
      null,
    ]),
    label + ' post-activation inspection',
    COMMAND_LIMIT_MS,
  );
  return {
    method: 'webdriver-element-send-keys',
    key,
    label,
    target: {
      selector,
      tagName: before.descriptor.tagName,
      role: before.descriptor.role,
      accessibleName: before.descriptor.accessibleName,
      focusable: before.descriptor.focusable,
    },
    focus: {
      targetActiveBefore: before.focus.targetActive,
      activeElementBefore: before.focus.activeElement,
      targetActiveAfter: after.focus.targetActive,
      activeElementAfter: after.focus.activeElement,
    },
    before: {
      route: before.route,
      state: before.state,
      rect: before.descriptor.rect,
      viewport: before.viewport,
    },
    after: {
      route: after.route,
      state: after.state,
      rect: after.descriptor?.rect ?? null,
      viewport: after.viewport,
    },
  };
}

async function childElements(driver, parentId, selector) {
  return bounded(
    driver.request('POST', driver.path('/element/' + parentId + '/elements'), {
      using: 'css selector',
      value: selector,
    }),
    'Find W3C child elements',
  );
}

async function typeIntoElement(driver, id, text, label) {
  await bounded(driver.request('POST', driver.path('/element/' + id + '/clear'), {}), label + ' clear');
  await bounded(
    driver.request('POST', driver.path('/element/' + id + '/value'), { text, value: [...text] }),
    label + ' W3C typing',
  );
}

async function observe(driver) {
  return bounded(
    driver.execute('return (' + acceptanceSnapshot.toString() + ').apply(null, arguments);', [
      'polaris-dados',
    ]),
    'Acceptance DOM snapshot',
  );
}

function acceptanceSnapshot(pluginId) {
  const text = (element) => (element?.textContent ?? '').trim();
  const visible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return (
      element.getClientRects().length > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0
    );
  };
  const readProvider = (root) => {
    const table = root.querySelector('table');
    const headers = [...(table?.querySelectorAll('thead th') ?? [])].map((header) => ({
      columnId: header.dataset.columnId ?? null,
      columnKey: header.dataset.columnKey ?? null,
      text: text(header),
    }));
    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => {
      const value = (field) => {
        const input = row.querySelector('input[data-field="' + field + '"]');
        const cell = row.querySelector('[data-field="' + field + '"]');
        return input ? input.value : cell ? text(cell) : null;
      };
      return {
        rowId: row.dataset.rowId ?? null,
        title: text(row.querySelector('td[data-row-title]')),
        quantity: value('quantity'),
        price: value('price'),
        total: value('total'),
      };
    });
    const panel = root.querySelector('[data-view-settings]');
    const form = panel?.querySelector('[data-view-settings-form]');
    const filterSelect = form?.querySelector('[data-action="view-filter-property"]');
    const filterValue = form?.querySelector('[data-action="view-filter-value"]');
    const titleInput = form?.querySelector('[data-action="view-title"]');
    const priorityButtons = [
      ...(form?.querySelectorAll('button[data-action="view-priority"][data-column-id]') ?? []),
    ];
    const editor = root.querySelector('[data-editor="quantity"]');
    const saveButton = editor?.querySelector('button[data-action="save"]');
    const cancelButton = editor?.querySelector('button[data-action="cancel"]');
    return {
      regionLabel: root.getAttribute('aria-label'),
      tableCount: root.querySelectorAll('table').length,
      tableTitle:
        text(table?.querySelector('caption[data-view-title]')) || text(table?.querySelector('caption')),
      headers,
      rows,
      editButtons: root.querySelectorAll('button[data-action="edit"][data-field="quantity"]').length,
      quantityInputs: [...root.querySelectorAll('input[data-field="quantity"]')].map((input) => ({
        value: input.value,
        rowId: input.dataset.rowId ?? null,
        ariaLabel: input.getAttribute('aria-label'),
      })),
      saveButton: saveButton ? { text: text(saveButton), disabled: saveButton.disabled } : null,
      cancelButton: cancelButton ? { text: text(cancelButton), disabled: cancelButton.disabled } : null,
      viewToggleCount: root.querySelectorAll('button[data-action="view-settings-toggle"]').length,
      settingsPanelOpen: Boolean(panel),
      viewSettings: form
        ? {
            title: titleInput?.value ?? null,
            filterPropertyId: filterSelect?.value ?? null,
            filterValue: filterValue?.value ?? null,
            priorityButtons: priorityButtons.map((button) => ({
              columnId: button.dataset.columnId,
              pressed: button.getAttribute('aria-pressed') === 'true',
            })),
          }
        : null,
      readOnlyControls: root.querySelectorAll(
        'input, textarea, select, button[data-action="edit"], button[data-action="save"]',
      ).length,
    };
  };
  const appMain = document.querySelector('.app > main.main');
  const providerRoots = [...document.querySelectorAll('[data-provider="' + pluginId + '"]')];
  const viewNodes = [...document.querySelectorAll('.polaris-dados-view-node')];
  const fallbacks = [...document.querySelectorAll('section.provider-fallback')];
  const pageHeading = document.querySelector('.page-title, main h1, main h2');
  const saveStatus = document.querySelector('.save-status');
  const saveLabel = saveStatus?.querySelector('.save-label');
  const settingsLanguageButton = [...document.querySelectorAll('button.select-button')].find((button) =>
    ['Language', 'Idioma'].includes(button.getAttribute('aria-label') ?? ''),
  );
  const languageControlVisibleCount = [
    ...document.querySelectorAll(
      'button.select-button[aria-label="Language"],button.select-button[aria-label="Idioma"]',
    ),
  ].filter(visible).length;
  const activeSettingsSections = [
    ...document.querySelectorAll('.settings-nav .settings-nav-item[aria-current="page"]'),
  ]
    .filter(visible)
    .map(text);
  const settingsPageHeading = text(document.querySelector('.settings-page-head h3')) || null;
  const themeGroup = [...document.querySelectorAll('[role="radiogroup"]')].find((group) =>
    ['Theme', 'Tema'].includes(group.getAttribute('aria-label') ?? ''),
  );
  const app = document.querySelector('.app') ?? document.body;
  const main = document.querySelector('.app > main.main');
  const mainContentWidth = main?.getBoundingClientRect().width ?? null;
  const appStyle = window.getComputedStyle(app);
  const rootStyle = window.getComputedStyle(document.documentElement);
  const zoomRaw = window.localStorage.getItem('morrow.zoom');
  const zoomLevel = zoomRaw === null ? 0 : Number(zoomRaw);
  const zoomFactor = Number.isFinite(zoomLevel) ? Math.pow(1.2, zoomLevel) : null;
  const viewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportWidth: window.visualViewport?.width ?? null,
    visualViewportHeight: window.visualViewport?.height ?? null,
    visualViewportScale: window.visualViewport?.scale ?? null,
    screenWidth: window.screen?.width ?? null,
    mainContentWidth,
  };
  const fallbackStates = fallbacks.map((section) => {
    const table = section.querySelector('table');
    const headers = [...(table?.querySelectorAll('thead th') ?? [])].map(text);
    const headerIndexes = Object.fromEntries(
      ['Quantity', 'Price', 'Total'].map((name) => [
        name,
        headers.flatMap((header, index) => (header === name ? [index] : [])),
      ]),
    );
    const cellForHeader = (cells, name) => {
      const indexes = headerIndexes[name];
      return indexes.length === 1 ? (cells[indexes[0]] ?? null) : null;
    };
    return {
      regionLabel: section.getAttribute('aria-label'),
      banner: text(section.querySelector('[role="note"]')),
      tableCount: section.querySelectorAll('table').length,
      headers,
      headerIndexes,
      rows: [...section.querySelectorAll('tbody tr')].map((row) => {
        const cells = [...row.querySelectorAll('td')];
        const totalCell = cellForHeader(cells, 'Total');
        const formulaSource = totalCell?.querySelector('code.formula-source-literal') ?? null;
        return {
          title: text(cells[0] ?? null),
          quantity: text(cellForHeader(cells, 'Quantity')),
          price: text(cellForHeader(cells, 'Price')),
          total: text(totalCell),
          formulaSourceLiteralCount: totalCell?.querySelectorAll('code.formula-source-literal').length ?? 0,
          formulaSourceLiteralText: formulaSource?.textContent?.trim() ?? null,
        };
      }),
      readOnlyControls: section.querySelectorAll(
        'input, textarea, select, button[data-action="edit"], button[data-action="save"], button[data-action="cancel"]',
      ).length,
    };
  });
  return {
    readyState: document.readyState,
    timeOrigin: window.performance.timeOrigin,
    route: window.location.hash,
    documentLang: document.documentElement.lang || null,
    theme: document.documentElement.dataset.theme ?? null,
    backgroundVariable: rootStyle.getPropertyValue('--bg').trim(),
    appBackground: appStyle.backgroundColor,
    appColor: appStyle.color,
    mainVisible: visible(appMain),
    appMainCount: document.querySelectorAll('.app > main.main').length,
    settingsOpen: document.querySelectorAll('.settings-dialog').length,
    settingsRoleDialogs: document.querySelectorAll('.settings-dialog[role="dialog"]').length,
    activeSettingsSections,
    settingsPageHeading,
    languageControlVisibleCount,
    languageSetting: settingsLanguageButton
      ? {
          label: settingsLanguageButton.getAttribute('aria-label'),
          selectedLabel: text(settingsLanguageButton),
          expanded: settingsLanguageButton.getAttribute('aria-expanded') === 'true',
          selectedOptions: [
            ...document.querySelectorAll('[role="listbox"] [role="option"][aria-selected="true"]'),
          ].map(text),
        }
      : null,
    themeSetting: themeGroup
      ? {
          label: themeGroup.getAttribute('aria-label'),
          checked: [...themeGroup.querySelectorAll('[role="radio"]')]
            .filter((button) => button.getAttribute('aria-checked') === 'true')
            .map(text),
        }
      : null,
    saveStatus: saveStatus
      ? {
          label: text(saveLabel) || text(saveStatus),
          className: saveStatus.className,
          role: saveStatus.getAttribute('role'),
          title: saveStatus.getAttribute('title'),
        }
      : null,
    pluginNoticeText:
      text(document.querySelector('[data-provider="' + pluginId + '"] [role="status"]')) || null,
    sidebarLabels: [...document.querySelectorAll('.sidebar-footer .nav-item .nav-label')].map(text),
    providerRootCount: providerRoots.length,
    providers: providerRoots.map(readProvider),
    viewNodeCount: viewNodes.length,
    views: viewNodes.map((node) => {
      const roots = [...node.querySelectorAll('[data-provider="' + pluginId + '"]')];
      return {
        visible: visible(node),
        providerCount: roots.length,
        providers: roots.map(readProvider),
        plainText: text(node).slice(0, 600),
      };
    }),
    fallbackCount: fallbacks.length,
    fallback: fallbackStates,
    dialogCount: document.querySelectorAll('[role="dialog"]').length,
    zoom: {
      storageRaw: zoomRaw,
      storageLevel: zoomLevel,
      storageFactor: zoomFactor,
      ...viewport,
    },
    pageHeading: text(pageHeading) || null,
  };
}

async function captureMarkdown(vaultRoot) {
  const rootInfo = await lstat(vaultRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    fail('Synthetic vault path must be a real directory.');
  const root = await realpath(vaultRoot);
  if (root !== path.resolve(vaultRoot)) fail('Synthetic vault path is not canonical.');
  const result = {};
  for (const relative of MARKDOWN_PATHS) {
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel) || absolute === root)
      fail('Markdown path escaped the vault.');
    if (relative.includes(path.sep)) {
      const parent = path.dirname(absolute);
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (await realpath(parent)) !== parent) {
        fail('Markdown parent directory is not canonical: ' + relative);
      }
    }
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
      fail('Expected a regular Markdown file: ' + relative);
    }
    const bytes = await readFile(absolute);
    const text = bytes.toString('utf8');
    const quantityMatch =
      relative === 'Inventory/Widget.md' ? /^\s*Quantity\s*:\s*(\d+)\s*$/im.exec(text) : null;
    result[relative] = {
      path: relative,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mtimeMs: info.mtimeMs,
      mode: info.mode & 0o7777,
      quantity: relative === 'Inventory/Widget.md' ? (quantityMatch ? Number(quantityMatch[1]) : null) : null,
    };
  }
  return result;
}

function snapshotArray(map) {
  return MARKDOWN_PATHS.map((relative) => {
    const value = map[relative];
    return {
      path: relative,
      sha256: value.sha256,
      size: value.size,
      mtimeMs: value.mtimeMs,
      mode: value.mode,
      quantity: value.quantity ?? null,
    };
  });
}

function freezeMarkdownSnapshot(snapshot) {
  for (const value of Object.values(snapshot)) Object.freeze(value);
  return Object.freeze(snapshot);
}

function assertMarkdownSame(before, after, label) {
  for (const relative of MARKDOWN_PATHS) {
    for (const field of ['sha256', 'size', 'mtimeMs', 'mode']) {
      if (before?.[relative]?.[field] !== after?.[relative]?.[field]) {
        fail(label + ': ' + relative + ' changed ' + field + '.');
      }
    }
  }
}

function normalizeViews(candidate) {
  const raw = candidate.linkedViews?.origin;
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.views) ? raw.views : null;
  if (!entries || entries.length !== 2)
    fail('Independent acceptance expects two candidate origin linked views.');
  return entries.map((entry, index) => {
    const config = entry.config && typeof entry.config === 'object' ? entry.config : entry;
    const view = {
      viewId: config.viewId ?? entry.viewId ?? null,
      title: config.title ?? entry.title ?? null,
      sourceDatabaseId: config.sourceDatabaseId ?? entry.sourceDatabaseId ?? null,
      columnOrder: Array.isArray(config.columnOrder)
        ? [...config.columnOrder]
        : Array.isArray(entry.columnOrder)
          ? [...entry.columnOrder]
          : null,
      filter: Object.hasOwn(config, 'filter')
        ? config.filter
        : Object.hasOwn(entry, 'filter')
          ? entry.filter
          : undefined,
      index,
    };
    if (
      typeof view.viewId !== 'string' ||
      typeof view.title !== 'string' ||
      typeof view.sourceDatabaseId !== 'string' ||
      !Array.isArray(view.columnOrder) ||
      view.filter === undefined
    ) {
      fail('Candidate linked view ' + index + ' lacks its ID, title, source, column order or filter.');
    }
    return view;
  });
}

function normalizeFilter(filter) {
  if (filter === null) return null;
  if (!filter || typeof filter !== 'object') fail('Linked view filter has an invalid shape.');
  return {
    propertyId: filter.propertyId ?? null,
    op: filter.op ?? null,
    value: filter.value ?? null,
  };
}

function sameFilter(left, right) {
  return JSON.stringify(normalizeFilter(left)) === JSON.stringify(normalizeFilter(right));
}

async function readViewMarkers(vaultRoot) {
  const source = await readFile(path.join(vaultRoot, 'Views.md'), 'utf8');
  const matches = [...source.matchAll(/<!--\s*morrow:polaris-dados-view:v1:([A-Za-z0-9_-]+)\s*-->/g)];
  if (matches.length !== 2) fail('Views.md must contain exactly two linked-view markers.');
  return matches.map((match) => {
    let value;
    try {
      value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    } catch {
      fail('A linked-view marker in Views.md could not be decoded.');
    }
    return value;
  });
}

function parseColorLuminance(value) {
  const source = String(value ?? '')
    .trim()
    .toLowerCase();
  let components = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(source);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((part) => part + part).join('') : hex[1];
    components = [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16));
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(source);
    if (rgb) components = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  if (!components || components.some((part) => !Number.isFinite(part))) return null;
  const [red, green, blue] = components.map((part) => {
    const normalized = Math.max(0, Math.min(255, part)) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function sameOwnedIdentity(expected, actual, label) {
  if (!expected || !actual) fail(label + ' runtime identity is missing.');
  for (const field of [
    'pid',
    'startTimeTicks',
    'effectiveUid',
    'executablePathSha256',
    'argvSha256',
    'driverPid',
  ]) {
    if (expected[field] !== actual[field]) fail(label + ' identity changed at field ' + field + '.');
  }
  if (actual.runtimeIdentityConfirmed !== true || actual.effectiveUid <= 0) {
    fail(label + ' runtime identity is not confirmed as a non-root process.');
  }
}

function driverFrom(context) {
  const driver = context.driver;
  if (!driver || typeof driver.execute !== 'function' || typeof driver.elements !== 'function') {
    fail('Independent acceptance needs the common runner WebDriver session.');
  }
  return driver;
}

function localeFromSettingsState(state) {
  const selected = state.languageSetting?.selectedLabel;
  const matches = Object.entries(LOCALES).filter(([, labels]) => labels.languageOption === selected);
  if (matches.length !== 1)
    fail('Current Settings language is not uniquely identifiable from its selected option.');
  return matches[0][0];
}

async function settingsVisible(driver) {
  const before = await waitFor(
    () => observe(driver),
    (value) => value.settingsOpen === 0 && value.mainVisible,
    'application ready before Settings navigation',
  );
  const matches = Object.entries(LOCALES).filter(([, labels]) =>
    before.sidebarLabels.includes(labels.settings),
  );
  if (matches.length !== 1) fail('Current Settings navigation label is not uniquely visible in the sidebar.');
  const [currentLocale, labels] = matches[0];
  const activation = await activateByKeyboard(
    driver,
    '.sidebar-footer .nav-item',
    labels.settings,
    'Enter',
    'Open Settings from the sidebar',
  );
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 1 &&
      value.mainVisible &&
      value.activeSettingsSections?.length === 1 &&
      value.settingsPageHeading === value.activeSettingsSections[0],
    'Settings dialog and selected section ready',
  );
  return { state, currentLocale, keyboardActivation: activation };
}

async function navigateSettingsSection(driver, labels, sectionLabel) {
  const activation = await activateByKeyboard(
    driver,
    '.settings-nav .settings-nav-item',
    sectionLabel,
    'Enter',
    'Settings section ' + sectionLabel,
  );
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 1 &&
      value.activeSettingsSections?.length === 1 &&
      value.activeSettingsSections[0] === sectionLabel &&
      value.settingsPageHeading === sectionLabel &&
      (sectionLabel !== labels.languageSection || value.languageControlVisibleCount === 1),
    'active Settings section and visible controls for ' + sectionLabel,
    5_000,
  );
  if (
    sectionLabel === labels.languageSection &&
    (state.languageControlVisibleCount !== 1 || !state.languageSetting)
  ) {
    fail('Language and region is active but its single visible language control is missing.');
  }
  return { state, keyboardActivation: activation };
}

async function selectLocaleWithUI(driver, locale) {
  const labels = LOCALES[locale];
  const beforeState = await observe(driver);
  const currentLocale = localeFromSettingsState(beforeState);
  const currentLanguageSection = LOCALES[currentLocale].languageSection;
  if (
    beforeState.settingsOpen !== 1 ||
    beforeState.activeSettingsSections?.length !== 1 ||
    beforeState.activeSettingsSections[0] !== currentLanguageSection ||
    beforeState.settingsPageHeading !== currentLanguageSection ||
    beforeState.languageControlVisibleCount !== 1
  ) {
    fail('Language control interaction requires the active localized Language and region section.');
  }
  const activeLanguageLabel = beforeState.languageSetting?.label;
  if (!['Language', 'Idioma'].includes(activeLanguageLabel)) {
    fail('Current Settings language control has no known accessible label.');
  }
  const languageButtons = await bounded(
    driver.elements('button.select-button[aria-label="Language"],button.select-button[aria-label="Idioma"]'),
    'Find Settings language control',
  );
  if (languageButtons.length !== 1) fail('Expected one visible Language/Idioma Settings select.');
  const buttonActivation = await activateByKeyboard(
    driver,
    'button.select-button[aria-label="Language"],button.select-button[aria-label="Idioma"]',
    activeLanguageLabel,
    'Enter',
    'Open language select',
  );
  const openState = await waitFor(
    () => observe(driver),
    (value) =>
      value.languageSetting?.expanded === true && value.languageSetting?.selectedOptions?.length === 1,
    'language list opened by keyboard',
  );
  const selectedBefore = openState.languageSetting.selectedOptions[0];
  const selectedOptionSelector = '[role="listbox"] [role="option"][aria-selected="true"]';
  const selectedOptionReady = await waitForUniqueVisibleFocusableTextTarget(
    driver,
    selectedOptionSelector,
    selectedBefore,
    'Current language option after opening the list',
  );
  const currentOptionActivation = await activateByKeyboard(
    driver,
    selectedOptionSelector,
    selectedBefore,
    'Space',
    'Confirm current language option and close its list',
    selectedOptionReady.element,
  );
  const dismissedState = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 1 &&
      value.languageSetting?.expanded === false &&
      value.languageSetting?.selectedLabel === selectedBefore,
    'current language option confirmed and list closed without leaving Settings',
  );
  if (localeFromSettingsState(dismissedState) !== localeFromSettingsState(openState)) {
    fail('Confirming the current language changed locale or closed Settings.');
  }
  const reopenActivation = await activateByKeyboard(
    driver,
    'button.select-button[aria-label="Language"],button.select-button[aria-label="Idioma"]',
    activeLanguageLabel,
    'Enter',
    'Reopen language select',
  );
  await waitFor(
    () => observe(driver),
    (value) => value.languageSetting?.expanded === true,
    'language list reopened by keyboard',
  );
  const optionSelector = '[role="listbox"] [role="option"]';
  const targetOptionReady = await waitForUniqueVisibleFocusableTextTarget(
    driver,
    optionSelector,
    labels.languageOption,
    'Target language option after reopening the list',
  );
  const optionActivation = await activateByKeyboard(
    driver,
    optionSelector,
    labels.languageOption,
    'Space',
    'Select locale through Settings UI',
    targetOptionReady.element,
  );
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 1 &&
      value.languageSetting?.label === labels.language &&
      value.languageSetting?.selectedLabel === labels.languageOption,
    'selected locale visible in Settings',
  );
  const selectedState = await observe(driver);
  if (selectedState.languageSetting?.selectedOptions?.length) {
    const selectedOption = selectedState.languageSetting.selectedOptions[0];
    if (selectedOption !== labels.languageOption)
      fail('Selected language option does not match target locale.');
  } else if (selectedBefore !== 'true' && state.languageSetting?.selectedLabel !== labels.languageOption) {
    fail('Language select did not retain the requested locale.');
  }
  return {
    selectorLabel: labels.language,
    selectedOption: labels.languageOption,
    ariaSelectedBefore: selectedBefore === labels.languageOption ? 'true' : 'false',
    selectedOptionTextAfter: selectedState.languageSetting?.selectedOptions?.[0] ?? labels.languageOption,
    keyboardActivations: [buttonActivation, currentOptionActivation, reopenActivation, optionActivation],
  };
}

async function setThemeWithUI(driver, locale, theme) {
  const labels = LOCALES[locale];
  const section = await navigateSettingsSection(driver, labels, labels.appearance);
  const selector = '[role="radiogroup"][aria-label="' + labels.theme + '"] [role="radio"]';
  const text = theme === 'dark' ? labels.dark : labels.light;
  const target = await findUniqueVisibleText(driver, selector, text, 'theme option');
  const before = await elementAttribute(driver, target.id, 'aria-checked');
  const themeActivation = await activateByKeyboard(
    driver,
    selector,
    text,
    'Space',
    'Select theme through Settings UI',
  );
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 1 &&
      value.theme === theme &&
      value.themeSetting?.label === labels.theme &&
      value.themeSetting?.checked?.length === 1 &&
      value.themeSetting.checked[0] === text,
    'theme reflected in Settings and document',
  );
  return {
    selectorLabel: labels.theme,
    selectedOption: text,
    ariaCheckedBefore: before,
    themeAfter: state.theme,
    keyboardActivations: [section.keyboardActivation, themeActivation],
  };
}

async function switchPluginThroughUI(driver, locale, pluginName, enabled) {
  const labels = LOCALES[locale];
  const section = await navigateSettingsSection(driver, labels, labels.plugins);
  const global = await findUniqueAttribute(
    driver,
    '[role="switch"]',
    'aria-label',
    labels.globalPlugins,
    'global plugin setting',
  );
  const globalChecked = await elementAttribute(driver, global.id, 'aria-checked');
  if (globalChecked !== 'true')
    fail('Global plugin permission must stay enabled for this acceptance scenario.');
  const plugin = await findUniqueAttribute(
    driver,
    '[role="switch"]',
    'aria-label',
    pluginName,
    'Polaris plugin setting',
  );
  const before = await elementAttribute(driver, plugin.id, 'aria-checked');
  const wanted = enabled ? 'true' : 'false';
  const keyboardActivations = [section.keyboardActivation];
  if (before !== wanted) {
    keyboardActivations.push(
      await activateByKeyboard(
        driver,
        '[role="switch"][aria-label="' + pluginName.replaceAll('"', '\\"') + '"]',
        pluginName,
        'Space',
        'Toggle Polaris plugin through Settings UI',
      ),
    );
  }
  const after = await waitFor(
    () =>
      driverFrom({ driver }).request('GET', driver.path('/element/' + plugin.id + '/attribute/aria-checked')),
    (value) => value === wanted,
    'Polaris plugin Settings switch state',
    10_000,
  );
  return {
    globalSwitch: { label: labels.globalPlugins, ariaChecked: globalChecked },
    pluginSwitch: { label: pluginName, ariaCheckedBefore: before, ariaCheckedAfter: after },
    keyboardActivations,
  };
}

async function closeSettings(driver, locale) {
  const labels = LOCALES[locale];
  const activation = await activateByKeyboard(
    driver,
    'button[aria-label="' + labels.closeSettings.replaceAll('"', '\\"') + '"]',
    labels.closeSettings,
    'Enter',
    'Close Settings through W3C keyboard activation',
  );
  const state = await waitFor(
    () => observe(driver),
    (value) => value.settingsOpen === 0,
    'Settings overlay closed',
    10_000,
  );
  return { state, keyboardActivation: activation };
}

async function openPageById(driver, pageId, expectedLabel) {
  const beforeRoute = await bounded(driver.execute('return location.hash || "#/";'), 'Read pre-setup route');
  const afterRoute = '#/page/' + encodeURIComponent(pageId);
  await bounded(
    driver.execute('location.hash = arguments[0]; return location.hash;', [afterRoute]),
    'Set public page route for ' + expectedLabel,
  );
  const observedRoute = await waitFor(
    () => bounded(driver.execute('return location.hash || "#/";'), 'Read page setup route'),
    (value) => value === afterRoute,
    'public location hash setup for ' + expectedLabel,
  );
  if (observedRoute !== afterRoute) fail('Public route setup did not select ' + expectedLabel + '.');
  return {
    method: 'public-location-hash-setup',
    pageId,
    beforeRoute,
    afterRoute,
    sidebarAcceptance: false,
  };
}

async function toggleViewPanel(driver, title, open) {
  const nodes = await bounded(driver.elements('.polaris-dados-view-node'), 'Find linked view nodes');
  const matches = [];
  for (const reference of nodes) {
    const id = elementId(reference);
    if (!id) continue;
    const captions = await childElements(driver, id, 'table caption[data-view-title]');
    const captionsText = [];
    for (const caption of captions) {
      const captionId = elementId(caption);
      if (captionId) captionsText.push(String((await elementText(driver, captionId)) ?? '').trim());
    }
    if (captionsText.includes(title)) matches.push(id);
  }
  if (matches.length !== 1)
    fail('Expected one real linked-view node named "' + title + '", found ' + matches.length + '.');
  const toggles = await childElements(driver, matches[0], 'button[data-action="view-settings-toggle"]');
  if (toggles.length !== 1) fail('Expected one linked-view settings toggle in "' + title + '".');
  const toggleId = elementId(toggles[0]);
  if (!toggleId) fail('Linked-view settings toggle has no W3C reference.');
  const toggleLabel = String(
    (await elementAttribute(driver, toggleId, 'aria-label')) ||
      (await elementAttribute(driver, toggleId, 'title')) ||
      (await elementText(driver, toggleId)) ||
      '',
  ).trim();
  if (!toggleLabel) fail('Linked-view settings toggle has no readable accessible name.');
  const keyboardActivation = await activateByKeyboard(
    driver,
    '.polaris-dados-view-node button[data-action="view-settings-toggle"]',
    toggleLabel,
    'Enter',
    (open ? 'Open' : 'Close') + ' linked-view settings panel for ' + title,
    toggles[0],
  );
  const state = await waitFor(
    () => observe(driver),
    (value) => {
      const node = value.views.find((item) =>
        item.providers.some((provider) => provider.tableTitle === title),
      );
      return Boolean(node && node.providers[0]?.settingsPanelOpen === open);
    },
    (open ? 'open' : 'closed') + ' view settings for ' + title,
    10_000,
  );
  return { state, keyboardActivation };
}

async function screenshot(driver, outputPath) {
  await bounded(driver.screenshot(outputPath), 'Native acceptance screenshot');
  const bytes = await readFile(outputPath);
  if (bytes.length < 1_000) fail('Native acceptance screenshot is unexpectedly small.');
  const dimensions =
    bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : null;
  if (!dimensions || dimensions.width < 600 || dimensions.height < 400)
    fail('Screenshot is not a full PNG capture.');
  return {
    file: path.basename(outputPath),
    size: bytes.length,
    path: outputPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function saveStatusForLocale(driver, locale, label) {
  const expected = LOCALES[locale].hostSaved;
  return waitFor(
    () => observe(driver),
    (value) =>
      value.saveStatus?.label === expected &&
      !String(value.saveStatus.className)
        .split(/\s+/)
        .some((name) => name === 'is-saving' || name === 'is-error') &&
      value.saveStatus.role !== 'alert',
    label + ' Saved/idle state',
    10_000,
  );
}

function hostSavedStatusEvidence(snapshot, locale, persistedQuantity, draftLocal = false) {
  const status = snapshot?.saveStatus;
  const classes = String(status?.className ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const text = LOCALES[locale].hostSaved;
  if (
    status?.label !== text ||
    classes.some((name) => name === 'is-saving' || name === 'is-error') ||
    status.role === 'alert' ||
    persistedQuantity !== 2
  ) {
    fail('Host Saved/idle status, persisted Quantity, or local draft evidence is invalid.');
  }
  return {
    state: 'saved',
    source: 'host-topbar-save-indicator',
    text,
    classes,
    pluginNoticeText: snapshot.pluginNoticeText ?? null,
    persistedQuantity: String(persistedQuantity),
    ...(draftLocal ? { draftLocal: true } : {}),
  };
}

function hostDraftStatusEvidence(snapshot, locale, persistedQuantity) {
  const status = snapshot?.saveStatus;
  const classes = String(status?.className ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const isSaving = status?.label === LOCALES[locale].hostSaving && classes.includes('is-saving');
  const isSaved = status?.label === LOCALES[locale].hostSaved && !classes.includes('is-saving');
  if (
    (!isSaving && !isSaved) ||
    classes.includes('is-error') ||
    status.role === 'alert' ||
    persistedQuantity !== 2
  ) {
    fail('Host draft status must be Saved or real editing/Saving, without an error or persisted write.');
  }
  return {
    state: isSaving ? 'saving' : 'saved',
    source: 'host-topbar-save-indicator',
    text: status.label,
    classes,
    pluginNoticeText: snapshot.pluginNoticeText ?? null,
    persistedQuantity: String(persistedQuantity),
    draftLocal: true,
    scope: 'persisted baseline; visible Quantity draft is local only',
  };
}

async function compareLiveMarkdown(vault, expected) {
  const actual = await captureMarkdown(vault);
  assertMarkdownSame(expected, actual, 'Live Markdown persistence');
  return actual;
}

async function verifyViews(driver, candidate, pageId, expectedViews, rowQuantity, locale) {
  const labels = LOCALES[locale];
  const navigation = await openPageById(driver, pageId, 'Views.md');
  let state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 0 &&
      value.route.includes(pageId) &&
      value.viewNodeCount === 2 &&
      value.providerRootCount === 2 &&
      value.views.every(
        (node) => node.visible && node.providerCount === 1 && node.providers[0]?.tableCount === 1,
      ),
    'two linked views with one mounted provider each',
  );
  if (state.views.some((node) => node.providers[0].regionLabel !== labels.providerRegion)) {
    fail('Provider locale label does not match the selected interface language.');
  }
  const markerValues = await readViewMarkers(candidate.vault);
  for (let index = 0; index < expectedViews.length; index += 1) {
    const expected = expectedViews[index];
    const marker = markerValues[index];
    if (
      marker?.viewId !== expected.viewId ||
      marker?.title !== expected.title ||
      marker?.sourceDatabaseId !== expected.sourceDatabaseId ||
      !same(marker?.columnOrder ?? [], expected.columnOrder) ||
      !sameFilter(marker?.filter, expected.filter)
    ) {
      fail(
        'Persisted linked-view marker differs from the independent fixture expectation at index ' +
          index +
          '.',
      );
    }
  }
  const configSnapshots = [];
  const nodeRecords = [];
  const keyboardActivations = [];
  for (const expected of expectedViews) {
    const matching = state.views.filter((node) => node.providers[0]?.tableTitle === expected.title);
    if (matching.length !== 1) fail('Expected exactly one mounted view titled "' + expected.title + '".');
    const view = matching[0].providers[0];
    if (view.tableTitle !== expected.title || view.viewToggleCount !== 1) {
      fail('Rendered linked view title or settings control is missing: ' + expected.title);
    }
    if (view.headers.length < 2 || view.headers[0].columnKey !== 'row-title') {
      fail('Linked view row-title column is missing or not first: ' + expected.title);
    }
    const selectedColumnOrder = view.headers.map((header) => header.columnId).filter((id) => id !== null);
    const observedPriorityOrder = selectedColumnOrder.filter((id) => expected.columnOrder.includes(id));
    if (!same(observedPriorityOrder, expected.columnOrder)) {
      fail('Rendered linked-view column order does not match its persisted config: ' + expected.title);
    }
    const filter = normalizeFilter(expected.filter);
    const visibleRows = !filter
      ? 1
      : filter.propertyId === 'quantity' && filter.op === 'gte'
        ? rowQuantity >= Number(filter.value)
          ? 1
          : 0
        : null;
    if (visibleRows === null) fail('Independent fixture uses an unhandled linked-view filter.');
    if (view.rows.length !== visibleRows)
      fail('Rendered linked-view row count does not match its filter: ' + expected.title);
    const openedPanel = await toggleViewPanel(driver, expected.title, true);
    keyboardActivations.push(openedPanel.keyboardActivation);
    state = openedPanel.state;
    const opened = state.views.find((node) =>
      node.providers.some((provider) => provider.tableTitle === expected.title),
    );
    const panel = opened?.providers[0]?.viewSettings;
    if (
      !panel ||
      panel.title !== expected.title ||
      panel.filterPropertyId !== (filter?.propertyId ?? '') ||
      panel.filterValue !== (filter ? String(filter.value) : '')
    ) {
      fail('Visible linked-view settings panel does not match stored filter/title: ' + expected.title);
    }
    const pressed = panel.priorityButtons.filter((button) => button.pressed).map((button) => button.columnId);
    if (!same([...pressed].sort(), [...expected.columnOrder].sort())) {
      fail(
        'Visible linked-view priority controls do not match stored column order membership: ' +
          expected.title,
      );
    }
    configSnapshots.push({
      viewId: expected.viewId,
      title: expected.title,
      sourceDatabaseId: expected.sourceDatabaseId,
      columnOrder: expected.columnOrder,
      filter,
      observed: {
        title: panel.title,
        filterPropertyId: panel.filterPropertyId,
        filterValue: panel.filterValue,
        priorityColumnIds: pressed,
        renderedHeaderIds: view.headers.map((header) => header.columnId ?? header.columnKey),
        renderedRowCount: view.rows.length,
      },
    });
    nodeRecords.push({
      viewId: expected.viewId,
      title: expected.title,
      providerCount: 1,
      tableCount: view.tableCount,
      regionLabel: view.regionLabel,
      headers: view.headers,
      rows: view.rows,
    });
    const closedPanel = await toggleViewPanel(driver, expected.title, false);
    keyboardActivations.push(closedPanel.keyboardActivation);
    state = await waitFor(
      () => observe(driver),
      (value) => value.views.every((node) => node.providers.every((provider) => !provider.settingsPanelOpen)),
      'all linked-view settings closed',
      10_000,
    );
  }
  if (state.settingsOpen !== 0 || state.providerRootCount !== 2 || state.viewNodeCount !== 2) {
    fail('Views page did not return to two mounted providers without a settings overlay.');
  }
  await saveStatusForLocale(driver, locale, 'Views page');
  return {
    providerCount: state.providerRootCount,
    rootCountByView: nodeRecords.map((item) => ({
      viewId: item.viewId,
      title: item.title,
      count: item.providerCount,
    })),
    configs: configSnapshots,
    renderedViews: nodeRecords,
    settingsOverlayClosed: state.settingsOpen === 0,
    localeRegionVerified: nodeRecords.every((item) => item.regionLabel === labels.providerRegion),
    navigation,
    keyboardActivations,
  };
}

async function verifyInventoryDraft(driver, candidate, pageId, baseline, locale, screenshotPath) {
  const labels = LOCALES[locale];
  const navigation = await openPageById(driver, pageId, 'Inventory.md');
  let state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 0 &&
      value.providerRootCount === 1 &&
      value.providers[0]?.tableCount === 1 &&
      value.providers[0]?.rows.length === 1 &&
      value.providers[0]?.rows[0]?.quantity === '2' &&
      value.providers[0]?.rows[0]?.price === '10' &&
      value.providers[0]?.rows[0]?.total === '20',
    'Inventory provider and baseline row',
  );
  if (state.providers[0].regionLabel !== labels.providerRegion)
    fail('Inventory provider label is not localized.');
  const before = await compareLiveMarkdown(candidate.vault, baseline);
  if (before['Inventory/Widget.md'].quantity !== 2)
    fail('Persisted Quantity must remain 2 before the local draft.');
  const preDraftStatusSnapshot = await saveStatusForLocale(driver, locale, 'Before Quantity draft');
  const preDraftStatus = hostSavedStatusEvidence(
    preDraftStatusSnapshot,
    locale,
    baseline['Inventory/Widget.md'].quantity,
  );
  const editButtons = await bounded(
    driver.elements('[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]'),
    'Find Quantity edit control',
  );
  if (editButtons.length !== 1) fail('Expected one real Quantity edit button.');
  const editId = elementId(editButtons[0]);
  if (!editId) fail('Quantity edit control has no W3C reference.');
  const editActivation = await activateByKeyboard(
    driver,
    '[data-provider="polaris-dados"] button[data-action="edit"][data-field="quantity"]',
    labels.quantity,
    'Enter',
    'Open Quantity editor through W3C keyboard activation',
  );
  await waitFor(
    () => observe(driver),
    (value) => value.providers[0]?.quantityInputs?.length === 1,
    'Quantity editor opened',
  );
  const inputRefs = await bounded(
    driver.elements('[data-provider="polaris-dados"] input[data-field="quantity"]'),
    'Find Quantity draft input',
  );
  if (inputRefs.length !== 1) fail('Expected one real Quantity draft input.');
  const inputId = elementId(inputRefs[0]);
  if (!inputId) fail('Quantity draft input has no W3C reference.');
  await typeIntoElement(driver, inputId, '3', 'Quantity local draft');
  const draftSnapshot = await waitFor(
    () => observe(driver),
    (value) =>
      value.providers[0]?.quantityInputs?.length === 1 &&
      value.providers[0].quantityInputs[0].value === '3' &&
      value.providers[0].saveButton?.text === labels.save &&
      value.providers[0].cancelButton?.text === labels.cancel &&
      !value.providers[0].saveButton.disabled &&
      !value.providers[0].cancelButton.disabled,
    'local Quantity draft with visible Save and Cancel',
  );
  const draftMarkdown = await compareLiveMarkdown(candidate.vault, baseline);
  if (draftMarkdown['Inventory/Widget.md'].quantity !== 2) {
    fail('Quantity=3 must remain a local draft while Markdown still persists Quantity=2.');
  }
  const screenshotInfo = await screenshot(driver, screenshotPath);
  const persistedRowQuantity = draftMarkdown['Inventory/Widget.md'].quantity;
  const draftStatus = hostDraftStatusEvidence(draftSnapshot, locale, persistedRowQuantity);
  const editorObservation = {
    inputValue: draftSnapshot.providers[0].quantityInputs[0].value,
    inputAriaLabel: draftSnapshot.providers[0].quantityInputs[0].ariaLabel,
    rowValues: draftSnapshot.providers[0].rows[0],
    saveVisible: Boolean(draftSnapshot.providers[0].saveButton),
    saveText: draftSnapshot.providers[0].saveButton?.text ?? null,
    cancelVisible: Boolean(draftSnapshot.providers[0].cancelButton),
    cancelText: draftSnapshot.providers[0].cancelButton?.text ?? null,
    saveEnabled: draftSnapshot.providers[0].saveButton?.disabled === false,
    cancelEnabled: draftSnapshot.providers[0].cancelButton?.disabled === false,
    persistedQuantity: persistedRowQuantity,
    draftLocal: true,
    topbarStateDuringDraft: draftStatus,
    meaning:
      'The plugin draft is local and unsaved; the topbar reports host Markdown persistence separately.',
  };
  const cancelRefs = await bounded(
    driver.elements('[data-provider="polaris-dados"] button[data-action="cancel"]'),
    'Find Quantity Cancel control',
  );
  if (cancelRefs.length !== 1) fail('Expected one real Quantity Cancel button.');
  const cancelId = elementId(cancelRefs[0]);
  if (!cancelId) fail('Quantity Cancel control has no W3C reference.');
  const cancelActivation = await activateByKeyboard(
    driver,
    '[data-provider="polaris-dados"] button[data-action="cancel"]',
    labels.cancel,
    'Enter',
    'Cancel local Quantity draft through W3C keyboard activation',
  );
  state = await waitFor(
    () =>
      observe(driver).then(async (value) => ({
        dom: value,
        markdown: await captureMarkdown(candidate.vault),
      })),
    (value) =>
      value.dom.providers[0]?.quantityInputs?.length === 0 &&
      value.dom.providers[0]?.rows[0]?.quantity === '2' &&
      value.dom.providers[0]?.rows[0]?.total === '20' &&
      value.dom.settingsOpen === 0 &&
      value.markdown['Inventory/Widget.md']?.quantity === 2,
    'W3C Cancel discarded local draft',
  );
  const postCancelStatusSnapshot = await saveStatusForLocale(driver, locale, 'After Quantity Cancel');
  const postCancelStatus = hostSavedStatusEvidence(
    postCancelStatusSnapshot,
    locale,
    state.markdown['Inventory/Widget.md'].quantity,
  );
  assertMarkdownSame(baseline, state.markdown, 'Markdown after real W3C Cancel');
  return {
    preDraftStatus,
    persistedQuantity: '2',
    draftQuantity: '3',
    draftLocal: true,
    saveVisible: editorObservation.saveVisible,
    cancelVisible: editorObservation.cancelVisible,
    cancelVia: 'webdriver-keyboard-activation',
    cancelActivation,
    draftStatus,
    postCancelStatus,
    draft: editorObservation,
    markdownBeforeCancel: snapshotArray(draftMarkdown),
    markdownAfterCancel: snapshotArray(state.markdown),
    markdownUnchanged: true,
    unchanged: true,
    screenshot: screenshotInfo,
    navigation,
    keyboardActivations: [editActivation, cancelActivation],
  };
}

async function verifyReadOnlyFallback(driver, candidate, locale, pluginName, screenshotPath, baseline) {
  const labels = LOCALES[locale];
  const settings = await settingsVisible(driver);
  const openState = settings.state;
  if (settings.currentLocale !== locale) {
    fail('Settings locale from the visible sidebar does not match the fallback scenario.');
  }
  const pluginSwitch = await switchPluginThroughUI(driver, locale, pluginName, false);
  const close = await closeSettings(driver, locale);
  let state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 0 &&
      value.providerRootCount === 0 &&
      value.fallbackCount === 1 &&
      value.fallback[0]?.tableCount === 1 &&
      value.fallback[0]?.readOnlyControls === 0,
    'plugin-off readonly fallback with Settings closed',
  );
  if (
    state.fallback[0].regionLabel !== labels.databaseRegion ||
    state.dialogCount !== 0 ||
    state.fallback[0].rows.length !== 1 ||
    state.fallback[0].headerIndexes?.Quantity?.length !== 1 ||
    state.fallback[0].headerIndexes?.Price?.length !== 1 ||
    state.fallback[0].headerIndexes?.Total?.length !== 1 ||
    state.fallback[0].rows[0].quantity !== '2' ||
    state.fallback[0].rows[0].price !== '10' ||
    state.fallback[0].rows[0].total !== 'Quantity * Price' ||
    state.fallback[0].rows[0].formulaSourceLiteralCount !== 1 ||
    state.fallback[0].rows[0].formulaSourceLiteralText !== 'Quantity * Price' ||
    pluginSwitch.globalSwitch.ariaChecked !== 'true' ||
    pluginSwitch.pluginSwitch.ariaCheckedAfter !== 'false'
  ) {
    fail('Fallback is not the expected readonly literal rendering of the persisted Inventory row.');
  }
  const hostStatusSnapshot = await saveStatusForLocale(driver, locale, 'Readonly fallback');
  const hostStatusAtCapture = hostSavedStatusEvidence(
    hostStatusSnapshot,
    locale,
    baseline['Inventory/Widget.md'].quantity,
  );
  const markdownAfter = await compareLiveMarkdown(candidate.vault, baseline);
  assertMarkdownSame(baseline, markdownAfter, 'Markdown at read-only fallback capture');
  if (state.settingsOpen !== 0 || state.providerRootCount !== 0)
    fail('Settings overlay or provider remains after plugin OFF.');
  const pluginsJsonEnabledAtCapture = await waitFor(
    () => readVaultPluginEnabled(candidate.vault),
    (enabled) => enabled === false,
    'vault .morrow/plugins.json disabled at fallback capture',
  );
  const screenshotInfo = await screenshot(driver, screenshotPath);
  return {
    settingsClosed: state.settingsOpen === 0 && state.dialogCount === 0,
    overlayVisible: state.dialogCount !== 0,
    settingsOpenBeforeToggle: openState.settingsOpen,
    globalPluginPermission: pluginSwitch.globalSwitch,
    pluginSwitch: pluginSwitch.pluginSwitch,
    pluginEnabled: false,
    pluginsJsonEnabledAtCapture,
    pluginsJsonPath: '.morrow/plugins.json',
    providerEnabled: false,
    providerCount: state.providerRootCount,
    fallbackPresent: state.fallbackCount === 1,
    fallbackRegionLabel: state.fallback[0].regionLabel,
    fallbackRows: state.fallback[0].rows,
    readOnly: state.fallback[0].readOnlyControls === 0,
    hostStatus: hostStatusAtCapture,
    screenshot: screenshotInfo,
    markdownAfterFallback: snapshotArray(markdownAfter),
    markdownUnchanged: true,
    keyboardActivations: [
      settings.keyboardActivation,
      ...pluginSwitch.keyboardActivations,
      close.keyboardActivation,
    ],
  };
}

async function readVaultPluginEnabled(vault) {
  const config = JSON.parse(await readFile(path.join(vault, '.morrow', 'plugins.json'), 'utf8'));
  if (!Array.isArray(config.enabled)) return null;
  return config.enabled.includes('polaris-dados');
}

async function reactivatePluginAfterFallback(driver, candidate, locale, pluginName, baseline) {
  const settings = await settingsVisible(driver);
  if (settings.currentLocale !== locale) fail('Locale changed before plugin reactivation after fallback.');
  const pluginSwitch = await switchPluginThroughUI(driver, locale, pluginName, true);
  if (
    pluginSwitch.pluginSwitch.ariaCheckedBefore !== 'false' ||
    pluginSwitch.pluginSwitch.ariaCheckedAfter !== 'true'
  ) {
    fail('Plugin reactivation must follow an observed OFF state and end ON through the Settings UI.');
  }
  const close = await closeSettings(driver, locale);
  const pluginsJsonEnabled = await waitFor(
    () => readVaultPluginEnabled(candidate.vault),
    (enabled) => enabled === true,
    'vault .morrow/plugins.json enabled after fallback reactivation',
  );
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.settingsOpen === 0 &&
      value.route.includes(candidate.databaseId) &&
      value.providerRootCount === 1 &&
      value.fallbackCount === 0 &&
      value.providers[0]?.tableCount === 1 &&
      value.providers[0]?.rows.length === 1 &&
      value.providers[0]?.rows[0]?.quantity === '2' &&
      value.providers[0]?.rows[0]?.price === '10' &&
      value.providers[0]?.rows[0]?.total === '20',
    'enabled provider remounted on Inventory after fallback',
  );
  const savedSnapshot = await saveStatusForLocale(driver, locale, 'After fallback plugin reactivation');
  const hostStatus = hostSavedStatusEvidence(savedSnapshot, locale, baseline['Inventory/Widget.md'].quantity);
  const markdown = await compareLiveMarkdown(candidate.vault, baseline);
  assertMarkdownSame(baseline, markdown, 'Markdown after plugin reactivation');
  if (pluginsJsonEnabled !== true || state.settingsOpen !== 0 || state.providerRootCount !== 1) {
    fail('Plugin reactivation did not persist the enabled state and remount the provider.');
  }
  return {
    settingsClosed: true,
    pluginEnabled: true,
    pluginsJsonEnabled,
    pluginsJsonPath: '.morrow/plugins.json',
    providerCount: state.providerRootCount,
    fallbackCount: state.fallbackCount,
    hostStatus,
    markdownUnchanged: true,
    keyboardActivations: [
      settings.keyboardActivation,
      ...pluginSwitch.keyboardActivations,
      close.keyboardActivation,
    ],
  };
}

async function setCombinationSettings(driver, locale, theme, pluginName, enablePlugin) {
  const target = LOCALES[locale];
  const settingsOpen = await settingsVisible(driver);
  let state;
  const keyboardActivations = [settingsOpen.keyboardActivation];
  const previousLocale = settingsOpen.currentLocale;
  const languageSection = await navigateSettingsSection(
    driver,
    LOCALES[previousLocale],
    LOCALES[previousLocale].languageSection,
  );
  keyboardActivations.push(languageSection.keyboardActivation);
  state = languageSection.state;
  if (localeFromSettingsState(state) !== previousLocale) {
    fail('Selected language in Language and region does not match the visible Settings locale.');
  }
  const localeResult = await selectLocaleWithUI(driver, locale);
  keyboardActivations.push(...localeResult.keyboardActivations);
  const themeResult = await setThemeWithUI(driver, locale, theme);
  keyboardActivations.push(...themeResult.keyboardActivations);
  const pluginResult = await switchPluginThroughUI(driver, locale, pluginName, enablePlugin);
  keyboardActivations.push(...pluginResult.keyboardActivations);
  const finalLanguageSection = await navigateSettingsSection(driver, target, target.languageSection);
  keyboardActivations.push(finalLanguageSection.keyboardActivation);
  const languageState = finalLanguageSection.state;
  const selected = languageState.languageSetting;
  if (
    localeFromSettingsState(languageState) !== locale ||
    !selected ||
    selected.label !== target.language ||
    selected.selectedLabel !== target.languageOption
  ) {
    fail('Settings language selection does not match the requested combination.');
  }
  if (!languageState.sidebarLabels.includes(target.settings)) {
    fail('Visible Settings navigation label does not match the selected locale.');
  }
  const finalAppearanceSection = await navigateSettingsSection(driver, target, target.appearance);
  keyboardActivations.push(finalAppearanceSection.keyboardActivation);
  const appearanceState = finalAppearanceSection.state;
  if (
    appearanceState.theme !== theme ||
    appearanceState.themeSetting?.label !== target.theme ||
    appearanceState.themeSetting?.checked?.length !== 1 ||
    appearanceState.themeSetting.checked[0] !== (theme === 'dark' ? target.dark : target.light)
  ) {
    fail('Settings radio and document theme do not match the requested combination.');
  }
  const finalPluginSection = await navigateSettingsSection(driver, target, target.plugins);
  keyboardActivations.push(finalPluginSection.keyboardActivation);
  state = finalPluginSection.state;
  const globalSwitch = await findUniqueAttribute(
    driver,
    '[role="switch"]',
    'aria-label',
    target.globalPlugins,
    'final global plugin setting readback',
  );
  const pluginSwitch = await findUniqueAttribute(
    driver,
    '[role="switch"]',
    'aria-label',
    pluginName,
    'final Polaris plugin setting readback',
  );
  const globalEnabled = await elementAttribute(driver, globalSwitch.id, 'aria-checked');
  const pluginEnabled = await elementAttribute(driver, pluginSwitch.id, 'aria-checked');
  if (
    state.settingsOpen !== 1 ||
    globalEnabled !== 'true' ||
    pluginEnabled !== (enablePlugin ? 'true' : 'false') ||
    pluginEnabled !== pluginResult.pluginSwitch.ariaCheckedAfter
  ) {
    fail('Settings plugin switches do not retain their requested states after section readback.');
  }
  if (!state.sidebarLabels.includes(target.settings)) {
    fail('Visible Settings navigation label does not match the selected locale.');
  }
  const closed = await closeSettings(driver, locale);
  keyboardActivations.push(closed.keyboardActivation);
  return {
    settingsWasOpen: state.settingsOpen,
    settingsLabel: target.settings,
    locale: localeResult,
    theme: themeResult,
    plugin: pluginResult,
    selectedLanguage: selected,
    selectedTheme: appearanceState.themeSetting,
    themeAttribute: appearanceState.theme,
    keyboardActivations,
  };
}

async function confirmRuntimeAfterReload(
  context,
  beforeTimeOrigin,
  previousIdentity,
  expectedProfile,
  expectedTheme,
  driverSessionId,
) {
  const driver = driverFrom(context);
  const state = await waitFor(
    () => observe(driver),
    (value) =>
      value.readyState === 'complete' &&
      value.mainVisible &&
      value.timeOrigin !== beforeTimeOrigin &&
      value.theme === expectedTheme &&
      parseColorLuminance(value.backgroundVariable) !== null,
    'new complete document with the requested theme applied after zoom reload',
  );
  const runtime = await bounded(
    context.verifyRuntimeIdentity(),
    'Verify runtime identity after reload',
    10_000,
  );
  const identity = await bounded(
    context.readOwnedAppIdentity(),
    'Read owned process identity after reload',
    5_000,
  );
  sameOwnedIdentity(previousIdentity, identity, 'Post-reload');
  if (driver.sessionId !== driverSessionId)
    fail('WebDriver session unexpectedly changed during window.location.reload.');
  if (!runtime || runtime.platform !== 'linux')
    fail('Reloaded app is not confirmed as the isolated Linux runtime.');
  if (!expectedProfile || runtime.dataPath !== expectedProfile) {
    fail('Reloaded app backend data path does not match the isolated profile.');
  }
  if (runtime.webviewDataPath !== context.candidate.expectedWebviewDataPath) {
    fail('Reloaded app WebView data path does not match the isolated profile.');
  }
  return { document: state, runtime, identity };
}

function zoomMetrics(value) {
  return {
    innerWidth: value?.innerWidth ?? null,
    innerHeight: value?.innerHeight ?? null,
    devicePixelRatio: value?.devicePixelRatio ?? null,
    visualViewportWidth: value?.visualViewportWidth ?? null,
    visualViewportHeight: value?.visualViewportHeight ?? null,
    mainContentWidth: value?.mainContentWidth ?? null,
  };
}

function zoomMeasurement(baseline, observed, targetPercent) {
  const factor = targetPercent / 100;
  const candidates = [
    { method: 'viewport-inner-width', expected: baseline.innerWidth / factor, actual: observed.innerWidth },
    {
      method: 'visual-viewport-width',
      expected: baseline.visualViewportWidth / factor,
      actual: observed.visualViewportWidth,
    },
    {
      method: 'device-pixel-ratio',
      expected: baseline.devicePixelRatio * factor,
      actual: observed.devicePixelRatio,
      pixelScale: baseline.innerWidth,
    },
  ]
    .filter((value) => Number.isFinite(value.expected) && Number.isFinite(value.actual))
    .map((value) => ({
      ...value,
      errorPixels: Math.abs(value.actual - value.expected) * (value.pixelScale ?? 1),
    }));
  const accepted = candidates.find((value) => value.errorPixels <= 2);
  const diagnostic = {
    method: 'main-content-width',
    expected: baseline.mainContentWidth / factor,
    actual: observed.mainContentWidth,
  };
  diagnostic.errorPixels = Math.abs(diagnostic.actual - diagnostic.expected);
  return {
    status: accepted ? 'verified' : 'unsupported',
    method: accepted?.method ?? null,
    errorPixels: accepted?.errorPixels ?? null,
    measurements: candidates.map(({ method, expected, actual, errorPixels }) => ({
      method,
      expected,
      actual,
      errorPixels,
    })),
    diagnostics:
      Number.isFinite(diagnostic.expected) && Number.isFinite(diagnostic.actual) ? [diagnostic] : [],
  };
}

function zoomMatchesBaseline(baseline, observed) {
  return zoomMeasurement(baseline, observed, 100).status === 'verified';
}

async function resetZoomToBaselineWithWebDriver(driver, baseline) {
  const before = zoomMetrics((await observe(driver)).zoom);
  const actionResult = await sendCtrl0KeyboardActions(driver);
  let previous = null;
  let stableCount = 0;
  const afterSnapshot = await waitFor(
    () => observe(driver),
    (value) => {
      const metrics = zoomMetrics(value.zoom);
      const stable =
        previous &&
        [
          'innerWidth',
          'innerHeight',
          'visualViewportWidth',
          'visualViewportHeight',
          'mainContentWidth',
        ].every((key) => Math.abs(previous[key] - metrics[key]) <= 0.1) &&
        Math.abs(previous.devicePixelRatio - metrics.devicePixelRatio) <= 0.001;
      stableCount = stable ? stableCount + 1 : 0;
      previous = metrics;
      const valid =
        Object.values(metrics).every(Number.isFinite) &&
        metrics.innerWidth > 0 &&
        metrics.mainContentWidth > 0;
      return valid && (!baseline || zoomMatchesBaseline(baseline, metrics)) && stableCount >= 2;
    },
    baseline
      ? 'real Ctrl+0 returned effective zoom to the measured 100% baseline'
      : 'real Ctrl+0 established the first measured 100% baseline',
    5_000,
  );
  const observed = zoomMetrics(afterSnapshot.zoom);
  const baselineMetrics = baseline ?? Object.freeze({ ...observed });
  return {
    method: 'webdriver-w3c-actions-control-0',
    status: baseline ? 'verified' : 'baseline-established',
    baselineId: ZOOM_BASELINE_ID,
    actionResult,
    before,
    observed,
    baseline: baselineMetrics,
  };
}

async function sendCtrl0KeyboardActions(driver) {
  let dispatchResult = null;
  let dispatchError = null;
  try {
    dispatchResult = await bounded(
      driver.request('POST', driver.path('/actions'), {
        actions: [
          {
            type: 'key',
            id: 'native-acceptance-zoom-reset',
            actions: [
              { type: 'keyDown', value: '\uE009' },
              { type: 'keyDown', value: '0' },
              { type: 'keyUp', value: '0' },
              { type: 'keyUp', value: '\uE009' },
            ],
          },
        ],
      }),
      'Send real W3C Ctrl+0 key actions',
    );
  } catch (error) {
    dispatchError = error;
  }
  let releaseResult = null;
  let releaseError = null;
  try {
    releaseResult = await bounded(
      driver.request('DELETE', driver.path('/actions')),
      'Release W3C keyboard actions',
    );
  } catch (error) {
    releaseError = error;
  }
  if (dispatchError) throw dispatchError;
  if (releaseError) throw releaseError;
  return { endpoint: 'webdriver-session-actions', dispatchResult, releaseResult, released: true };
}

async function setZoomAndReload(context, target, baseline, previousIdentity) {
  const driver = driverFrom(context);
  const before = await observe(driver);
  if (before.settingsOpen !== 0) fail('Settings overlay must be closed before the zoom reload.');
  const resetEvidence =
    target.targetZoomPercent === 100 ? await resetZoomToBaselineWithWebDriver(driver, baseline) : null;
  const baselineMetrics = baseline ?? resetEvidence?.baseline ?? null;
  if (!baselineMetrics) fail('The first measured 100% combination must establish the zoom baseline.');
  if (resetEvidence) {
    await context.recordStep('native-acceptance-independent-' + target.id + '-ctrl0-baseline', resetEvidence);
  }
  const expectedFactor = target.targetZoomPercent / 100;
  const level = Math.log(expectedFactor) / Math.log(1.2);
  const storedLevel = String(level);
  const storage = await bounded(
    driver.execute(
      'localStorage.setItem("morrow.zoom", arguments[0]); return {raw: localStorage.getItem("morrow.zoom"), factor: Math.pow(1.2, Number(localStorage.getItem("morrow.zoom")))};',
      [storedLevel],
    ),
    'Set documented Morrow zoom preference',
  );
  if (storage?.raw !== storedLevel || Math.abs(storage.factor - expectedFactor) > 1e-10) {
    fail('Stored morrow.zoom level does not encode the requested factor.');
  }
  const sessionId = driver.sessionId;
  if (!sessionId) fail('WebDriver session ID is not available before reload.');
  await bounded(context.beginRuntimeRefresh(), 'Arm runtime identity recheck before reload', 5_000);
  await bounded(
    driver.execute('window.setTimeout(function () { window.location.reload(); }, 100); return true;'),
    'Schedule real window.location.reload',
  );
  const confirmed = await confirmRuntimeAfterReload(
    context,
    before.timeOrigin,
    previousIdentity,
    context.candidate.profile,
    target.theme,
    sessionId,
  );
  const zoom = confirmed.document.zoom;
  const observedMetrics = zoomMetrics(zoom);
  const measurement = zoomMeasurement(baselineMetrics, observedMetrics, target.targetZoomPercent);
  if (zoom.storageRaw !== storedLevel || Math.abs((zoom.storageFactor ?? 0) - expectedFactor) > 1e-8) {
    fail('Reloaded document did not retain the documented morrow.zoom factor.');
  }
  if (!Number.isFinite(zoom.storageLevel) || Math.abs(zoom.storageLevel - level) > 1e-10) {
    fail('Reloaded document did not retain the documented morrow.zoom level.');
  }
  const themeLuminance = parseColorLuminance(confirmed.document.backgroundVariable);
  if (
    confirmed.document.theme !== target.theme ||
    themeLuminance === null ||
    (target.theme === 'light' ? themeLuminance < 0.55 : themeLuminance > 0.3)
  ) {
    fail('Effective theme attribute/background does not match the target theme.');
  }
  return {
    targetPercent: target.targetZoomPercent,
    targetZoomPercent: target.targetZoomPercent,
    status: measurement.status,
    targetFactor: expectedFactor,
    storedLevel,
    storedFactor: storage.factor,
    storageRawAfterReload: zoom.storageRaw,
    baseline: baselineMetrics,
    baselineId: ZOOM_BASELINE_ID,
    ...(resetEvidence ? { reset: resetEvidence } : {}),
    observed: {
      ...observedMetrics,
      visualViewportScale: zoom.visualViewportScale,
      screenWidth: zoom.screenWidth,
      measurement,
      backgroundVariable: confirmed.document.backgroundVariable,
      appBackground: confirmed.document.appBackground,
      appColor: confirmed.document.appColor,
      backgroundLuminance: themeLuminance,
    },
    timeOriginBefore: before.timeOrigin,
    timeOriginAfter: confirmed.document.timeOrigin,
    storage: {
      key: 'morrow.zoom',
      level,
      observedLevel: zoom.storageLevel,
      reload: 'webdriver-page-reload',
      reloadMethod: 'driver.execute-window.location.reload',
    },
    runtime: {
      platform: confirmed.runtime.platform,
      dataPath: confirmed.runtime.dataPath,
      webviewDataPath: confirmed.runtime.webviewDataPath,
      backendProfileConfirmed: confirmed.runtime.dataPath === context.candidate.profile,
      webviewProfileConfirmed:
        confirmed.runtime.webviewDataPath === context.candidate.expectedWebviewDataPath,
      identity: confirmed.identity,
    },
    identityRevalidated: true,
    driverSessionId: sessionId,
  };
}

export function buildIndependentNativeAcceptanceCombinationEvidence({
  target,
  zoom,
  runtime,
  ui,
  views,
  inventory,
  fallback,
  screenshots,
  navigation,
  keyboardActivations,
}) {
  return {
    id: target.id,
    locale: target.locale,
    theme: target.theme,
    zoomPercent: target.targetZoomPercent,
    targetZoomPercent: target.targetZoomPercent,
    runtime,
    ui,
    zoom,
    views,
    inventory,
    fallback,
    screenshots,
    navigation,
    keyboardActivations,
  };
}

export async function runIndependentNativeAcceptanceScenario(context) {
  if (
    !context ||
    typeof context.beginRuntimeRefresh !== 'function' ||
    typeof context.verifyRuntimeIdentity !== 'function' ||
    typeof context.readOwnedAppIdentity !== 'function' ||
    typeof context.recordStep !== 'function'
  ) {
    fail('Common native runner context is incomplete for independent acceptance.');
  }
  const startedAt = new Date().toISOString();
  const driver = driverFrom(context);
  const candidate = context.candidate;
  if (
    !candidate ||
    typeof candidate.vault !== 'string' ||
    typeof candidate.evidence !== 'string' ||
    typeof candidate.databaseId !== 'string' ||
    typeof candidate.profile !== 'string'
  ) {
    fail('Candidate does not identify the synthetic vault, profile, database and evidence paths.');
  }
  const initialIdentity = await bounded(context.readOwnedAppIdentity(), 'Read initial owned app identity');
  if (
    !initialIdentity ||
    !Number.isSafeInteger(initialIdentity.pid) ||
    initialIdentity.pid <= 0 ||
    !Number.isSafeInteger(initialIdentity.driverPid) ||
    initialIdentity.driverPid <= 0 ||
    typeof initialIdentity.startTimeTicks !== 'string' ||
    initialIdentity.startTimeTicks.length === 0 ||
    !/^[a-f0-9]{64}$/i.test(initialIdentity.executablePathSha256 ?? '') ||
    !/^[a-f0-9]{64}$/i.test(initialIdentity.argvSha256 ?? '') ||
    !Number.isSafeInteger(initialIdentity.effectiveUid) ||
    initialIdentity.effectiveUid <= 0 ||
    initialIdentity.runtimeIdentityConfirmed !== true
  ) {
    fail('Initial app identity is not confirmed as a non-root process.');
  }
  const initialSessionId = driver.sessionId;
  if (typeof initialSessionId !== 'string' || initialSessionId.length === 0) {
    fail('Native acceptance requires the runner-owned WebDriver session.');
  }
  const runtime = await bounded(context.verifyRuntimeIdentity(), 'Verify initial isolated runtime');
  if (
    !runtime ||
    runtime.platform !== 'linux' ||
    runtime.dataPath !== candidate.profile ||
    runtime.webviewDataPath !== candidate.expectedWebviewDataPath
  ) {
    fail('Initial backend/WebView identity does not match the synthetic isolated profile.');
  }
  const initialDom = await waitFor(
    () => observe(driver),
    (value) => value.readyState === 'complete' && value.mainVisible,
    'initial Morrow document',
  );
  if (initialDom.settingsOpen !== 0) fail('Native acceptance starts with Settings closed.');
  if (initialDom.zoom.storageRaw !== null && Number(initialDom.zoom.storageRaw) !== 0) {
    fail('Fresh independent profile must start at the documented 100% zoom baseline.');
  }
  const initialViewport = zoomMetrics(initialDom.zoom);
  if (Object.values(initialViewport).some((value) => !Number.isFinite(value) || value <= 0)) {
    fail('Initial viewport metrics are not measurable before the real Ctrl+0 baseline.');
  }
  const initialMarkdown = freezeMarkdownSnapshot(await captureMarkdown(candidate.vault));
  if (initialMarkdown['Inventory/Widget.md'].quantity !== 2) {
    fail('Independent fixture must start with persisted Quantity=2.');
  }
  const inventoryText = await readFile(path.join(candidate.vault, 'Inventory.md'), 'utf8');
  const formula = /^\s*formula\s*:\s*(.*?)\s*$/im.exec(inventoryText)?.[1];
  if (formula !== 'Quantity * Price') {
    fail('Independent fixture formula must remain Quantity * Price.');
  }
  const widgetText = await readFile(path.join(candidate.vault, 'Inventory/Widget.md'), 'utf8');
  if (!/^\s*Price\s*:\s*10\s*$/im.test(widgetText)) fail('Independent fixture Price must be 10.');
  const workspace = JSON.parse(
    await readFile(path.join(candidate.vault, '.morrow', 'workspace.json'), 'utf8'),
  );
  const pages = workspace?.pages ?? {};
  const pageIds = {
    inventory: pages['Inventory.md']?.id,
    widget: pages['Inventory/Widget.md']?.id,
    views: pages['Views.md']?.id,
  };
  if (!pageIds.inventory || !pageIds.widget || !pageIds.views || pageIds.inventory !== candidate.databaseId) {
    fail('Workspace must expose candidate Inventory, Widget and Views page IDs.');
  }
  const expectedViews = normalizeViews(candidate);
  if (expectedViews.some((view) => view.sourceDatabaseId !== candidate.databaseId)) {
    fail('Both linked views must point to the synthetic Inventory database.');
  }
  const markerConfigs = await readViewMarkers(candidate.vault);
  if (markerConfigs.length !== expectedViews.length) fail('Expected two stored linked-view configurations.');
  const pluginManifest = JSON.parse(
    await readFile(
      path.join(candidate.vault, '.morrow', 'plugins', 'polaris-dados', 'manifest.json'),
      'utf8',
    ),
  );
  const pluginName = pluginManifest.name;
  if (typeof pluginName !== 'string' || pluginName.length === 0)
    fail('Synthetic plugin manifest has no display name.');
  const baselineProfile = await lstat(candidate.profile);
  if (
    !baselineProfile.isDirectory() ||
    baselineProfile.isSymbolicLink() ||
    baselineProfile.uid === 0 ||
    baselineProfile.uid !== initialIdentity.effectiveUid ||
    (await realpath(candidate.profile)) !== path.resolve(candidate.profile)
  ) {
    fail('Native acceptance profile must be a fresh non-root-owned directory.');
  }
  let priorIdentity = initialIdentity;
  let baselineZoom = null;
  const combinations = [];
  const zoomGaps = [];
  for (const target of COMBINATIONS) {
    const settings = await setCombinationSettings(driver, target.locale, target.theme, pluginName, true);
    const navigation = [];
    const keyboardActivations = [...settings.keyboardActivations];
    if (settings.settingsWasOpen !== 1) fail('Settings UI was not open while selecting a combination.');
    const closed = await waitFor(
      () => observe(driver),
      (value) => value.settingsOpen === 0,
      'Settings closed before zoom reload',
    );
    if (closed.settingsOpen !== 0) fail('Settings overlay remained open.');
    navigation.push(await openPageById(driver, pageIds.views, 'Views.md'));
    await waitFor(
      () => observe(driver),
      (value) =>
        value.settingsOpen === 0 &&
        value.route.includes(pageIds.views) &&
        value.providerRootCount === 2 &&
        value.viewNodeCount === 2,
      'Views.md fully mounted before changing zoom and reloading',
    );
    const zoom = await setZoomAndReload(context, target, baselineZoom, priorIdentity);
    if (baselineZoom === null) baselineZoom = zoom.baseline;
    if (zoom.status === 'unsupported') zoomGaps.push(target.id);
    priorIdentity = zoom.runtime.identity;
    let state = await waitFor(
      () => observe(driver),
      (value) =>
        value.settingsOpen === 0 &&
        value.route.includes(pageIds.views) &&
        value.providerRootCount === 2 &&
        value.viewNodeCount === 2,
      'two real linked views after reload for ' + target.id,
    );
    const labels = LOCALES[target.locale];
    if (
      state.theme !== target.theme ||
      state.views.some(
        (node) => node.providerCount !== 1 || node.providers[0]?.regionLabel !== labels.providerRegion,
      )
    ) {
      fail('Reloaded UI/theme/plugin locale does not match ' + target.id + '.');
    }
    const views = await verifyViews(
      driver,
      candidate,
      pageIds.views,
      expectedViews,
      initialMarkdown['Inventory/Widget.md'].quantity,
      target.locale,
    );
    navigation.push(views.navigation);
    keyboardActivations.push(...views.keyboardActivations);
    const viewsHostStatusSnapshot = await saveStatusForLocale(
      driver,
      target.locale,
      'Views before screenshot for ' + target.id,
    );
    const viewsHostStatus = hostSavedStatusEvidence(
      viewsHostStatusSnapshot,
      target.locale,
      initialMarkdown['Inventory/Widget.md'].quantity,
    );
    const viewsMarkdown = await compareLiveMarkdown(candidate.vault, initialMarkdown);
    if (viewsMarkdown['Inventory/Widget.md'].quantity !== 2) {
      fail('Persisted Inventory must remain at Quantity=2 before the Views screenshot.');
    }
    const viewsScreenshot = await screenshot(
      driver,
      path.join(candidate.evidence, 'native-acceptance-independent-' + target.id + '-views.png'),
    );
    await context.recordStep('native-acceptance-independent-' + target.id + '-views', {
      locale: target.locale,
      theme: target.theme,
      zoom: zoom.observed,
      providerCount: views.providerCount,
      viewTitles: views.renderedViews.map((view) => view.title),
    });
    const inventory = await verifyInventoryDraft(
      driver,
      candidate,
      pageIds.inventory,
      initialMarkdown,
      target.locale,
      path.join(candidate.evidence, 'native-acceptance-independent-' + target.id + '-inventory-draft.png'),
    );
    navigation.push(inventory.navigation);
    keyboardActivations.push(...inventory.keyboardActivations);
    await context.recordStep('native-acceptance-independent-' + target.id + '-draft-cancelled', {
      persistedQuantity: inventory.persistedQuantity,
      draftQuantity: inventory.draftQuantity,
      cancelVia: inventory.cancelVia,
      savedBefore: inventory.preDraftStatus.text,
      savedAfter: inventory.postCancelStatus.text,
      markdownUnchanged: inventory.unchanged,
    });
    const fallback = await verifyReadOnlyFallback(
      driver,
      candidate,
      target.locale,
      pluginName,
      path.join(candidate.evidence, 'native-acceptance-independent-' + target.id + '-fallback.png'),
      initialMarkdown,
    );
    keyboardActivations.push(...fallback.keyboardActivations);
    await context.recordStep('native-acceptance-independent-' + target.id + '-readonly-fallback', {
      providerCount: fallback.providerCount,
      readOnly: fallback.readOnly,
      settingsClosed: fallback.settingsClosed,
      pluginEnabled: fallback.pluginEnabled,
      pluginsJsonEnabledAtCapture: fallback.pluginsJsonEnabledAtCapture,
      markdownUnchanged: fallback.markdownUnchanged,
      formulaSourceLiteralText: fallback.fallbackRows[0]?.formulaSourceLiteralText,
      locale: target.locale,
      theme: target.theme,
    });
    const reactivation = await reactivatePluginAfterFallback(
      driver,
      candidate,
      target.locale,
      pluginName,
      initialMarkdown,
    );
    keyboardActivations.push(...reactivation.keyboardActivations);
    await context.recordStep(
      'native-acceptance-independent-' + target.id + '-plugin-reactivated-after-fallback',
      reactivation,
    );
    const markdownFinal = await compareLiveMarkdown(candidate.vault, initialMarkdown);
    assertMarkdownSame(initialMarkdown, markdownFinal, 'Final ' + target.id + ' Markdown state');
    const finalState = await observe(driver);
    const combinationEvidence = buildIndependentNativeAcceptanceCombinationEvidence({
      target,
      runtime: {
        backendDataPathMatched: zoom.runtime.backendProfileConfirmed,
        webviewDataPathMatched: zoom.runtime.webviewProfileConfirmed,
        pid: zoom.runtime.identity.pid,
        startTimeTicks: zoom.runtime.identity.startTimeTicks,
      },
      ui: {
        localeOption: settings.locale.selectedOptionTextAfter,
        settingsLabel: settings.settingsLabel,
        theme: target.theme,
        selectedTheme: settings.theme.selectedOption,
      },
      zoom,
      views: {
        providerCount: views.providerCount,
        roots: views.renderedViews,
        rootCountByView: views.rootCountByView,
        configs: views.configs,
        renderedViews: views.renderedViews,
        settingsOverlayClosed: views.settingsOverlayClosed,
        hostStatus: viewsHostStatus,
        markdownAtCapture: snapshotArray(viewsMarkdown),
        markdownUnchangedAtCapture: true,
      },
      inventory,
      fallback,
      screenshots: {
        views: viewsScreenshot,
        inventoryDraft: inventory.screenshot,
        fallback: fallback.screenshot,
      },
      navigation,
      keyboardActivations,
    });
    combinations.push({
      ...combinationEvidence,
      pluginReactivation: reactivation,
      zoomObservation: zoom,
      dom: {
        documentLang: finalState.documentLang,
        theme: finalState.theme,
        backgroundVariable: finalState.backgroundVariable,
        appBackground: finalState.appBackground,
        resolvedLabels: {
          settings: labels.settings,
          general: labels.general,
          languageSection: labels.languageSection,
          appearance: labels.appearance,
          plugins: labels.plugins,
          language: labels.language,
          languageOption: labels.languageOption,
          pluginRegion: labels.providerRegion,
          save: labels.save,
          cancel: labels.cancel,
          fallbackRegion: labels.databaseRegion,
        },
        localeEvidence: {
          settingsLanguageSelected: labels.languageOption,
          providerRegion: labels.providerRegion,
          providerCount: views.providerCount,
        },
      },
      settings: {
        languageControl: settings.locale.selectorLabel,
        selectedLanguage: settings.locale.selectedOptionTextAfter,
        languageOptionPreviouslySelected: settings.locale.ariaSelectedBefore === 'true',
        themeControl: settings.theme.selectorLabel,
        selectedTheme: settings.theme.selectedOption,
        themeAttribute: settings.themeAttribute,
        pluginEnabled: settings.plugin.pluginSwitch.ariaCheckedAfter === 'true',
      },
      markdownFinal: snapshotArray(markdownFinal),
    });
    await pause(80);
  }
  if (combinations.length !== 3)
    fail('Independent acceptance must complete all three complementary combinations.');
  if (driver.sessionId !== initialSessionId)
    fail('Runner WebDriver session changed during independent acceptance.');
  const finalMarkdown = await compareLiveMarkdown(candidate.vault, initialMarkdown);
  assertMarkdownSame(initialMarkdown, finalMarkdown, 'Independent acceptance final Markdown state');
  const screenshotCount = combinations.reduce(
    (count, combination) => count + Object.keys(combination.screenshots).length,
    0,
  );
  if (screenshotCount !== 9) fail('Independent acceptance must retain exactly nine screenshots.');
  const receipt = {
    schema: 'morrow.e003.native-acceptance/v1',
    mode: 'independent',
    createdAt: startedAt,
    startIdentity: initialIdentity,
    accepted: zoomGaps.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    ownership: {
      pid: initialIdentity.pid,
      startTimeTicks: initialIdentity.startTimeTicks,
      effectiveUid: initialIdentity.effectiveUid,
      driverPid: initialIdentity.driverPid,
      driverSessionId: initialSessionId,
      runtimeIdentityConfirmed: initialIdentity.runtimeIdentityConfirmed,
      profile: candidate.profile,
      backendDataPath: runtime.dataPath,
      webviewDataPath: runtime.webviewDataPath,
      backendProfileConfirmed: runtime.dataPath === candidate.profile,
      webviewProfileConfirmed: runtime.webviewDataPath === candidate.expectedWebviewDataPath,
    },
    fixture: {
      vault: candidate.vault,
      databaseId: candidate.databaseId,
      pageIds,
      pluginName,
      initialQuantity: 2,
      price: 10,
      formula: 'Quantity * Price',
      views: expectedViews.map((view) => ({
        viewId: view.viewId,
        title: view.title,
        sourceDatabaseId: view.sourceDatabaseId,
        columnOrder: view.columnOrder,
        filter: normalizeFilter(view.filter),
      })),
    },
    baseline: {
      zoomRawAtStart: initialDom.zoom.storageRaw,
      viewportAt100: baselineZoom,
      markdown: snapshotArray(initialMarkdown),
    },
    combinations,
    screenshotCount,
    zoomGaps,
    markdownInitial: snapshotArray(initialMarkdown),
    markdownFinal: snapshotArray(finalMarkdown),
    allThreeMarkdownFilesUnchanged: true,
    limits: [
      'The HTML lang attribute is recorded but locale is accepted from the Settings selection and visible translated labels because upstream keeps index.html lang static.',
      'The evidence covers Linux native app UI/WebView behavior and the public plugin surfaces; it does not exercise a Rust-native chooser.',
    ],
  };
  await context.recordStep('native-acceptance-independent-complete', {
    accepted: zoomGaps.length === 0,
    combinations: combinations.map((item) => item.id),
    screenshotCount,
    zoomGaps: zoomGaps.length,
    markdownUnchanged: true,
  });
  return receipt;
}
