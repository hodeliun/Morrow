import { describe, expect, it } from 'vitest';
import { cellEditStartKey } from './cellEditing';

describe('cellEditStartKey', () => {
  it('returns the printable key, including space and Unicode', () => {
    for (const text of ['a', ' ', 'ç', '東京', '🌱'])
      expect(cellEditStartKey({ key: text })).toEqual({ kind: 'text', text });
  });

  it('leaves navigation keys and shortcuts alone', () => {
    for (const key of ['ArrowDown', 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'F2'])
      expect(cellEditStartKey({ key })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'c', ctrlKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'v', metaKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'x', altKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: '@', ctrlKey: true, altKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: '@', metaKey: true, altGraph: true })).toEqual({ kind: 'none' });
  });

  it('rejects multi-character W3C key names with digits but keeps a single digit printable', () => {
    for (const key of ['Key11', 'LaunchApplication1', 'Numpad1'])
      expect(cellEditStartKey({ key })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: '1' })).toEqual({ kind: 'text', text: '1' });
    expect(cellEditStartKey({ key: 'é2' })).toEqual({ kind: 'text', text: 'é2' });
  });

  it('accepts an explicitly reported AltGraph key and excludes IME composition keys', () => {
    expect(cellEditStartKey({ key: '@', ctrlKey: true, altKey: true, altGraph: true })).toEqual({
      kind: 'text',
      text: '@',
    });
    expect(cellEditStartKey({ key: 'Dead' })).toEqual({ kind: 'composition' });
    expect(cellEditStartKey({ key: 'Process' })).toEqual({ kind: 'composition' });
    expect(cellEditStartKey({ key: 'a', keyCode: 229 })).toEqual({ kind: 'composition' });
    expect(cellEditStartKey({ key: 'a', isComposing: true })).toEqual({ kind: 'composition' });
  });
});
