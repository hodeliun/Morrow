import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { findUnrepresentablePageContent } from '../../src/core/vault/compatibility';

const execFileAsync = promisify(execFile);
const pluginDirectory = path.resolve(import.meta.dirname);
const repositoryRoot = path.resolve(pluginDirectory, '../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRepository() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'morrow-documento-fixture-'));
  temporaryRoots.push(temporaryRoot);
  const root = path.join(temporaryRoot, 'repo');
  const copy = async (source: string, relative: string) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  };

  const files: Array<[string, string]> = [
    ['scripts/pilot/create-polaris-dados-fixture.mjs', 'scripts/pilot/create-polaris-dados-fixture.mjs'],
    ['LICENSE', 'LICENSE'],
    ['plugins/polaris-dados/manifest.json', 'plugins/polaris-dados/manifest.json'],
    ['plugins/polaris-dados/README.md', 'plugins/polaris-dados/README.md'],
    ['plugins/polaris-dados/fixture/Inventory.md', 'plugins/polaris-dados/fixture/Inventory.md'],
    [
      'plugins/polaris-dados/fixture/Inventory/Widget.md',
      'plugins/polaris-dados/fixture/Inventory/Widget.md',
    ],
    ['plugins/polaris-documento/manifest.json', 'plugins/polaris-documento/manifest.json'],
    ['plugins/polaris-documento/README.md', 'plugins/polaris-documento/README.md'],
  ];
  await Promise.all(
    files.map(([source, destination]) => copy(path.join(repositoryRoot, source), destination)),
  );
  for (const pluginId of ['polaris-dados', 'polaris-documento']) {
    const bundle = path.join(root, 'dist', pluginId, 'main.js');
    await mkdir(path.dirname(bundle), { recursive: true });
    await writeFile(bundle, `// synthetic ${pluginId} bundle\n`);
  }
  return root;
}

async function createFixture(root: string, options: string[] = []) {
  const target = await mkdtemp(path.join(path.dirname(root), 'vault-'));
  const script = path.join(root, 'scripts/pilot/create-polaris-dados-fixture.mjs');
  const result = await execFileAsync(process.execPath, [script, ...options, target], { cwd: root });
  return {
    target,
    generated: JSON.parse(result.stdout) as {
      options: { checkboxDemo: boolean; documentoDemo: boolean };
      vaults: Array<{ files: string[]; documentoDemo?: { bundleSha256: string } }>;
    },
  };
}

