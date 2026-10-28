import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { formatDisplayValue, formatValue, formulaResult, valueOf } from './database';
import { encodeLucideIcon, sanitizeSvg, validPageIcon } from './icons';
import { emptyDoc, emptyWorkspace, newPageMeta } from './model';
import type { DatabaseDef, PageMeta, PropDef, PropValue, WorkspaceState } from './model';
import { previewRelationPairUnion } from './relations';

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

function createDatabase(
  state: WorkspaceState,
  id: string,
  title: string,
  properties: PropDef[],
  now = 1,
): WorkspaceState {
  const dbDef: DatabaseDef = {
    properties,
    views: [
      {
        id: `view-${id}`,
        name: 'Table',
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        widths: {},
        groupBy: null,
        dateProp: null,
      },
    ],
  };
  const page: PageMeta = newPageMeta({
    id,
    parentId: null,
    title,
    kind: 'database',
    database: dbDef,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...state,
    pages: { ...state.pages, [id]: page },
    docs: { ...state.docs, [id]: emptyDoc() },
  };
}

function createRow(
  state: WorkspaceState,
  id: string,
  parentId: string,
  title: string,
  properties: Record<string, PropValue> = {},
  now = 1,
): WorkspaceState {
  const page: PageMeta = newPageMeta({
    id,
    parentId,
    title,
    kind: 'page',
    properties,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...state,
    pages: { ...state.pages, [id]: page },
    docs: { ...state.docs, [id]: emptyDoc() },
  };
}

describe('Delivery 3 — Custom Property Icons and Model (#37)', () => {
  it('validPageIcon accepts safe emojis, Lucide identifiers and rejects malicious SVG payloads', () => {
    expect(validPageIcon('⭐')).toBe(true);
    const starLucide = encodeLucideIcon('Star');
    expect(starLucide).toBeTruthy();
    expect(validPageIcon(starLucide)).toBe(true);
    const redStarLucide = encodeLucideIcon('Star', '#FF0000');
    expect(redStarLucide).toBeTruthy();
    expect(validPageIcon(redStarLucide)).toBe(true);

    // Malicious SVG with scripts or embedded tags is rejected by sanitizeSvg
    expect(sanitizeSvg('<script>alert("xss")</script>')).toBeNull();
    expect(sanitizeSvg('<svg><foreignObject>...</foreignObject></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><script>alert(1)</script></svg>')).toBeNull();

    // Event handlers like onload are stripped out completely
    const sanitizedOnload = sanitizeSvg('<svg onload="alert(1)"><circle cx="5" cy="5" r="5"/></svg>');
    expect(sanitizedOnload).not.toBeNull();
    expect(sanitizedOnload).not.toContain('onload');
    expect(sanitizedOnload).not.toContain('alert');

    // Valid SVG is accepted and cleaned
    const validSvg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>';
    expect(sanitizeSvg(validSvg)).not.toBeNull();
  });

  it('PropDef preserves custom icon across type changes', () => {
    let state = emptyWorkspace();
    const propId = 'custom-prop-1';
    const prop: PropDef = {
      id: propId,
      name: 'Score',
      type: 'scale',
      icon: '⭐',
      options: [],
    };
    state = createDatabase(state, 'db-1', 'Games', [prop]);

    // Change property type from scale to number
    const updatedProp: PropDef = {
      ...prop,
      type: 'number',
      // icon explicitly preserved
      icon: prop.icon,
    };
    state = run(state, {
      type: 'database.set',
      id: 'db-1',
      database: {
        ...state.pages['db-1']!.database!,
        properties: [updatedProp],
      },
      now: 2,
    });

    const savedProp = state.pages['db-1']!.database!.properties[0]!;
    expect(savedProp.type).toBe('number');
    expect(savedProp.icon).toBe('⭐');
  });
});

describe('Delivery 3 — Formula Format Parity (#42)', () => {
  it('formats formula numeric results with currency, percent and precision without silencing values', () => {
    const currencyFormula: PropDef = {
      id: 'fx-curr',
      name: 'Total Cost',
      type: 'formula',
      formulaResultType: 'currency',
      format: { currency: 'USD', precision: 2, locale: 'en-US' },
      options: [],
    };
    expect(formatValue(currencyFormula, 1250.5)).toBe('$1,250.50');
    expect(formatValue(currencyFormula, 0)).toBe('$0.00');

    const percentFormula: PropDef = {
      id: 'fx-pct',
      name: 'Rate',
      type: 'formula',
      formulaResultType: 'percent',
      format: { precision: 1, locale: 'en-US' },
      options: [],
    };
    expect(formatValue(percentFormula, 0.425)).toBe('42.5%');
    expect(formatValue(percentFormula, 0)).toBe('0.0%');

    const decimalFormula: PropDef = {
      id: 'fx-num',
      name: 'Weight',
      type: 'formula',
      formulaResultType: 'number',
      format: { precision: 3, locale: 'en-US' },
      options: [],
    };
    expect(formatValue(decimalFormula, 3.14159)).toBe('3.142');
  });

  it('preserves false, zero and null without confusing them, and does not mask incompatible results', () => {
    const numberFormula: PropDef = {
      id: 'fx-num',
      name: 'Count',
      type: 'formula',
      formulaResultType: 'number',
      format: { precision: 0 },
      options: [],
    };
    // 0 is preserved
    expect(formatValue(numberFormula, 0)).toBe('0');
    // null returns empty string
    expect(formatValue(numberFormula, null)).toBe('');

    const boolFormula: PropDef = {
      id: 'fx-bool',
      name: 'Active',
      type: 'formula',
      options: [],
    };
    expect(formatDisplayValue(boolFormula, false, 'pt')).toBe('Não');
    expect(formatDisplayValue(boolFormula, true, 'pt')).toBe('Sim');

    // Incompatible string result on a currency formula is not coerced to NaN or masked
    expect(formatValue(numberFormula, 'Calculation Error #DIV/0!')).toBe('Calculation Error #DIV/0!');
  });

  it('diagnoses incompatible formula results without confusing 0, false, null, and formats date/datetime with parity', () => {
    let state = emptyWorkspace();
    const props: PropDef[] = [
      {
        id: 'fx-num-bad',
        name: 'BadNumber',
        type: 'formula',
        formula: '"incompatible text"',
        formulaResultType: 'number',
        options: [],
      },
      {
        id: 'fx-num-zero',
        name: 'ZeroNumber',
        type: 'formula',
        formula: '0',
        formulaResultType: 'number',
        options: [],
      },
      {
        id: 'fx-bool-false',
        name: 'FalseCheck',
        type: 'formula',
        formula: 'false',
        formulaResultType: 'checkbox',
        options: [],
      },
      {
        id: 'fx-datetime',
        name: 'DueAt',
        type: 'formula',
        formulaResultType: 'datetime',
        format: { dateStyle: 'short', timeStyle: 'short', locale: 'en-US' },
        options: [],
      },
      {
        id: 'fx-scale',
        name: 'Rating',
        type: 'formula',
        formulaResultType: 'scale',
        format: { min: 1, max: 5 },
        options: [],
      },
    ];
    state = createDatabase(state, 'db-fx', 'Formulas', props);
    state = createRow(state, 'row-1', 'db-fx', 'Row 1', {});
    const row = state.pages['row-1']!;
    const db = state.pages['db-fx']!.database!;

    // Incompatible string output on formula with formulaResultType: 'number' triggers diagnostic error
    const badResult = formulaResult(row, props[0]!, db, 0, state);
    expect(badResult.error).toContain('must be a finite number');
    expect(badResult.value).toBeNull();

    // 0 is preserved as number without becoming null
    const zeroResult = formulaResult(row, props[1]!, db, 0, state);
    expect(zeroResult.error).toBeNull();
    expect(zeroResult.value).toBe(0);

    // false is preserved as boolean without becoming null
    const falseResult = formulaResult(row, props[2]!, db, 0, state);
    expect(falseResult.error).toBeNull();
    expect(falseResult.value).toBe(false);

    // Date/DateTime format parity
    const dtProp = props[3]!;
    expect(formatValue(dtProp, '2026-10-28T14:30:00.000Z')).toContain('10/28/26');

    // Scale format parity
    const scaleProp = props[4]!;
    expect(formatValue(scaleProp, 4)).toBe('4');
  });
});

describe('Delivery 3 — Inverse Relations Union & Unlink (#43)', () => {
  it('creates and links a new inverse relation while reconciling existing owner values', () => {
    let state = emptyWorkspace();
    state = createDatabase(state, 'books', 'Books', [
      {
        id: 'book-author',
        name: 'Author',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ]);
    state = createDatabase(state, 'authors', 'Authors', [
      { id: 'author-name', name: 'Name', type: 'text', options: [] },
    ]);
    state = createRow(state, 'book-1', 'books', 'Dune', { 'book-author': 'author-1' });
    state = createRow(state, 'author-1', 'authors', 'Ursula Le Guin');

    const result = applyCommand(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'book-author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'author-name',
        inversePropertyId: null,
        filters: [],
      },
      createInverseProperty: { id: 'author-books', name: 'Books', multiple: true },
      now: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = result.value.state;
    const inverse = next.pages.authors!.database!.properties.find((prop) => prop.id === 'author-books');
    expect(inverse).toMatchObject({
      type: 'relation',
      relation: {
        targetDatabaseId: 'books',
        multiple: true,
        isInverse: true,
        inversePropertyId: 'book-author',
      },
    });
    expect(
      valueOf(next.pages['author-1']!, 'author-books', next.pages.authors!.database!, next),
    ).toEqual(['book-1']);

    // preserve the input state so a rejected configuration cannot leave partial edits
    expect(
      state.pages.authors!.database!.properties.some((prop) => prop.id === 'author-books'),
    ).toBe(false);
    expect(state.pages.books!.database!.properties[0]!.relation?.targetDatabaseId).toBeNull();
  });

  it('rejects a conflicting new inverse property without changing either database schema', () => {
    let state = emptyWorkspace();
    state = createDatabase(state, 'books', 'Books', [
      {
        id: 'book-authors',
        name: 'Authors',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: true,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ]);
    state = createDatabase(state, 'authors', 'Authors', [
      { id: 'author-name', name: 'Name', type: 'text', options: [] },
    ]);
    state = createRow(state, 'book-1', 'books', 'Book 1', { 'book-authors': 'author-1' });
    state = createRow(state, 'book-2', 'books', 'Book 2', { 'book-authors': 'author-1' });
    state = createRow(state, 'author-1', 'authors', 'Ursula Le Guin');

    const result = applyCommand(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'book-authors',
      relation: {
        targetDatabaseId: 'authors',
        multiple: true,
        isInverse: false,
        displayPropertyId: 'author-name',
        inversePropertyId: null,
        filters: [],
      },
      createInverseProperty: { id: 'author-book', name: 'Book', multiple: false },
      now: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cardinality conflict/i);
    expect(state.pages.authors!.database!.properties).toHaveLength(1);
    expect(state.pages.books!.database!.properties[0]!.relation?.targetDatabaseId).toBeNull();
    expect(state.pages['book-1']!.properties['book-authors']).toBe('author-1');
    expect(state.pages['book-2']!.properties['book-authors']).toBe('author-1');
  });

  it('rejects creating an inverse property when the target database already has 200 properties', () => {
    let state = emptyWorkspace();
    state = createDatabase(state, 'books', 'Books', [
      {
        id: 'book-author',
        name: 'Author',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ]);
    const targetProperties = Array.from({ length: 200 }, (_, index) => ({
      id: `author-property-${index}`,
      name: `Property ${index}`,
      type: 'text' as const,
      options: [],
    }));
    state = createDatabase(state, 'authors', 'Authors', targetProperties);

    const result = applyCommand(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'book-author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'author-property-0',
        inversePropertyId: null,
        filters: [],
      },
      createInverseProperty: { id: 'author-books', name: 'Books', multiple: true },
      now: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at most 200 properties/i);
    expect(state.pages.authors!.database!.properties).toHaveLength(200);
    expect(state.pages.authors!.database!.properties.some((prop) => prop.id === 'author-books')).toBe(false);
    expect(state.pages.books!.database!.properties[0]!.relation?.targetDatabaseId).toBeNull();
  });

  it('rejects an invalid explicit inverse property id without changing relation data', () => {
    let state = emptyWorkspace();
    state = createDatabase(state, 'books', 'Books', [
      {
        id: 'book-author',
        name: 'Author',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ]);
    const targetProperties: PropDef[] = [
      { id: 'author-name', name: 'Name', type: 'text', options: [] },
    ];
    state = createDatabase(state, 'authors', 'Authors', targetProperties);
    state = createRow(state, 'book-1', 'books', 'Dune', { 'book-author': 'author-1' });
    state = createRow(state, 'author-1', 'authors', 'Ursula Le Guin');

    const result = applyCommand(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'book-author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'author-name',
        inversePropertyId: null,
        filters: [],
      },
      createInverseProperty: { id: 'bad.id', name: 'Books', multiple: true },
      now: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid inverse property id/i);
    expect(state.pages.authors!.database!.properties).toEqual(targetProperties);
    expect(state.pages.books!.database!.properties[0]!.relation?.targetDatabaseId).toBeNull();
    expect(state.pages['book-1']!.properties['book-author']).toBe('author-1');
  });

  it('rejects an explicit inverse property id already used by another relation', () => {
    let state = emptyWorkspace();
    state = createDatabase(state, 'books', 'Books', [
      {
        id: 'book-author',
        name: 'Author',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ]);
    const targetProperties: PropDef[] = [
      { id: 'author-name', name: 'Name', type: 'text', options: [] },
      {
        id: 'existing-relation',
        name: 'Existing relation',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: null,
          multiple: true,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ];
    state = createDatabase(state, 'authors', 'Authors', targetProperties);
    state = createRow(state, 'book-1', 'books', 'Dune', { 'book-author': 'author-1' });
    state = createRow(state, 'author-1', 'authors', 'Ursula Le Guin');

    const result = applyCommand(state, {
      type: 'relation.configure',
      databaseId: 'books',
      propertyId: 'book-author',
      relation: {
        targetDatabaseId: 'authors',
        multiple: false,
        isInverse: false,
        displayPropertyId: 'author-name',
        inversePropertyId: null,
        filters: [],
      },
      createInverseProperty: { id: 'existing-relation', name: 'Books', multiple: true },
      now: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already exists in the target database/i);
    expect(state.pages.authors!.database!.properties).toEqual(targetProperties);
    expect(state.pages.books!.database!.properties[0]!.relation?.targetDatabaseId).toBeNull();
    expect(state.pages['book-1']!.properties['book-author']).toBe('author-1');
  });

  it('previews pair union correctly and detects cardinality conflicts', () => {
    let state = emptyWorkspace();
    const studentsDb: PropDef[] = [
      { id: 's-mentor', name: 'Mentor', type: 'relation', options: [], relation: { targetDatabaseId: 'mentors', multiple: false, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] } },
    ];
    state = createDatabase(state, 'students', 'Students', studentsDb);

    const mentorsDb: PropDef[] = [
      { id: 'm-students', name: 'Mentees', type: 'relation', options: [], relation: { targetDatabaseId: 'students', multiple: true, isInverse: false, displayPropertyId: null, inversePropertyId: null, filters: [] } },
    ];
    state = createDatabase(state, 'mentors', 'Mentors', mentorsDb);

    // Row student 1 -> mentor 1
    state = createRow(state, 'student-1', 'students', 'Alice', { 's-mentor': 'mentor-1' });
    // Row student 2 -> mentor 1
    state = createRow(state, 'student-2', 'students', 'Bob', { 's-mentor': 'mentor-1' });
    // Row mentor 1 -> student 3
    state = createRow(state, 'mentor-1', 'mentors', 'Professor Xavier', { 'm-students': ['student-3'] });
    state = createRow(state, 'student-3', 'students', 'Charlie', {});

    // Preview union of students.s-mentor and mentors.m-students
    const preview = previewRelationPairUnion(
      state,
      'students',
      's-mentor',
      false, // student allows only 1 mentor
      'mentors',
      'm-students',
      true, // mentor allows multiple students
    );

    expect(preview.canLink).toBe(true);
    expect(preview.sourcePairsCount).toBe(2); // student-1, student-2
    expect(preview.targetPairsCount).toBe(1); // student-3
    expect(preview.totalUniquePairsCount).toBe(3); // student-1, student-2, student-3 all linked to mentor-1

    // If source cardinality was violated (e.g. Charlie had mentor-2 in students table)
    let conflictState = createRow(state, 'student-3', 'students', 'Charlie', { 's-mentor': 'mentor-2' });
    conflictState = createRow(conflictState, 'mentor-2', 'mentors', 'Magneto', {});
    // When mentor-1 also linked student-3, student-3 would have 2 mentors!
    const conflictPreview = previewRelationPairUnion(
      conflictState,
      'students',
      's-mentor',
      false, // student only accepts 1 mentor
      'mentors',
      'm-students',
      true,
    );
    expect(conflictPreview.canLink).toBe(false);
    expect(conflictPreview.conflicts.length).toBeGreaterThan(0);
  });

  it('materializes projected links upon unlinking so no relations are lost', () => {
    let state = emptyWorkspace();
    const tasksDb: PropDef[] = [
      {
        id: 'task-proj',
        name: 'Project',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: 'projects',
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: 'proj-tasks',
          filters: [],
        },
      },
    ];
    state = createDatabase(state, 'tasks', 'Tasks', tasksDb);

    const projectsDb: PropDef[] = [
      {
        id: 'proj-tasks',
        name: 'Tasks',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: 'tasks',
          multiple: true,
          isInverse: true,
          displayPropertyId: null,
          inversePropertyId: 'task-proj',
          filters: [],
        },
      },
    ];
    state = createDatabase(state, 'projects', 'Projects', projectsDb);

    state = createRow(state, 'task-1', 'tasks', 'Build feature', { 'task-proj': 'proj-1' });
    state = createRow(state, 'task-2', 'tasks', 'Write tests', { 'task-proj': 'proj-1' });
    state = createRow(state, 'proj-1', 'projects', 'Polaris Project', {});

    // While inverse is linked, projects value is projected
    expect(valueOf(state.pages['proj-1']!, 'proj-tasks', state.pages.projects!.database!, state)).toEqual([
      'task-1',
      'task-2',
    ]);

    // Unlink inverse relation from the owning side (setting inversePropertyId: null)
    const unlinkCommand = {
      type: 'relation.configure' as const,
      databaseId: 'tasks',
      propertyId: 'task-proj',
      relation: {
        targetDatabaseId: 'projects',
        multiple: false,
        isInverse: false,
        displayPropertyId: null,
        inversePropertyId: null,
        filters: [],
      },
      now: 10,
    };
    const unlinkedResult = run(state, unlinkCommand);

    // Both tasks retain their link
    expect(unlinkedResult.pages['task-1']!.properties['task-proj']).toBe('proj-1');
    expect(unlinkedResult.pages['task-2']!.properties['task-proj']).toBe('proj-1');

    // The inverse column is no longer an inverse projection
    const targetProp = unlinkedResult.pages.projects!.database!.properties.find((p) => p.id === 'proj-tasks')!;
    expect(targetProp.relation?.isInverse).toBe(false);

    // Crucial: values that were projected are now materialized in proj-1 row!
    expect(unlinkedResult.pages['proj-1']!.properties['proj-tasks']).toEqual(['task-1', 'task-2']);
  });
});
