import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DRIVER_ELEMENT, WebDriver } from './webdriver-client.mjs';

async function withWebDriverServer(handler, run) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    await handler({ request, response, body, rawBody });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ value }));
}

test('WebDriver requests preserve session, element, key, execute, and close contracts', async () => {
  const calls = [];
  await withWebDriverServer(async ({ request, response, body, rawBody }) => {
    calls.push({ method: request.method, url: request.url, body, rawBody });
    if (request.url === '/session') {
      sendJson(response, { sessionId: 'session-123', capabilities: {} });
    } else if (request.url === '/session/session-123/elements') {
      sendJson(response, body.value === '#legacy' ? [{ ELEMENT: 'legacy-789' }] : [{ [DRIVER_ELEMENT]: 'element-456' }]);
    } else if (request.url === '/session/session-123/element/element-456/text') {
      sendJson(response, 'hello');
    } else if (request.url === '/session/session-123/element/legacy-789/text') {
      sendJson(response, 'legacy hello');
    } else if (request.url === '/session/session-123/element/element-456/attribute/aria-label') {
      sendJson(response, 'Save');
    } else if (request.url === '/session/session-123/element/element-456/value') {
      sendJson(response, null);
    } else if (request.url === '/session/session-123/execute/sync') {
      sendJson(response, { script: body.script, args: body.args });
    } else {
      sendJson(response, null);
    }
  }, async (port) => {
    const driver = new WebDriver(port);
    assert.throws(() => driver.path('/title'), /WebDriver session is not active/);
    assert.deepEqual(await driver.createSession('/tmp/morrow pilot.exe'), { sessionId: 'session-123', capabilities: {} });
    assert.equal(await driver.text('#status'), 'hello');
    assert.equal(await driver.text('#legacy'), 'legacy hello');
    assert.equal(await driver.attribute('#save', 'aria-label'), 'Save');
    assert.equal(await driver.click('#save'), null);
    assert.equal(await driver.clear('#input'), null);
    assert.equal(await driver.sendKeys('#input', 'a😀'), null);
    assert.deepEqual(await driver.execute('return arguments[0]', ['kept']), { script: 'return arguments[0]', args: ['kept'] });
    await driver.refresh();
    await driver.closeSession();
    await driver.closeSession();
    assert.equal(driver.sessionId, null);
    assert.throws(() => driver.path('/title'), /WebDriver session is not active/);
  });

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/session');
  assert.deepEqual(calls[0].body, {
    capabilities: { alwaysMatch: { 'tauri:options': { application: '/tmp/morrow pilot.exe', args: [] } } },
  });
  assert.ok(calls.some(({ method, url }) => method === 'POST' && url === '/session/session-123/element/element-456/click'));
  assert.ok(calls.some(({ method, url }) => method === 'POST' && url === '/session/session-123/element/element-456/clear'));
  assert.ok(calls.some(({ url, body }) => url === '/session/session-123/elements' && body.using === 'css selector' && body.value === '#status'));
  assert.deepEqual(calls.find(({ url }) => url === '/session/session-123/element/element-456/value').body, {
    text: 'a😀',
    value: ['a', '😀'],
  });
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).url, '/session/session-123');
});

test('WebDriver reports inactive sessions and missing elements without issuing element actions', async () => {
  let actionCount = 0;
  await withWebDriverServer(async ({ request, response }) => {
    if (request.url === '/session') sendJson(response, { sessionId: 'session-empty' });
    else if (request.url === '/session/session-empty/elements') sendJson(response, []);
    else if (request.url.startsWith('/session/session-empty/element/')) {
      actionCount += 1;
      sendJson(response, null);
    } else sendJson(response, null);
  }, async (port) => {
    const driver = new WebDriver(port);
    await assert.rejects(driver.click('#missing'), /WebDriver session is not active/);
    await driver.createSession('/tmp/candidate.exe');
    await assert.rejects(driver.click('#missing'), /Element not found: #missing/);
    await driver.closeSession();
  });
  assert.equal(actionCount, 0);
});

test('WebDriver reports protocol errors and malformed JSON using the existing error text', async () => {
  await withWebDriverServer(async ({ request, response }) => {
    if (request.url === '/session') {
      sendJson(response, { sessionId: 'session-close-failure' });
    } else if (request.url === '/session/session-close-failure') {
      sendJson(response, { error: 'invalid session id', message: 'session already ended' }, 500);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
    }
  }, async (port) => {
    const driver = new WebDriver(port);
    await driver.createSession('/tmp/candidate.exe');
    await assert.rejects(
      driver.closeSession(),
      (error) => error.message === 'WebDriver DELETE /session/session-close-failure: invalid session id session already ended',
    );
    assert.equal(driver.sessionId, null);
    assert.throws(() => driver.path('/title'), /WebDriver session is not active/);
    await assert.rejects(driver.request('GET', '/bad-json'), (error) => {
      assert.match(error.message, /^WebDriver returned non-JSON: \{not-json$/);
      return true;
    });
  });
});

test('WebDriver screenshot writes only the decoded response to its controlled temporary path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-webdriver-screenshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const screenshot = path.join(root, 'screen.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await withWebDriverServer(async ({ request, response }) => {
    if (request.url === '/session') sendJson(response, { sessionId: 'session-shot' });
    else if (request.url === '/session/session-shot/screenshot') sendJson(response, bytes.toString('base64'));
    else sendJson(response, null);
  }, async (port) => {
    const driver = new WebDriver(port);
    await driver.createSession('/tmp/candidate.exe');
    await driver.screenshot(screenshot);
    await driver.closeSession();
  });
  assert.deepEqual(await readFile(screenshot), bytes);
});