async function expectMissing(file: string) {
  await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('Polaris Documento Windows fixture option', () => {
  it('keeps the default and checkbox-only fixture modes unchanged', async () => {
    const root = await fixtureRepository();

    const defaultFixture = await createFixture(root);
    const defaultVault = defaultFixture.generated.vaults[0]!;
    expect(defaultFixture.generated.options).toEqual({ checkboxDemo: false, documentoDemo: false });
    expect(defaultVault.files).toEqual([
      'Inventory.md',
      'Inventory/Widget.md',
      'Views.md',
      '.morrow/workspace.json',
      '.morrow/plugins.json',
      '.morrow/plugins/polaris-dados/main.js',
      '.morrow/plugins/polaris-dados/manifest.json',
      '.morrow/plugins/polaris-dados/README.md',
      '.morrow/plugins/polaris-dados/LICENSE',
    ]);
    expect(
      JSON.parse(await readFile(path.join(defaultFixture.target, '.morrow/plugins.json'), 'utf8')).enabled,
    ).toEqual(['polaris-dados']);
    await expectMissing(path.join(defaultFixture.target, '.morrow/plugins/polaris-documento'));
    await expectMissing(path.join(defaultFixture.target, 'Links.md'));

    const checkboxFixture = await createFixture(root, ['--checkbox-demo']);
    const checkboxVault = checkboxFixture.generated.vaults[0]!;
    expect(checkboxFixture.generated.options).toEqual({ checkboxDemo: true, documentoDemo: false });
    expect(checkboxVault.files).toContain('Checklist.md');
    expect(
      JSON.parse(await readFile(path.join(checkboxFixture.target, '.morrow/plugins.json'), 'utf8')).enabled,
    ).toEqual(['polaris-dados']);
    await expectMissing(path.join(checkboxFixture.target, '.morrow/plugins/polaris-documento'));
  });

  it('adds live, missing, unresolved, external-link, and native-relation cases with source-matched assets', async () => {
    const root = await fixtureRepository();
    const fixture = await createFixture(root, ['--documento-demo', '--checkbox-demo']);
    const target = fixture.target;
    const generated = fixture.generated;
    const vault = generated.vaults[0]!;

    expect(generated.options).toEqual({ checkboxDemo: true, documentoDemo: true });
    expect(vault.files).toContain('Checklist.md');
    expect(vault.files).toContain('Links.md');
    expect(vault.files).toContain('Relations/Relation sample.md');
    expect(vault.documentoDemo?.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

    const read = (relative: string) => readFile(path.join(target, relative), 'utf8');
    const workspace = JSON.parse(await read('.morrow/workspace.json'));
    const plugins = JSON.parse(await read('.morrow/plugins.json'));
    const links = await read('Links.md');
    expect(findUnrepresentablePageContent(links)).toBeNull();
    const relation = await read('Relations/Relation sample.md');
    const relationDatabase = await read('Relations.md');
    const resolved = await read('Resolved target.md');

    expect(plugins.enabled).toEqual(['polaris-dados', 'polaris-documento']);
    expect(links).toContain('[[Resolved target|Resolved: live]]');
    expect(links).toContain('[[Gone target|Missing: gone]]');
    expect(links).toContain('[[Never existed|Unresolved: unknown]]');
    expect(links).toContain('[External documentation](https://example.com/docs)');
    expect(links).toContain(
      '<!-- morrow:block-background:#a1b2c3 -->\nLegacy HEX background.\n\nPlain neighbor.',
    );

    expect(links).toContain(
      '- Section\n  - Nested section\n    - <!-- morrow:block-background:#3867b3 -->\n' +
        '      Old nested list paragraph.\n\n1. \n   <!-- morrow:block-background:#7c40ab -->\n' +
        '\n   Legacy numbered paragraph.',
    );
    expect(links).toContain(
      '- List item with native background <!-- background: yellow -->\n\n' +
        '  <!-- morrow:block-background:#2f80ed -->\n\n  Legacy list paragraph.\n\n' +
        '  - [x] Nested task\n\n    <!-- morrow:block-background:#2f80ed -->\n\n    Legacy task paragraph.',
    );
    expect(relationDatabase).toContain('type: relation');
    expect(relation).toContain('"[[Resolved target]]"');
    expect(relation).toContain('"[[Gone target]]"');
    const match = /<span data-morrow-result="([^"]+)">Legacy total<\/span>/.exec(resolved);
    expect(match).not.toBeNull();
    expect(JSON.parse(decodeURIComponent(match![1]!))).toMatchObject({
      resultId: 'demo-legacy-result',
      pageId: workspace.pages['Resolved target.md'].id,
      formula: '2 + 3',
      bindings: [],
    });
    expect(resolved).toContain('Editable neighbor.');
    expect(workspace.pages['Resolved target.md']).toMatchObject({ id: expect.any(String) });
    expect(workspace.pages['.trash/Gone target.md']).toMatchObject({
      id: expect.any(String),
      trashed: expect.any(Number),
    });
    expect(workspace.pages['Never existed.md']).toBeUndefined();

    for (const pluginId of ['polaris-dados', 'polaris-documento']) {
      const destination = path.join(target, '.morrow/plugins', pluginId);
      const source = path.join(root, 'plugins', pluginId);
      const sourceBundle = path.join(root, 'dist', pluginId, 'main.js');
      for (const file of ['manifest.json', 'README.md']) {
        expect(await readFile(path.join(destination, file))).toEqual(await readFile(path.join(source, file)));
      }
      expect(await readFile(path.join(destination, 'main.js'))).toEqual(await readFile(sourceBundle));
      expect(await readFile(path.join(destination, 'LICENSE'))).toEqual(
        await readFile(path.join(root, 'LICENSE')),
      );
    }
  });
});
