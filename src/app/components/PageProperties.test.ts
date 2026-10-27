import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { PageProperties } from './PageProperties';

describe('page metadata UI', () => {
  it('shows nested frontmatter in a collapsed metadata section with a structured editor affordance', async () => {
    let nextId = 0;
    const vault = new MemoryVault({
      'Knowledge/index.md': '---\nokf_version: 0.2\n---\n# Knowledge\n',
      'Knowledge/Concept.md':
        '---\ntype: Reference\nsources:\n  - id: handbook\n    resource: /references/handbook.md\n    title: "Reference, edition A"\n---\n',
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `ui${++nextId}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    const page = Object.values(session.getState().pages).find((candidate) => candidate.title === 'Concept')!;
    const html = renderToStaticMarkup(
      createElement(PageProperties, {
        page,
        database: null,
        doc: session.getState().docs[page.id],
        editable: true,
        adding: false,
        onAdded: () => {},
      }),
    );

    expect(html).toContain('<details class="metadata-details">');
    expect(html).toMatch(/Metadados|Metadata/);
    expect(html).toContain('- id: handbook');
    expect(html).toContain('resource: /references/handbook.md');
    expect(html).toContain('Reference, edition A');
    expect(html).toMatch(/Editar YAML|Edit YAML/);
    expect(html).not.toContain('open=""');
    expect(html).not.toContain('[object Object]');
    await session.close();
  });
});
