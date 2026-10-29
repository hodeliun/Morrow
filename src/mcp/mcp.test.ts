import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpVaultManager } from './vault';
import type { PageId } from '../core/model';
import type { Placement } from '../core/vault/layout';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './tools';
import { registerMcpResources } from './resources';
import { registerMcpPrompts } from './prompts';

describe('McpVaultManager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'morrow-mcp-test-'));
    // Setup initial test files in vault
    await writeFile(
      path.join(tempDir, 'Welcome.md'),
      '---\ntags: [guide, start]\n---\n# Welcome to Morrow\n\nThis is a sample note with #focus.\n',
      'utf8',
    );
    await mkdir(path.join(tempDir, 'Projects'), { recursive: true });
    await writeFile(
      path.join(tempDir, 'Projects', 'Alpha.md'),
      '# Project Alpha\n\nSecret project notes linking to [[Welcome]].\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('scans and loads vault pages from disk', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const pages = manager.listPages();
    const titles = pages.map((p) => p.title).sort();

    expect(titles).toContain('Projects');
    expect(titles).toContain('Welcome');
  });

  it('reads a page by title or ID', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const result = manager.readPage('Welcome');

    expect(result.page.title).toBe('Welcome');
    expect(result.markdown).toContain('Welcome to Morrow');
    expect(result.page.tags).toContain('guide');
  });

  it('retargets Markdown links in a dirty read fallback using the current page layout', async () => {
    await writeFile(path.join(tempDir, 'Host.md'), '', 'utf8');
    await writeFile(path.join(tempDir, 'Target.md'), 'Target body.\n', 'utf8');
    const manager = await McpVaultManager.open(tempDir);
    const target = manager.resolvePage('Target');
    if (!target) throw new Error('Target page was not loaded.');
    const host = manager.resolvePage('Host');
    if (!host) throw new Error('Host page was not loaded.');

    await manager.editPage({ page: host.id, content: '[Section](./Target.md#part%20two)\n' });
    const layout = manager.getLayout() as Map<PageId, Placement>;
    layout.set(target.id, { file: 'Folder/Renamed Target.md', folder: 'Folder/Renamed Target' });

    const read = manager.readPage(host.id);
    expect(manager.getState().docs[host.id]?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'pageLink',
      attrs: { id: target.id, markdownHref: './Target.md#part%20two' },
    });
    expect(read.markdown).toContain('[Section](./Folder/Renamed%20Target.md#part%20two)');
  });

  it('resolves percent-encoded literal percent page paths once when a space filename also exists', async () => {
    await writeFile(path.join(tempDir, 'Host.md'), '# Host\n', 'utf8');
    await writeFile(path.join(tempDir, 'Percent%20name.md'), '# Literal percent target\n', 'utf8');
    await writeFile(path.join(tempDir, 'Percent name.md'), '# Decoded space target\n', 'utf8');
    const manager = await McpVaultManager.open(tempDir);
    const host = manager.resolvePage('Host');
    if (!host) throw new Error('Synthetic MCP host must load.');
    const layout = manager.getLayout() as Map<PageId, Placement>;
    const literalPercentTarget = manager.listPages().find(
      (page) => layout.get(page.id)?.file === 'Percent%20name.md',
    );
    const decodedSpaceTarget = manager.listPages().find((page) => layout.get(page.id)?.file === 'Percent name.md');
    if (!literalPercentTarget || !decodedSpaceTarget) throw new Error('Both synthetic MCP targets must load.');

    await manager.editPage({ page: host.id, content: '[Literal](./Percent%2520name.md#part%20two)\n' });

    expect(manager.getState().docs[host.id]?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'pageLink',
      attrs: { id: literalPercentTarget.id, markdownHref: './Percent%2520name.md#part%20two' },
    });
    expect(literalPercentTarget.id).not.toBe(decodedSpaceTarget.id);
  });

  it('searches pages with query and keywords', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const results = manager.searchPages('Alpha');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.page.title).toBe('Alpha');
  });

  it('creates, edits, and appends to pages', async () => {
    const manager = await McpVaultManager.open(tempDir);

    // Create
    const created = await manager.createPage({
      title: 'Dev Notes',
      content: '# Developer Notes\nInitial content.',
      tags: ['coding'],
    });
    expect(created.page.title).toBe('Dev Notes');

    // Verify on disk
    const onDisk = await readFile(path.join(tempDir, created.path), 'utf8');
    expect(onDisk).toContain('Initial content');

    // Edit
    const edited = await manager.editPage({
      page: 'Dev Notes',
      content: '# Developer Notes\nCompletely replaced text.',
    });
    expect(edited.page.title).toBe('Dev Notes');
    const readAfterEdit = manager.readPage('Dev Notes');
    expect(readAfterEdit.markdown).toContain('Completely replaced text');

    // Append
    await manager.appendToPage({
      page: 'Dev Notes',
      content: 'Additional line at the bottom.',
    });
    const readAfterAppend = manager.readPage('Dev Notes');
    expect(readAfterAppend.markdown).toContain('Completely replaced text');
    expect(readAfterAppend.markdown).toContain('Additional line at the bottom');
  });

  it('lists tags and builds graph topology', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const tags = manager.listTags();
    const tagNames = tags.map((t) => t.tag);

    expect(tagNames).toContain('guide');
    expect(tagNames).toContain('start');

    const graph = manager.getGraph({ orphans: true });
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('generates or retrieves today note in Journal', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const note = await manager.todaysNote();

    expect(note.page.dailyDate).toBeDefined();
    expect(note.markdown).toContain('# ');

    // Calling again returns the existing daily note
    const secondCall = await manager.todaysNote();
    expect(secondCall.page.id).toBe(note.page.id);
  });

  it('trashes pages by moving them to .trash', async () => {
    const manager = await McpVaultManager.open(tempDir);
    const created = await manager.createPage({
      title: 'Temporary Note',
      content: 'Will be deleted.',
    });

    const trashed = await manager.trashPage(created.page.id);
    expect(trashed.trashedAt).not.toBeNull();

    // Not in root listPages anymore
    const live = manager.listPages();
    expect(live.map((p) => p.id)).not.toContain(created.page.id);
  });
});

describe('MCP Server Registration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'morrow-mcp-reg-'));
    await writeFile(path.join(tempDir, 'Index.md'), '# Index\nRoot note.\n', 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('registers tools, resources, and prompts without error', async () => {
    const vault = await McpVaultManager.open(tempDir);
    const server = new McpServer({
      name: 'morrow-test',
      version: '1.1.0',
    });

    expect(() => registerMcpTools(server, vault)).not.toThrow();
    expect(() => registerMcpResources(server, vault)).not.toThrow();
    expect(() => registerMcpPrompts(server, vault)).not.toThrow();
  });

  it('respects the enabled/disabled switch and guards vault access', async () => {
    const vault = await McpVaultManager.open(tempDir);

    // When disabled
    process.env.MORROW_MCP_ENABLED = 'false';
    await expect(vault.assertEnabled()).rejects.toThrow('Morrow MCP is disabled in settings');

    // When enabled
    process.env.MORROW_MCP_ENABLED = 'true';
    await expect(vault.assertEnabled()).resolves.toBeUndefined();

    delete process.env.MORROW_MCP_ENABLED;
  });
});
