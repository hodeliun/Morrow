import { describe, expect, it } from 'vitest';
import { commandErrorMessage } from './commandMessages';
import type { ResultFailure } from '../core/result';

const failure: ResultFailure = {
  ok: false,
  error: 'This page is used by linked database views.',
  reason: {
    kind: 'linkedViewsBlockingTrash',
    hostPageIds: ['overview', 'catalog', 'budget', 'archive'],
    referenceCount: 5,
  },
};

const titles: Record<string, string> = {
  overview: 'Visão geral',
  catalog: 'Catálogo',
  budget: 'Orçamento',
  archive: 'Arquivo',
};

describe('command error messages', () => {
  it.each([
    ['en', 'This page contains a database used by linked views', '2 additional linked view references'],
    [
      'es',
      'Esta página contiene una base de datos usada por vistas vinculadas',
      'Hay 2 referencias adicionales',
    ],
    [
      'pt',
      'Esta página contém um banco de dados usado por visualizações vinculadas',
      'Há 2 referências adicionais',
    ],
  ] as const)('localizes the linked view trash refusal in %s', (locale, translatedPrefix, countText) => {
    const message = commandErrorMessage(failure, (id) => titles[id], locale);

    expect(message).toContain(translatedPrefix);
    expect(message).toContain('“Visão geral”');
    expect(message).toContain('“Catálogo”');
    expect(message).toContain('“Orçamento”');
    expect(message).not.toContain('“Arquivo”');
    expect(message).toContain(countText);
    expect(message).not.toContain(failure.error);
  });

  it('keeps generic command errors unchanged', () => {
    const genericFailure: ResultFailure = { ok: false, error: 'Invalid property.' };
    expect(commandErrorMessage(genericFailure, () => undefined, 'pt')).toBe('Invalid property.');
  });
});
