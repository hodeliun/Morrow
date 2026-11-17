import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'scripts', 'pilot', 'native-readiness.mjs');
const PRIVATE_MARKER = 'synthetic-private-marker-must-not-be-retained';

function rawSnapshot(roots) {
  return {
    roots,
    route: `#/page/synthetic-private-page-id?noise=${PRIVATE_MARKER}`,
    documentLanguage: 'en',
    heading: 'Inventory',
    bootText: roots.boot ? 'Morrow could not open the synthetic workspace' : '',
    preferences: {
      plugins: true,
      startPage: 'home',
      locale: 'en',
      theme: 'dark',
      privateNote: PRIVATE_MARKER,
    },
    settings: {
      open: false,
      section: 'Plugins',
      switches: [{ label: PRIVATE_MARKER, checked: true, disabled: false }],
    },
    provider: {
      count: 1,
      tableLabel: 'Synthetic Inventory',
      rowCount: 1,
      quantity: '2',
      price: '10',
      total: '20',
      totalKind: 'number',
    },
    rawHtml: PRIVATE_MARKER,
    profilePath: PRIVATE_MARKER,
    environment: { DBUS_SESSION_BUS_ADDRESS: PRIVATE_MARKER },
  };
}

async function makeEvidence(parent, name) {
  const evidence = path.join(parent, name);
  await mkdir(evidence);
  return evidence;
}

