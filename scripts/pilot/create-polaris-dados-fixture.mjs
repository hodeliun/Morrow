import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const pluginSource = resolve(repositoryRoot, 'plugins/polaris-dados');
const bundleSource = resolve(repositoryRoot, 'dist/polaris-dados/main.js');
const args = process.argv.slice(2);

if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write('Usage: node scripts/pilot/create-polaris-dados-fixture.mjs <new-or-empty-vault-directory>\n');
  process.exit(args.length === 1 ? 0 : 2);
}

const target = resolve(args[0]);
if (isWithin(repositoryRoot, target) || isWithin(target, repositoryRoot)) {
  throw new Error('Choose a synthetic vault path outside the Morrow checkout.');
}

const sourceFiles = {
  bundle: await readFile(bundleSource),
  manifest: await readFile(resolve(pluginSource, 'manifest.json')),
  readme: await readFile(resolve(pluginSource, 'README.md')),
  license: await readFile(resolve(repositoryRoot, 'LICENSE')),
  inventory: await readFile(resolve(pluginSource, 'fixture/Inventory.md')),
  widget: await readFile(resolve(pluginSource, 'fixture/Inventory/Widget.md')),
};
if (sourceFiles.bundle.length === 0) throw new Error('The plugin bundle is empty. Run npm run build:polaris-dados first.');
const manifest = JSON.parse(sourceFiles.manifest.toString('utf8'));
if (manifest.id !== 'polaris-dados') throw new Error('The plugin manifest id must be polaris-dados.');

let targetExists = false;
try {
  const targetStat = await lstat(target);
  targetExists = true;
  if (targetStat.isSymbolicLink()) throw new Error('Use a real directory, not a symbolic link, for the synthetic vault.');
  if (!targetStat.isDirectory()) throw new Error('The fixture destination exists and is not a directory.');
  if ((await readdir(target)).length > 0) throw new Error('The fixture destination is not empty; refusing to overwrite it.');
} catch (error) {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
}
if (!targetExists) await mkdir(target, { recursive: true });

const pluginDirectory = resolve(target, '.morrow/plugins/polaris-dados');
await mkdir(resolve(target, 'Inventory'), { recursive: true });
await mkdir(pluginDirectory, { recursive: true });

await writeExclusive(resolve(target, 'Inventory.md'), sourceFiles.inventory);
await writeExclusive(resolve(target, 'Inventory/Widget.md'), sourceFiles.widget);
await writeExclusive(resolve(target, '.morrow/workspace.json'), `${JSON.stringify({
  version: 1,
  pages: {
    'Inventory.md': { id: 'inventory-polaris-dados', created: 1794470400000, order: 0 },
    'Inventory/Widget.md': { id: 'widget-polaris-dados', created: 1794470400000, order: 0 },
  },
}, null, 1)}\n`);
await writeExclusive(resolve(target, '.morrow/plugins.json'), `${JSON.stringify({ enabled: ['polaris-dados'] }, null, 2)}\n`);
await writeExclusive(resolve(pluginDirectory, 'main.js'), sourceFiles.bundle);
await writeExclusive(resolve(pluginDirectory, 'manifest.json'), sourceFiles.manifest);
await writeExclusive(resolve(pluginDirectory, 'README.md'), sourceFiles.readme);
await writeExclusive(resolve(pluginDirectory, 'LICENSE'), sourceFiles.license);

process.stdout.write(`Synthetic Polaris Dados vault created at ${target}\n`);

async function writeExclusive(path, contents) {
  await writeFile(path, contents, { flag: 'wx' });
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}
