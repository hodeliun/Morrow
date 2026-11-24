import { writeFile } from 'node:fs/promises';

export const DRIVER_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriver {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
    this.sessionId = null;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${this.base}${endpoint}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`WebDriver returned non-JSON: ${raw.slice(0, 500)}`); }
    if (!response.ok || data.value?.error) {
      throw new Error(`WebDriver ${method} ${endpoint}: ${data.value?.error ?? response.status} ${data.value?.message ?? raw}`);
    }
    return data.value;
  }

  async createSession(binary) {
    const value = await this.request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: binary, args: [] },
        },
      },
    });
    this.sessionId = value.sessionId;
    return value;
  }

  path(suffix) {
    if (!this.sessionId) throw new Error('WebDriver session is not active');
    return `/session/${this.sessionId}${suffix}`;
  }

  async execute(script, args = []) {
    return this.request('POST', this.path('/execute/sync'), { script, args });
  }

  async refresh() {
    await this.request('POST', this.path('/refresh'), {});
  }

  async elements(selector) {
    return this.request('POST', this.path('/elements'), { using: 'css selector', value: selector });
  }

  async element(selector) {
    const elements = await this.elements(selector);
    if (!elements.length) throw new Error(`Element not found: ${selector}`);
    return elements[0][DRIVER_ELEMENT] ?? elements[0].ELEMENT;
  }

  async click(selector) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/click`), {});
  }

  async clear(selector) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/clear`), {});
  }

  async sendKeys(selector, text) {
    const id = await this.element(selector);
    return this.request('POST', this.path(`/element/${id}/value`), { text, value: [...text] });
  }

  async text(selector) {
    const id = await this.element(selector);
    return this.request('GET', this.path(`/element/${id}/text`));
  }

  async attribute(selector, name) {
    const id = await this.element(selector);
    return this.request('GET', this.path(`/element/${id}/attribute/${encodeURIComponent(name)}`));
  }

  async screenshot(file) {
    const value = await this.request('GET', this.path('/screenshot'));
    await writeFile(file, Buffer.from(value, 'base64'));
  }

  async closeSession() {
    if (!this.sessionId) return;
    try { await this.request('DELETE', `/session/${this.sessionId}`); } finally { this.sessionId = null; }
  }
}
