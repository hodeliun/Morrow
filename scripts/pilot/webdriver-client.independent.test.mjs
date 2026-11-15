import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { DRIVER_ELEMENT, WebDriver } from './webdriver-client.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function reply(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ value }));
}

test('surfaces a W3C protocol error carried by a successful HTTP response', async () => {
  await withServer((request, response) => {
    if (request.url === '/session') {
      reply(response, { sessionId: 'session-protocol-error' });
    } else if (request.url === '/session/session-protocol-error/elements') {
      reply(response, [{ [DRIVER_ELEMENT]: 'item-7' }]);
    } else if (request.url === '/session/session-protocol-error/element/item-7/text') {
      reply(response, { error: 'stale element reference', message: 'element was replaced' });
    } else if (request.url === '/session/session-protocol-error') {
      reply(response, null);
    } else {
      reply(response, null, 404);
    }
  }, async (port) => {
    const driver = new WebDriver(port);
    await driver.createSession('/tmp/synthetic-candidate.exe');
    try {
      await assert.rejects(
        driver.text('#stale'),
        (error) => error.message === 'WebDriver GET /session/session-protocol-error/element/item-7/text: stale element reference element was replaced',
      );
    } finally {
      await driver.closeSession();
    }
    assert.equal(driver.sessionId, null);
  });
});

test('encodes a WebDriver attribute name as one path component', async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    if (request.url === '/session') {
      reply(response, { sessionId: 'session-attribute' });
    } else if (request.url === '/session/session-attribute/elements') {
      reply(response, [{ [DRIVER_ELEMENT]: 'element-3' }]);
    } else if (request.url === '/session/session-attribute/element/element-3/attribute/data%2Flabel%3Fx%23part') {
      reply(response, 'synthetic value');
    } else if (request.url === '/session/session-attribute') {
      reply(response, null);
    } else {
      reply(response, null, 404);
    }
  }, async (port) => {
    const driver = new WebDriver(port);
    await driver.createSession('/tmp/synthetic-candidate.exe');
    try {
      assert.equal(await driver.attribute('#synthetic', 'data/label?x#part'), 'synthetic value');
    } finally {
      await driver.closeSession();
    }
  });
  assert.ok(paths.includes('/session/session-attribute/element/element-3/attribute/data%2Flabel%3Fx%23part'));
});
