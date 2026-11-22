import { describe, expect, it } from 'vitest';
import { validateDoc } from './doc';
import {
  createLegacyFormulaMarker,
  parseEditableLegacyFormula,
  legacyFormulaDocIssue,
  LEGACY_FORMULA_NODE,
  parseLegacyFormulaMarker,
  parseLegacyFormulaPresentation,
  updateLegacyFormulaMarker,
} from './legacyFormula';
import type { DocNode } from './model';
import { markdownToDoc } from './markdown/parse';
import { docToClipboardMarkdown, docToMarkdown } from './markdown/serialize';

function legacyResult(resultId: string, name: string): string {
  const payload = {
    resultId,
    pageId: 'finance-note',
    name,
    formula: '1 + 2',
    bindings: [{ kind: 'property', propertyId: 'amount', source: 'Amount', start: 0, end: 6 }],
    outputType: 'currency',
    format: { currency: 'BRL', locale: 'pt-BR', precision: 2 },
    futureField: { keep: true },
  };
  const encoded = encodeURIComponent(JSON.stringify(payload)).replaceAll("'", '%27');
  return `<span data-morrow-result="${encoded}" data-vendor="opaque" title="kept">${name.replaceAll('&', '&amp;')}</span>`;
}

function formulaNodes(doc: DocNode): DocNode[] {
  const found: DocNode[] = [];
  const visit = (node: DocNode) => {
    if (node.type === LEGACY_FORMULA_NODE) found.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return found;
}

describe('legacy inline formula results', () => {
  it('creates the published auto scalar payload with an inert optional label', () => {
    const marker = createLegacyFormulaMarker({
      resultId: 'host-generated-id',
      pageId: 'fixture-page',
      formula: '2 + 3',
      name: 'A <safe> & useful label',
    });

    expect(marker).toMatchObject({ fallback: 'A <safe> & useful label', resultId: 'host-generated-id' });
    expect(marker?.raw).toContain('data-morrow-result=');
    expect(marker?.raw).toContain('A &lt;safe&gt; &amp; useful label');
    expect(parseLegacyFormulaPresentation(marker!.raw, marker!.fallback)).toMatchObject({
      name: 'A <safe> & useful label',
      formula: '2 + 3',
      outputType: 'auto',
      format: {},
      fallback: 'A <safe> & useful label',
    });
    const emptyName = createLegacyFormulaMarker({
      resultId: 'empty-name',
      pageId: 'fixture-page',
      formula: '',
    });
    expect(parseLegacyFormulaMarker(emptyName!.raw)?.fallback).toBe('');
    expect(parseLegacyFormulaPresentation(emptyName!.raw, emptyName!.fallback)).not.toHaveProperty('name');
  });

  it('rejects marker values outside the published scalar limits', () => {
    const base = { resultId: 'valid-id', pageId: 'fixture-page', formula: '1' };
    expect(createLegacyFormulaMarker({ ...base, resultId: 'contains space' })).toBeNull();
    expect(createLegacyFormulaMarker({ ...base, formula: 'x'.repeat(2001) })).toBeNull();
    expect(createLegacyFormulaMarker({ ...base, name: 'x'.repeat(101) })).toBeNull();
    expect(createLegacyFormulaMarker({ ...base, pageId: '' })).toBeNull();
  });

  it('projects only validated, unbound display data and omits identity and source markup', () => {
    const payload = {
      resultId: 'private-result',
      pageId: 'private-page',
      name: 'Private name',
      formula: '1 + 2',
      bindings: [],
      outputType: 'number',
      format: { locale: 'pt-BR', precision: 2 },
    };
    const marker = `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}">Three</span>`;

    expect(parseLegacyFormulaPresentation(marker, 'Three')).toEqual({
      name: 'Private name',
      formula: '1 + 2',
      outputType: 'number',
      format: { locale: 'pt-BR', precision: 2 },
      fallback: 'Three',
    });
    expect(JSON.stringify(parseLegacyFormulaPresentation(marker))).not.toMatch(
      /private-result|private-page|data-morrow-result/,
    );
  });

  it('keeps bound, malformed, mismatched and unsupported payloads out of the renderer projection', () => {
    const makeMarker = (overrides: Record<string, unknown>) => {
      const payload = {
        resultId: 'safe-result',
        pageId: 'safe-page',
        name: 'Safe',
        formula: '1 + 2',
        bindings: [],
        outputType: 'auto',
        format: {},
        ...overrides,
      };
      return `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}">Safe</span>`;
    };

    const bound = makeMarker({ bindings: [{ kind: 'property' }] });
    const unknownType = makeMarker({ outputType: 'future-output' });
    const unsupportedFormat = makeMarker({ format: { html: '<b>unsafe</b>' } });
    const invalidName = makeMarker({ name: 'x'.repeat(101) });

    expect(parseLegacyFormulaPresentation(bound)).toBeNull();
    expect(parseLegacyFormulaPresentation(unknownType)).toBeNull();
    expect(parseLegacyFormulaPresentation(invalidName)).toBeNull();
    expect(parseLegacyFormulaPresentation(makeMarker({}), 'Changed fallback')).toBeNull();
    expect(parseLegacyFormulaPresentation(unsupportedFormat)?.format).toBeNull();
  });

  it('updates only formula and name values while preserving extra payload data and outer HTML', () => {
    const payload = {
      future: { formula: 'nested stays untouched', flags: [true, null, 0] },
      resultId: 'edit-result',
      pageId: 'edit-page',
      name: 'Old & <name>',
      formula: '1 + 2',
      bindings: [],
      outputType: 'auto',
      format: { precision: 2 },
      vendorToken: 'keep % and spaces',
    };
    const encoded = encodeURIComponent(JSON.stringify(payload)).replaceAll("'", '%27');
    const raw = `<span data-future = 'untouched' data-morrow-result='${encoded}' onclick="kept()" title="opaque">Old &amp; &lt;name&gt;</span>`;
    const fallback = 'Old & <name>';
    const originalOpeningStart = raw.slice(0, raw.indexOf(encoded));
    const originalOpeningEnd = raw.slice(raw.indexOf(encoded) + encoded.length, raw.indexOf('>') + 1);
    const projection = parseEditableLegacyFormula(raw, fallback);
    expect(projection).toEqual({
      resultId: 'edit-result',
      pageId: 'edit-page',
      name: 'Old & <name>',
      formula: '1 + 2',
      outputType: 'auto',
      format: { precision: 2 },
    });

    const changedFormula = 'sum("literal\\" quote") + 4';
    const formulaOnly = updateLegacyFormulaMarker(raw, fallback, { formula: changedFormula, name: fallback });
    expect(formulaOnly).toMatchObject({ fallback, resultId: 'edit-result' });
    expect(formulaOnly?.raw.startsWith(originalOpeningStart)).toBe(true);
    expect(formulaOnly?.raw.includes(originalOpeningEnd.slice(0, originalOpeningEnd.indexOf('onclick')))).toBe(true);
    expect(formulaOnly?.raw.endsWith('Old &amp; &lt;name&gt;</span>')).toBe(true);
    const formulaOnlyEncoded = formulaOnly?.raw.match(/data-morrow-result='([^']+)'/)?.[1];
    expect(formulaOnlyEncoded).toBeDefined();
    const formulaOnlyPayload = JSON.parse(decodeURIComponent(formulaOnlyEncoded!));
    expect(formulaOnlyPayload).toEqual({ ...payload, formula: changedFormula });

    const updatedName = 'New "<&>" & name';
    const renamed = updateLegacyFormulaMarker(raw, fallback, { formula: changedFormula, name: updatedName });
    expect(renamed).toMatchObject({ fallback: updatedName, resultId: 'edit-result' });
    expect(renamed?.raw).toContain('data-future = \'untouched\'');
    expect(renamed?.raw).toContain('onclick="kept()" title="opaque"');
    expect(renamed?.raw).toContain('New "&lt;&amp;&gt;" &amp; name</span>');
    const renamedEncoded = renamed?.raw.match(/data-morrow-result='([^']+)'/)?.[1];
    expect(renamedEncoded).toBeDefined();
    expect(JSON.parse(decodeURIComponent(renamedEncoded!))).toEqual({
      ...payload,
      formula: changedFormula,
      name: updatedName,
    });

    const cleared = updateLegacyFormulaMarker(renamed!.raw, updatedName, { formula: changedFormula, name: '' });
    expect(cleared).toMatchObject({ fallback: '', resultId: 'edit-result' });
    expect(cleared?.raw.endsWith('></span>')).toBe(true);
  });

  it('returns the original marker for a no-op and refuses bound or unsupported results', () => {
    const payload = {
      resultId: 'editable', pageId: 'page', name: 'Current', formula: '1 + 2',
      bindings: [], outputType: 'auto', format: {}, future: { keep: true },
    };
    const raw = `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}" data-extra="same">Current</span>`;
    expect(updateLegacyFormulaMarker(raw, 'Current', { name: 'Current', formula: '1 + 2' })).toEqual({
      raw,
      fallback: 'Current',
      resultId: 'editable',
    });
    expect(parseEditableLegacyFormula(raw, 'wrong fallback')).toBeNull();

    const unsupported = [
      { bindings: [{ kind: 'property' }] },
      { outputType: 'future-output' },
      { format: { html: '<b>unsupported</b>' } },
      { outputType: 'checkbox', format: { precision: 2 } },
      { outputType: 'scale' },
    ];
    for (const override of unsupported) {
      const source = `<span data-morrow-result="${encodeURIComponent(JSON.stringify({ ...payload, ...override }))}">Current</span>`;
      expect(parseEditableLegacyFormula(source, 'Current')).toBeNull();
      expect(updateLegacyFormulaMarker(source, 'Current', { name: 'Next', formula: '3 + 4' })).toBeNull();
    }
  });

  it('preserves noncanonical JSON escapes and percent-encoded metadata outside changed values', () => {
    const payloadText =
      '{ "resultId":"escape-id", "pageId":"page", "name":"Ol\\u00e9", ' +
      '"formula":"1 \\u002b 2", "bindings":[], "outputType":"auto", "format":{}, ' +
      '"extra":"café & <raw>" }';
    const encoded = encodeURIComponent(payloadText).replaceAll("'", '%27').replace(/%[\da-f]{2}/gi, (part) => part.toLowerCase());
    const raw = `<span data-morrow-result="${encoded}" data-extra="leave">Olé</span>`;
    const changed = updateLegacyFormulaMarker(raw, 'Olé', { formula: '1 + 3', name: 'Olé' });

    expect(changed).not.toBeNull();
    expect(changed?.raw).toContain('%c3%a9');
    const updatedEncoded = changed?.raw.match(/data-morrow-result="([^"]+)"/)?.[1];
    expect(updatedEncoded).toBeDefined();
    expect(decodeURIComponent(updatedEncoded!)).toBe(
      payloadText.replace('"formula":"1 \\u002b 2"', '"formula":"1 + 3"'),
    );
    expect(changed?.raw.endsWith(' data-extra="leave">Olé</span>')).toBe(true);
  });

  it('rejects duplicate top-level formula and name keys instead of updating the wrong JSON value', () => {
    const duplicateFormula =
      '{"resultId":"duplicate-formula","pageId":"page","name":"N","formula":"1 + 2",' +
      '"bindings":[],"outputType":"auto","format":{},"formula":"9 + 9"}';
    const duplicateName =
      '{"resultId":"duplicate-name","pageId":"page","name":"N","formula":"1 + 2",' +
      '"bindings":[],"outputType":"auto","format":{},"name":"Other"}';
    for (const payload of [duplicateFormula, duplicateName]) {
      const raw = `<span data-morrow-result="${encodeURIComponent(payload)}">N</span>`;
      expect(parseEditableLegacyFormula(raw, 'N')).toBeNull();
      expect(updateLegacyFormulaMarker(raw, 'N', { formula: '2 + 3', name: 'Changed' })).toBeNull();
    }
  });

  it('round trips the exact legacy span, fallback and neighboring marks as inert atoms', () => {
    const first = legacyResult('result-a', 'Revenue & tax');
    const second = legacyResult('result-b', 'Expenses');
    const source = `**Before ${first} after** and *${second}*`;
    const doc = markdownToDoc(source);
    const results = formulaNodes(doc);

    expect(results).toHaveLength(2);
    expect(results[0]?.attrs).toMatchObject({ raw: first, fallback: 'Revenue & tax' });
    expect(results[0]?.marks?.map((mark) => mark.type)).toEqual(['bold']);
    expect(results[1]?.attrs).toMatchObject({ raw: second, fallback: 'Expenses' });
    expect(results[1]?.marks?.map((mark) => mark.type)).toEqual(['italic']);
    expect(validateDoc(doc).ok).toBe(true);
    expect(docToMarkdown(doc)).toBe(`${source}\n`);
    expect(legacyFormulaDocIssue(doc)).toBeNull();
  });

  it('copies readable fallbacks instead of duplicating formula IDs', () => {
    const marker = legacyResult('result-copy', 'Projected total');
    const doc = markdownToDoc(`${marker}\n\nCopied paragraph`);
    const clipboard = docToClipboardMarkdown(doc);

    expect(clipboard).toContain('Projected total');
    expect(clipboard).not.toContain('data-morrow-result');
    expect(clipboard).not.toContain('result-copy');
  });

  it('keeps repeated IDs protected instead of silently remapping the legacy source', () => {
    const source = `${legacyResult('duplicate', 'First')} and ${legacyResult('duplicate', 'Second')}`;
    const doc = markdownToDoc(source);

    expect(formulaNodes(doc)).toHaveLength(2);
    expect(validateDoc(doc).ok).toBe(false);
    expect(() => docToMarkdown(doc)).toThrow(/duplicate legacy formula result ID/i);
  });

  it('refuses to attach a link mark to an atom whose legacy source cannot survive link resolution', () => {
    const doc = markdownToDoc(legacyResult('linked', 'Linked result'));
    const paragraph = doc.content![0]!;
    const atom = paragraph.content![0]!;
    const linked: DocNode = {
      ...doc,
      content: [
        {
          ...paragraph,
          content: [{ ...atom, marks: [{ type: 'link', attrs: { href: 'Other.md' } }] }],
        },
      ],
    };

    expect(validateDoc(linked).ok).toBe(false);
    expect(() => docToMarkdown(linked)).toThrow(/unsupported mark/i);
  });

  it('does not turn inline or fenced code into formula atoms', () => {
    const marker = legacyResult('literal', 'Literal result');
    const source = `Use \`${marker}\` as text.\n\n\`\`\`html\n${marker}\n\`\`\``;
    const doc = markdownToDoc(source);

    expect(formulaNodes(doc)).toHaveLength(0);
    expect(docToMarkdown(doc)).toContain(marker);
  });
});
