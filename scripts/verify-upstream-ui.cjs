// Hidden, synthetic smoke test for the Morrow 1.2.1 integration.
// Usage: node scripts/verify-upstream-ui.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { zipSync, strToU8 } = require('fflate');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const packet = JSON.parse(event.data);
      if (!packet.id) return;
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      this.pending.delete(packet.id);
      packet.error ? pending.reject(new Error(packet.error.message)) : pending.resolve(packet.result);
    });
  }
  async ready() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-upstream-1.2.1-'));
  const profile = path.join(root, 'profile');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(profile);
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(profile, 'vaults.json'), JSON.stringify({ current: vault, recent: [{ path: vault, openedAt: Date.now() }] }));
  const notionId = '0123456789abcdef0123456789abcdef';
  const archivePath = path.join(root, 'notion-synthetic.zip');
  fs.writeFileSync(archivePath, Buffer.from(zipSync({
    [`Export/Teste ${notionId}.md`]: strToU8('# Teste\n\nVersão inicial.\n\n- [ ] Tarefa sintética\n'),
    [`Export/Teste ${notionId}/Subpágina ${notionId}.md`]: strToU8('# Subpágina\n\nConteúdo de teste.\n'),
  })));
  const port = await freePort();
  const exe = path.resolve('node_modules/electron/dist/electron.exe');
  const pdfPath = path.join(root, 'page-export.pdf');
  const child = spawn(exe, [`--remote-debugging-port=${port}`, 'scripts/hidden-electron-pdf.cjs'], {
    cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, MORROW_USER_DATA: profile, MORROW_HIDDEN: '1', MORROW_TEST_PDF: pdfPath },
  });
  let cdp;
  try {
    const target = await deadline(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find((page) => page.type === 'page' && page.url.startsWith('morrow://app'));
    }, 'Electron CDP target');
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready();
    const body = await deadline(async () => {
      const text = await cdp.eval('document.body?.innerText');
      return text && text.length > 100 ? text : null;
    }, 'application body');
    console.log('PROFILE', root);
    console.log('INITIAL', body.slice(0, 200).replace(/\n/g, ' | '));
    await cdp.eval('HTMLInputElement.prototype.click = function(){ if(this.type !== "file") HTMLElement.prototype.click.call(this) }');
    const clicked = await cdp.eval('(() => { const b=[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="Importar"); b?.click(); return !!b })()');
    if (!clicked) throw new Error('Import button not found');
    await deadline(() => cdp.eval('!!document.querySelector("input[type=file]")'), 'file input');
    const input = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input[type=file]")' });
    await cdp.send('DOM.setFileInputFiles', { files: [archivePath], objectId: input.result.objectId });
    await cdp.eval('document.querySelector("input[type=file]")?.dispatchEvent(new Event("change",{bubbles:true}))');
    const imported = await deadline(async () => {
      const text = await cdp.eval('document.body?.innerText');
      return text?.includes('Versão inicial.') ? text : null;
    }, 'Notion archive import');
    console.log('IMPORTED', imported.slice(-380).replace(/\n/g, ' | '));
    await deadline(() => fs.existsSync(path.join(vault, 'Teste.md')) && fs.readFileSync(path.join(vault, 'Teste.md'), 'utf8').includes('Versão inicial.'), 'initial import save');
    await delay(800);
    const edit = await cdp.eval('(() => { const p=document.querySelector(".ProseMirror > p"); if(!p || p.textContent!=="Versão inicial.") return false; p.click(); p.closest(".ProseMirror").focus(); return true })()');
    if (!edit) throw new Error('Imported paragraph not editable');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text: 'Versão editada.' });
    await deadline(() => cdp.eval('document.querySelector(".ProseMirror > p")?.textContent === "Versão editada."'), 'editor change');
    await deadline(() => fs.existsSync(path.join(vault, 'Teste.md')) && fs.readFileSync(path.join(vault, 'Teste.md'), 'utf8').includes('Versão editada.'), 'editor save', 25000);
    console.log('EDITOR', 'saved changed text to synthetic Markdown vault');
    await cdp.eval('[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="Opções da página")?.click()');
    await deadline(() => cdp.eval('document.body.innerText.includes("Histórico da página")'), 'page menu');
    await cdp.eval('(() => { const x=[...document.querySelectorAll("button,[role=menuitem]")].find(b=>b.innerText.trim()==="Histórico da página"); x?.click(); return !!x })()');
    const history = await deadline(async () => {
      const text = await cdp.eval('document.body.innerText');
      return text?.includes('Restaurar esta versão') ? text : null;
    }, 'history dialog');
    console.log('HISTORY', history.slice(-750).replace(/\n/g, ' | '));
    const restoredClick = await cdp.eval('(() => { const x=[...document.querySelectorAll("button")].find(b=>b.innerText.trim()==="Restaurar esta versão"); x?.click(); return !!x })()');
    if (!restoredClick) throw new Error('Restore action not found');
    await deadline(() => cdp.eval('document.querySelector(".ProseMirror > p")?.textContent === "Versão inicial."'), 'history restore UI');
    await deadline(() => fs.readFileSync(path.join(vault, 'Teste.md'), 'utf8').includes('Versão inicial.'), 'history restore save');
    console.log('RESTORE', 'original text restored and persisted');
    await cdp.eval('[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="Opções da página")?.click()');
    await cdp.eval('[...document.querySelectorAll("button,[role=menuitem]")].find(b=>b.innerText.trim()==="Histórico da página")?.click()');
    const historyAfter = await deadline(async () => {
      const text = await cdp.eval('document.body.innerText');
      return text?.includes('Versão editada.') && text.includes('Restaurar esta versão') ? text : null;
    }, 'preserved history');
    console.log('PRESERVED', historyAfter.slice(-340).replace(/\n/g, ' | '));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await deadline(() => cdp.eval('!document.body.innerText.includes("Histórico de “Teste”")'), 'close history dialog');
    await cdp.eval('[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="Opções da página")?.click()');
    await deadline(() => cdp.eval('document.body.innerText.includes("Exportar como PDF")'), 'export menu');
    await cdp.eval('[...document.querySelectorAll("button,[role=menuitem]")].find(b=>b.innerText.trim()==="Exportar como PDF")?.click()');
    await deadline(() => fs.existsSync(pdfPath), 'PDF export', 30000);
    const pdfBytes = fs.readFileSync(pdfPath);
    if (pdfBytes.subarray(0, 4).toString() !== '%PDF' || pdfBytes.length < 1000) throw new Error('PDF output invalid');
    console.log('PDF', `${pdfBytes.length} bytes, page menu export`);
  } finally {
    cdp?.close();
    child.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