async function readCapture(evidence) {
  const filePath = path.join(evidence, 'native-readiness-failure.json');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('failure capture does not query the driver or take a screenshot without confirmed runtime identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-readiness-capture-no-identity-'));
  try {
    const evidence = await makeEvidence(root, 'evidence');
    const events = [];
    const driver = {
      async execute() {
        events.push('dom');
        throw new Error('DOM must not be queried before identity is confirmed');
      },
      async screenshot() {
        events.push('screenshot');
        throw new Error('screenshot must not be taken before identity is confirmed');
      },
    };
    const { captureNativeReadinessFailure } = await import(pathToFileURL(HELPER_PATH).href);
    const result = await captureNativeReadinessFailure({
      driver,
      candidate: { evidence },
      scenarioName: 'readiness',
      identityConfirmed: false,
      error: Object.assign(new Error(PRIVATE_MARKER), { name: 'TypeError' }),
    });

    assert.deepEqual(result, { status: 'skipped', reason: 'runtime-identity-not-confirmed' });
    assert.deepEqual(events, [], 'no DOM or screenshot call may occur before identity confirmation');
    const capture = await readCapture(evidence);
    assert.equal(capture.status, 'skipped');
    assert.equal(capture.reason, 'runtime-identity-not-confirmed');
    assert.equal(capture.errorName, 'TypeError');
    assert.equal(Object.hasOwn(capture, 'domSnapshot'), false);
    assert.equal(Object.hasOwn(capture, 'screenshot'), false);
    assert.equal(JSON.stringify(capture).includes(PRIVATE_MARKER), false, 'failure text and private markers must not be retained');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failure capture skips screenshots when the identity is known but the current UI root is unrecognized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-readiness-capture-unknown-ui-'));
  try {
    const evidence = await makeEvidence(root, 'evidence');
    let domCalls = 0;
    let screenshotCalls = 0;
    const driver = {
      async execute() {
        domCalls += 1;
        return rawSnapshot({ appMain: false, boot: false, vaultChooser: false });
      },
      async screenshot() {
        screenshotCalls += 1;
      },
    };
    const { captureNativeReadinessFailure } = await import(pathToFileURL(HELPER_PATH).href);
    const result = await captureNativeReadinessFailure({
      driver,
      candidate: { evidence },
      scenarioName: 'readiness',
      identityConfirmed: true,
      error: new Error(PRIVATE_MARKER),
    });

    assert.deepEqual(result, { status: 'skipped', reason: 'unknown-ui-root' });
    assert.equal(domCalls, 1, 'the passive snapshot may be read after identity confirmation');
    assert.equal(screenshotCalls, 0, 'an unknown UI must not be captured');
    const capture = await readCapture(evidence);
    assert.equal(capture.status, 'skipped');
    assert.equal(capture.reason, 'unknown-ui-root');
    assert.equal(Object.hasOwn(capture, 'domSnapshot'), false);
    assert.equal(JSON.stringify(capture).includes(PRIVATE_MARKER), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failure capture retains a bounded sanitized snapshot and screenshot only for recognized app or boot roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-readiness-capture-known-ui-'));
  try {
    const { captureNativeReadinessFailure } = await import(pathToFileURL(HELPER_PATH).href);
    const recognizedRoots = [
      { appMain: true, boot: false, vaultChooser: false },
      { appMain: false, boot: true, vaultChooser: true },
    ];

    for (const [index, roots] of recognizedRoots.entries()) {
      const evidence = await makeEvidence(root, `evidence-${index}`);
      const events = [];
      const driver = {
        async execute() {
          events.push('dom');
          return rawSnapshot(roots);
        },
        async screenshot(filePath) {
          events.push('screenshot');
          assert.equal(path.dirname(filePath), evidence, 'the screenshot must stay inside this run evidence directory');
          await writeFile(filePath, Buffer.from('synthetic-screenshot-fixture'), { flag: 'wx' });
        },
      };
      const result = await captureNativeReadinessFailure({
        driver,
        candidate: { evidence, pluginName: 'Polaris Dados' },
        scenarioName: 'readiness',
        identityConfirmed: true,
        error: new Error(PRIVATE_MARKER),
      });

      assert.deepEqual(result, { status: 'captured', screenshot: true });
      assert.deepEqual(events, ['dom', 'screenshot'], 'capture order must be passive DOM first, then screenshot');
      const capture = await readCapture(evidence);
      assert.equal(capture.status, 'captured');
      assert.equal(capture.screenshot, 'native-readiness-failure.png', 'only a basename may be retained');
      assert.equal(capture.domSnapshot.roots.appMain, roots.appMain);
      assert.equal(capture.domSnapshot.roots.boot, roots.boot);
      assert.equal(capture.domSnapshot.preferences.plugins, true);
      assert.equal(capture.domSnapshot.preferences.startPage, 'home');
      assert.equal(capture.domSnapshot.provider.quantity, '2');
      assert.equal(capture.domSnapshot.provider.price, '10');
      assert.equal(capture.domSnapshot.provider.total, '20');
      assert.equal(capture.domSnapshot.provider.totalKind, 'number');
      assert.equal(Object.hasOwn(capture.domSnapshot, 'rawHtml'), false);
      assert.equal(Object.hasOwn(capture.domSnapshot, 'profilePath'), false);
      assert.equal(Object.hasOwn(capture.domSnapshot.preferences, 'privateNote'), false);
      assert.equal(Object.hasOwn(capture.domSnapshot.settings, 'switches'), false);
      assert.equal(JSON.stringify(capture).includes(PRIVATE_MARKER), false, 'unknown DOM, environment, profile, and error data must be omitted');
      const screenshot = path.join(evidence, capture.screenshot);
      assert.equal((await stat(screenshot)).isFile(), true);
      assert.equal((await readFile(screenshot, 'utf8')), 'synthetic-screenshot-fixture');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness closes on settled Home and accepts only the fixed typed synthetic source row', async () => {
  const {
    assertNativeSourceReadiness,
    isNativeBootReady,
    isNativeHomeSourceClosed,
    normalizeNativeRoute,
    sanitizeNativeReadinessSnapshot,
  } = await import(pathToFileURL(HELPER_PATH).href);
  const settledHome = sanitizeNativeReadinessSnapshot({
    roots: { appMain: true, boot: false, vaultChooser: false },
    route: '#/',
    provider: { count: 0 },
  });
  const chooser = {
    roots: { appMain: false, boot: true, vaultChooser: true },
    route: 'home',
    provider: { count: 0 },
  };
  const openSource = sanitizeNativeReadinessSnapshot({
    roots: { appMain: true, boot: false, vaultChooser: false },
    route: '#/page/synthetic-source-id?private=discard-this',
    provider: {
      count: 1,
      rowCount: 1,
      quantity: '2',
      price: '10',
      total: '20',
      totalKind: 'number',
    },
  });

  assert.equal(normalizeNativeRoute(''), 'home');
  assert.equal(normalizeNativeRoute('#/'), 'home');
  assert.equal(normalizeNativeRoute('#/page/synthetic-source-id?private=discard-this'), 'page');
  assert.equal(JSON.stringify(openSource).includes('synthetic-source-id'), false, 'route identifiers must not be retained');
  assert.equal(isNativeBootReady(settledHome), true);
  assert.equal(isNativeBootReady(chooser), false, 'the chooser is not a settled app');
  assert.equal(isNativeHomeSourceClosed(settledHome), true);
  assert.equal(isNativeHomeSourceClosed({ ...settledHome, route: 'other' }), false);
  assert.equal(isNativeHomeSourceClosed({ ...settledHome, provider: { count: 1 } }), false);
  assert.equal(isNativeHomeSourceClosed(openSource), false, 'the readiness callback boundary requires the source closed');
  assert.doesNotThrow(() => assertNativeSourceReadiness(openSource));

  for (const invalid of [
    { ...openSource, provider: { ...openSource.provider, count: 2 } },
    { ...openSource, provider: { ...openSource.provider, total: '21' } },
    { ...openSource, provider: { ...openSource.provider, totalKind: 'text' } },
  ]) {
    assert.throws(() => assertNativeSourceReadiness(invalid), 'duplicate or incorrectly typed source data must fail');
  }
});
