import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { FileMeta } from '../../core/model';
import { Image as ImageExtension } from './Media';
import { findDirectHoverCorridor, intersectVisibleClipBounds, viewportPositionToContainingBlock } from './mediaPositioning';

vi.mock('../platform/attachments', () => ({
  downloadFile: vi.fn(),
  fileUrl: vi.fn(),
  formatBytes: vi.fn(),
  storeFiles: vi.fn(),
}));

vi.mock('../i18n', () => ({ t: (key: string) => key }));
vi.mock('../ui', () => ({ toast: vi.fn() }));

import { fileUrl, storeFiles } from '../platform/attachments';

class TestElement {
  readonly tagName: string;
  readonly nodeType = 1;
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly classList = {
    values: new Set<string>(),
    add: (...names: string[]) => names.forEach((name) => this.classList.values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classList.values.delete(name)),
    contains: (name: string) => this.classList.values.has(name),
  };
  readonly style: Record<string, string> = {};
  rect = { left: 0, top: 0, width: 0, height: 0 };
  parentElement: TestElement | null = null;
  clientLeft = 0;
  clientTop = 0;
  clientRight = 0;
  clientBottom = 0;
  clientWidth = 0;
  clientHeight = 0;
  scrollLeft = 0;
  scrollTop = 0;

  get offsetParent(): TestElement | null {
    return this.parentElement;
  }
  className = '';
  textContent = '';
  innerHTML = '';
  src = '';
  currentSrc = '';
  files: File[] | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  type = '';
  min = '';
  max = '';
  step = '';
  title = '';
  value = '';
  placeholder = '';
  accept = '';
  alt = '';
  draggable = false;
  contentEditable = '';
  tabIndex = 0;

  constructor(tagName: string) {
    this.tagName = tagName;
    Object.defineProperties(this.style, {
      setProperty: {
        value: (name: string, value: string | null) => {
          this.style[name] = value ?? '';
        },
      },
      removeProperty: {
        value: (name: string) => {
          const previous = this.style[name] ?? '';
          delete this.style[name];
          return previous;
        },
      },
    });
  }

  appendChild(child: TestElement): TestElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(target: TestElement): boolean {
    let current: TestElement | null = target;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  append(...children: TestElement[]): void {
    children.forEach((child) => this.appendChild(child));
  }

  prepend(child: TestElement): void {
    child.parentElement = this;
    this.children.unshift(child);
  }

  replaceChildren(...children: TestElement[]): void {
    this.children.forEach((child) => (child.parentElement = null));
    this.children.length = 0;
    this.append(...children);
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string): void {
    this.emitEvent(type);
  }

  emitEvent(type: string, event: Record<string, unknown> = {}): void {
    this.listeners.get(type)?.forEach((listener) =>
      listener({ preventDefault() {}, stopPropagation() {}, ...event }),
    );
  }

  getBoundingClientRect(): DOMRect {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
      x: this.rect.left,
      y: this.rect.top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): TestElement | null {
    const selectors = selector.split(',').map((item) => item.trim());
    const matches = (element: TestElement): boolean => {
      const classes = element.className.split(/\s+/);
      const matchesClass = selectors.some(
        (item) => item.startsWith('.') && !item.includes(' ') && classes.includes(item.slice(1)),
      );
      const matchesRemoteButton =
        selectors.includes('.image-remote button') &&
        element.tagName === 'button' &&
        Boolean(element.parentElement?.closest('.image-remote'));
      return matchesClass || matchesRemoteButton;
    };
    const findClosest = (element: TestElement | null): TestElement | null => {
      if (!element) return null;
      return matches(element) ? element : findClosest(element.parentElement);
    };
    return findClosest(this);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  focus(): void {}
  click(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
}

const imageSchema = new Schema({
  nodes: {
    doc: { content: 'image+' },
    text: { group: 'inline' },
    image: {
      group: 'block',
      atom: true,
      attrs: {
        fileId: { default: null },
        src: { default: null },
        alt: { default: '' },
        align: { default: 'center' },
        caption: { default: '' },
        crop: { default: null },
        width: { default: null },
        markerMetadata: { default: null },
      },
    },
  },
});

function makeImageNode(
  fileId: string | null,
  attrs: {
    align?: string;
    caption?: string;
    crop?: ProseMirrorNode['attrs']['crop'];
    markerMetadata?: ProseMirrorNode['attrs']['markerMetadata'];
    src?: string | null;
    width?: number | null;
  } = {},
): ProseMirrorNode {
  return imageSchema.nodes.image.create({
    fileId,
    src: attrs.src ?? null,
    alt: 'synthetic image',
    align: attrs.align ?? 'center',
    caption: attrs.caption ?? '',
    crop: attrs.crop ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    width: attrs.width ?? null,
    markerMetadata: attrs.markerMetadata ?? null,
  });
}

type TestNodeView = {
  dom: HTMLElement;
  update: (node: ProseMirrorNode) => boolean;
  stopEvent: (event: Event) => boolean;
  destroy?: () => void;
};

function findElement(root: TestElement, tagName: string): TestElement {
  if (root.tagName === tagName) return root;
  for (const child of root.children) {
    try {
      return findElement(child, tagName);
    } catch {
      // Continue searching sibling nodes.
    }
  }
  throw new Error(`Could not find <${tagName}>`);
}

function findByClass(root: TestElement, className: string): TestElement {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    try {
      return findByClass(child, className);
    } catch {
      // Continue searching sibling nodes.
    }
  }
  throw new Error(`Could not find .${className}`);
}

function renderImageNodeView(node: ProseMirrorNode, view: EditorView = {} as EditorView): TestNodeView {
  const createNodeView = ImageExtension.config.addNodeView;
  if (!createNodeView) throw new Error('Image node view is not configured');
  const render = createNodeView.call({} as ThisParameterType<typeof createNodeView>);
  if (!render) throw new Error('Image node view renderer is not configured');
  return render({ node, view, getPos: () => 0 } as Parameters<typeof render>[0]) as TestNodeView;
}

function stubDocument(): TestElement[] {
  const elements: TestElement[] = [];
  vi.stubGlobal('document', {
    createElement: (tagName: string) => {
      const element = new TestElement(tagName);
      elements.push(element);
      return element;
    },
  });
  return elements;
}

function stubWindow() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const target = {
    innerWidth: 520,
    innerHeight: 720,
    getComputedStyle(element: TestElement) {
      return {
        display: element.style.display ?? '',
        visibility: element.style.visibility ?? '',
        pointerEvents: element.style.pointerEvents ?? 'auto',
        opacity: element.style.opacity ?? '1',
        borderLeftWidth: element.style.borderLeftWidth ?? (element.className.split(/\s+/).includes('image-toolbar') ? '1px' : '0px'),
        borderRightWidth: element.style.borderRightWidth ?? (element.className.split(/\s+/).includes('image-toolbar') ? '1px' : '0px'),
        borderTopWidth: element.style.borderTopWidth ?? (element.className.split(/\s+/).includes('image-toolbar') ? '1px' : '0px'),
        borderBottomWidth: element.style.borderBottomWidth ?? (element.className.split(/\s+/).includes('image-toolbar') ? '1px' : '0px'),
        overflowX: element.style.overflowX ?? 'visible',
        overflowY: element.style.overflowY ?? 'visible',
      } as CSSStyleDeclaration;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
    },
    emit(type: string, event: Record<string, unknown> = {}) {
      (listeners.get(type) ?? []).forEach((listener) =>
        listener({ preventDefault() {}, stopPropagation() {}, pointerId: 1, ...event }),
      );
    },
  };
  vi.stubGlobal('window', target);
  return target;
}

function createMockView(initialNode: ProseMirrorNode) {
  let state = EditorState.create({ schema: imageSchema, doc: imageSchema.nodes.doc.create(null, [initialNode]) });
  const holder: { nodeView: TestNodeView | null } = { nodeView: null };
  let dispatchCount = 0;
  let editable = true;
  const view = {
    get editable() {
      return editable;
    },
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      dispatchCount += 1;
      state = state.apply(transaction);
      const updated = state.doc.firstChild;
      if (holder.nodeView && updated) holder.nodeView.update(updated);
    },
  };
  return {
    view: view as unknown as EditorView,
    setNodeView(nodeView: TestNodeView) {
      holder.nodeView = nodeView;
    },
    setEditable(value: boolean) {
      editable = value;
    },
    readNode() {
      return state.doc.firstChild!;
    },
    get dispatchCount() {
      return dispatchCount;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('viewport positioning relative to an absolute containing block', () => {
  test('subtracts the border-box origin and border while accounting for scroll offsets', () => {
    expect(viewportPositionToContainingBlock(
      { left: 360, top: 653 },
      { left: 56, top: 489.375, clientLeft: 1, clientTop: 1, scrollLeft: 0, scrollTop: 0 },
    )).toEqual({ left: 303, top: 162.625 });
    expect(viewportPositionToContainingBlock(
      { left: 206, top: 653 },
      { left: 56, top: 489.375, clientLeft: 1, clientTop: 1, scrollLeft: 7, scrollTop: 3 },
    )).toEqual({ left: 156, top: 165.625 });
  });

  test('uses the initial containing block when the element has no offset parent', () => {
    const position = { left: 24, top: 48 };
    expect(viewportPositionToContainingBlock(position, null)).toBe(position);
  });
});

describe('visible bounds for floating media controls', () => {
  test('clips only overflow axes to ancestor client boxes and the viewport', () => {
    expect(intersectVisibleClipBounds(
      { left: 0, top: 0, right: 520, bottom: 1000 },
      [
        {
          left: 28, top: 90, clientLeft: 2, clientTop: 3, clientWidth: 460, clientHeight: 810,
          clipX: true, clipY: false,
        },
        {
          left: 40, top: 80, clientLeft: 4, clientTop: 5, clientWidth: 400, clientHeight: 700,
          clipX: false, clipY: true,
        },
        {
          left: 100, top: 200, clientLeft: 0, clientTop: 0, clientWidth: 20, clientHeight: 20,
          clipX: false, clipY: false,
        },
      ],
    )).toEqual({ left: 30, top: 85, right: 490, bottom: 785 });
  });

  test('tracks the effective client clip when a pane is resized without treating visible wrappers as clips', () => {
    const viewport = { left: 0, top: 0, right: 520, bottom: 1000 };
    const visibleWrapper = {
      left: 28, top: 20, clientLeft: 0, clientTop: 0, clientWidth: 464, clientHeight: 960,
      clipX: false, clipY: false,
    };
    const narrowPane = {
      left: 240, top: 90, clientLeft: 1, clientTop: 2, clientWidth: 240, clientHeight: 510,
      clipX: true, clipY: true,
    };

    expect(intersectVisibleClipBounds(viewport, [visibleWrapper, narrowPane])).toEqual({
      left: 241, top: 92, right: 481, bottom: 602,
    });
    expect(intersectVisibleClipBounds(viewport, [visibleWrapper])).toEqual(viewport);
  });

  test('finds only a direct corridor inside the clip that avoids resize handles and neighboring images', () => {
    const image = { left: 28, top: 90.375, right: 32.5, bottom: 92.921875 };
    const toolbar = { left: 56, top: 90.375, right: 280, bottom: 126.375 };
    const bounds = { left: 0, top: 90, right: 520, bottom: 720 };
    const handle = { left: 28, top: image.bottom, right: 52, bottom: image.bottom + 24 };

    expect(findDirectHoverCorridor(image, toolbar, bounds, [handle])).toEqual({
      left: image.right,
      top: image.top,
      right: toolbar.left,
      bottom: image.bottom,
    });
    expect(findDirectHoverCorridor(image, toolbar, bounds, [
      handle,
      { left: 40, top: image.top, right: 44, bottom: image.bottom },
    ])).toBeNull();
    expect(findDirectHoverCorridor(image, toolbar, { ...bounds, top: 94 }, [handle])).toBeNull();
  });

  test('rejects subpixel cross-sections without rejecting a subpixel gap length', () => {
    const image = { left: 355, top: 90, right: 362.1875, bottom: 93.546875 };
    const toolbar = { left: 383, top: 93.515625, right: 607, bottom: 129.515625 };
    const bounds = { left: 0, top: 90, right: 1430, bottom: 1000 };
    const handle = { left: 355, top: 93.546875, right: 379, bottom: 117.546875 };
    expect(findDirectHoverCorridor(image, toolbar, bounds, [handle])).toBeNull();
    expect(findDirectHoverCorridor(image, { ...toolbar, top: 90, bottom: 126 }, bounds, [handle])).toEqual({
      left: image.right, top: 90, right: toolbar.left, bottom: image.bottom,
    });
    const transpose = (rect: typeof image) => ({ left: rect.top, top: rect.left, right: rect.bottom, bottom: rect.right });
    expect(findDirectHoverCorridor(transpose(image), transpose(toolbar), transpose(bounds), [transpose(handle)])).toBeNull();

    const small = { left: 0, top: 0, right: 4, bottom: 4 };
    const clip = { left: 0, top: 0, right: 20, bottom: 20 };
    expect(findDirectHoverCorridor(small, { left: 6, top: 3.001, right: 10, bottom: 8 }, clip, [])).toBeNull();
    expect(findDirectHoverCorridor(small, { left: 6, top: 3, right: 10, bottom: 8 }, clip, [])).toEqual({
      left: 4, top: 3, right: 6, bottom: 4,
    });
    expect(findDirectHoverCorridor(small, { left: 4.25, top: 0, right: 8.25, bottom: 4 }, clip, [])).toEqual({
      left: 4, top: 0, right: 4.25, bottom: 4,
    });
    expect(findDirectHoverCorridor(small, { left: 4.25, top: 0, right: 8.25, bottom: 4 }, clip, [
      { left: 4.1, top: 0, right: 4.2, bottom: 4 },
    ])).toBeNull();
  });

  test('repositions a reopened toolbar whose lateral corridor is thinner than a CSS pixel', () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    windowStub.innerWidth = 1440;
    windowStub.innerHeight = 1000;
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const pageScroll = new TestElement('div');
    pageScroll.style.overflowY = 'auto';
    pageScroll.style.overflowX = 'hidden';
    pageScroll.rect = { left: 0, top: 90, width: 1430, height: 910 };
    pageScroll.clientWidth = 1430;
    pageScroll.clientHeight = 910;
    const container = new TestElement('div');
    container.className = 'column-content';
    container.rect = { left: 355, top: 0, width: 720, height: 1000 };
    pageScroll.appendChild(container);
    container.appendChild(figure);
    figure.rect = { left: 355, top: 89.515625, width: 7.1875, height: 48 };
    const image = findElement(figure, 'img');
    const wrapper = findByClass(figure, 'image-crop-wrapper');
    wrapper.rect = image.rect = { left: 355, top: 89.515625, width: 7.1875, height: 4.03125 };
    const toolbar = findByClass(figure, 'image-toolbar');
    toolbar.rect = { left: 383, top: 93.515625, width: 224, height: 36 };
    toolbar.getBoundingClientRect = () => {
      const cssLeft = Number.parseFloat(toolbar.style.left ?? '');
      const cssTop = Number.parseFloat(toolbar.style.top ?? '');
      const left = Number.isFinite(cssLeft) ? figure.rect.left + cssLeft : toolbar.rect.left;
      const top = Number.isFinite(cssTop) ? figure.rect.top + cssTop : toolbar.rect.top;
      return { left, top, right: left + 224, bottom: top + 36, width: 224, height: 36 } as DOMRect;
    };
    findByClass(figure, 'image-resize-handle').rect = { left: 355, top: 93.546875, width: 24, height: 24 };
    figure.emit('mouseenter');
    const toolbarBounds = toolbar.getBoundingClientRect();
    expect(toolbarBounds.top).toBe(90);
    const corridor = findByClass(figure, 'image-toolbar-hover-corridor');
    expect(Number.parseFloat(corridor.style.height ?? '')).toBeGreaterThanOrEqual(1);
    expect(corridor.style.pointerEvents).toBe('auto');
    nodeView.destroy?.();
  });

  test('keeps a colliding closed toolbar connected to a tiny image under tall note typography', () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    windowStub.innerWidth = 520;
    windowStub.innerHeight = 900;
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const pageScroll = new TestElement('div');
    pageScroll.style.overflowY = 'auto';
    pageScroll.style.overflowX = 'hidden';
    pageScroll.rect = { left: 0, top: 90, width: 510, height: 810 };
    pageScroll.clientWidth = 510;
    pageScroll.clientHeight = 810;
    const container = new TestElement('div');
    container.rect = { left: 28, top: 90, width: 454, height: 810 };
    pageScroll.appendChild(container);
    container.appendChild(figure);
    figure.rect = { left: 28, top: 90.375, width: 4.53125, height: 48 };
    const image = findElement(figure, 'img');
    const wrapper = findByClass(figure, 'image-crop-wrapper');
    wrapper.rect = image.rect = { left: 28, top: 90.375, width: 4.53125, height: 2.546875 };
    const toolbar = findByClass(figure, 'image-toolbar');
    toolbar.rect = { left: 28, top: 98.375, width: 224, height: 36 };
    toolbar.getBoundingClientRect = () => {
      const cssLeft = Number.parseFloat(toolbar.style.left ?? '');
      const cssTop = Number.parseFloat(toolbar.style.top ?? '');
      const left = Number.isFinite(cssLeft) ? figure.rect.left + cssLeft : toolbar.rect.left;
      const top = Number.isFinite(cssTop) ? figure.rect.top + cssTop : toolbar.rect.top;
      return { left, top, right: left + 224, bottom: top + 36, width: 224, height: 36 } as DOMRect;
    };
    const handle = findByClass(figure, 'image-resize-handle');
    handle.rect = { left: 28, top: 92.921875, width: 24, height: 24 };
    figure.emit('mouseenter');
    const bounds = toolbar.getBoundingClientRect();
    const corridor = findDirectHoverCorridor(
      { left: image.rect.left, top: image.rect.top, right: image.rect.left + image.rect.width,
        bottom: image.rect.top + image.rect.height },
      bounds,
      { left: 0, top: 90, right: 510, bottom: 900 },
      [{ left: handle.rect.left, top: handle.rect.top, right: handle.rect.left + 24,
        bottom: handle.rect.top + 24 }],
    );
    expect(corridor).not.toBeNull();
    expect(findByClass(figure, 'image-toolbar-hover-corridor').style.pointerEvents).toBe('auto');
    nodeView.destroy?.();
  });

  test('keeps the hover toolbar and its narrow image corridor inside real overflow clips', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const pageScroll = new TestElement('div');
    pageScroll.style.overflowY = 'auto';
    pageScroll.style.overflowX = 'hidden';
    pageScroll.rect = { left: 0, top: 90, width: 520, height: 630 };
    pageScroll.clientWidth = 520;
    pageScroll.clientHeight = 630;
    const paneContent = new TestElement('div');
    paneContent.className = 'column-content';
    paneContent.rect = { left: 28, top: 0, width: 464, height: 900 };
    pageScroll.appendChild(paneContent);
    paneContent.appendChild(figure);
    figure.rect = { left: 28, top: 44.98, width: 464, height: 80 };

    const wrapper = findByClass(figure, 'image-crop-wrapper');
    wrapper.rect = { left: 28, top: 90.375, width: 4.5, height: 2.546875 };
    const image = findElement(figure, 'img');
    image.rect = { ...wrapper.rect };
    const toolbar = findByClass(figure, 'image-toolbar');
    toolbar.rect = { left: 56, top: 52.98, width: 224, height: 36 };
    const positionedRect = (element: TestElement, fallback: TestElement['rect']) => {
      const left = Number.parseFloat(element.style.left ?? '');
      const top = Number.parseFloat(element.style.top ?? '');
      return {
        left: Number.isFinite(left) ? figure.rect.left + left : fallback.left,
        top: Number.isFinite(top) ? figure.rect.top + top : fallback.top,
        width: fallback.width,
        height: fallback.height,
      };
    };
    toolbar.getBoundingClientRect = () => {
      const bounds = positionedRect(toolbar, toolbar.rect);
      return {
        ...bounds,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        x: bounds.left,
        y: bounds.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const handle = findByClass(figure, 'image-resize-handle');
    handle.rect = { left: 28, top: 92.921875, width: 24, height: 24 };
    const corridor = figure.children.find((child) => child.className === 'image-toolbar-hover-corridor')!;
    Object.defineProperty(corridor, 'offsetParent', {
      get: () => {
        expect(corridor.style.pointerEvents).toBe('none');
        return corridor.style.display === 'none' ? null : figure;
      },
    });
    const expectCorridorInactive = () => {
      expect(corridor.style.display).toBe('none');
      expect(corridor.style.pointerEvents).toBe('none');
    };
    const expectCorridorActive = () => {
      expect(corridor.style.display).not.toBe('none');
      expect(corridor.style.pointerEvents).toBe('auto');
    };

    expectCorridorInactive();
    windowStub.emit('resize');
    windowStub.emit('scroll');
    expectCorridorInactive();

    figure.emit('mouseenter');
    expectCorridorActive();

    const toolbarBounds = toolbar.getBoundingClientRect();
    expect(toolbarBounds.top).toBeGreaterThanOrEqual(pageScroll.rect.top);
    expect(toolbarBounds.bottom).toBeLessThanOrEqual(pageScroll.rect.top + pageScroll.clientHeight);
    const expectSafeCorridor = () => {
      const corridor = figure.children.find((child) => child.className === 'image-toolbar-hover-corridor');
      const toolbarBounds = toolbar.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      const handleBounds = handle.getBoundingClientRect();
      let bounds: { left: number; top: number; right: number; bottom: number };
      if (corridor?.style.display !== 'none' && corridor?.style.pointerEvents === 'auto') {
        corridor.getBoundingClientRect = () => {
          const left = figure.rect.left + Number.parseFloat(corridor.style.left ?? '0');
          const top = figure.rect.top + Number.parseFloat(corridor.style.top ?? '0');
          const width = Number.parseFloat(corridor.style.width ?? '0');
          const height = Number.parseFloat(corridor.style.height ?? '0');
          return {
            left, top, width, height, right: left + width, bottom: top + height,
            x: left, y: top, toJSON: () => ({}),
          } as DOMRect;
        };
        bounds = corridor.getBoundingClientRect();
        expect(bounds.left).toBeCloseTo(imageBounds.right);
        expect(bounds.right).toBeCloseTo(toolbarBounds.left);
      } else {
        const gap = toolbar.getAttribute('data-resize-gap');
        expect(['before', 'after', 'left', 'right']).toContain(gap);
        const px = (side: string) => Number.parseFloat(toolbar.style[`--image-toolbar-bridge-${side}`] ?? '0') || 0;
        bounds = gap === 'before'
          ? { left: toolbarBounds.left + 1 + px('left'), top: toolbarBounds.top - 3, right: toolbarBounds.right - 1 - px('right'), bottom: toolbarBounds.top + 1 }
          : gap === 'after'
            ? { left: toolbarBounds.left + 1 + px('left'), top: toolbarBounds.bottom - 1, right: toolbarBounds.right - 1 - px('right'), bottom: toolbarBounds.bottom + 3 }
            : gap === 'left'
              ? { left: toolbarBounds.left - 3, top: toolbarBounds.top + 1 + px('top'), right: toolbarBounds.left + 1, bottom: toolbarBounds.bottom - 1 - px('bottom') }
              : { left: toolbarBounds.right - 1, top: toolbarBounds.top + 1 + px('top'), right: toolbarBounds.right + 3, bottom: toolbarBounds.bottom - 1 - px('bottom') };
      }
      expect(bounds.right).toBeGreaterThan(bounds.left);
      expect(bounds.bottom).toBeGreaterThan(bounds.top);
      expect(bounds.top).toBeGreaterThanOrEqual(pageScroll.rect.top + pageScroll.clientTop);
      expect(bounds.bottom).toBeLessThanOrEqual(pageScroll.rect.top + pageScroll.clientTop + pageScroll.clientHeight);
      expect(bounds.left < handleBounds.right && bounds.right > handleBounds.left &&
        bounds.top < handleBounds.bottom && bounds.bottom > handleBounds.top).toBe(false);
      const touchesImage = (left: typeof bounds, right: DOMRect) => {
        const verticalOverlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0;
        const horizontalOverlap = Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0;
        return (verticalOverlap && (Math.abs(left.right - right.left) <= 0.5 || Math.abs(right.right - left.left) <= 0.5)) ||
          (horizontalOverlap && (Math.abs(left.bottom - right.top) <= 0.5 || Math.abs(right.bottom - left.top) <= 0.5));
      };
      expect(touchesImage(bounds, imageBounds)).toBe(true);
    };
    expectSafeCorridor();

    figure.emit('mouseleave');
    expectCorridorInactive();
    windowStub.emit('resize');
    windowStub.emit('scroll');
    expectCorridorInactive();

    figure.emit('focusin');
    expectCorridorActive();
    const focusableToolbarChild = toolbar.children[0]!;
    figure.emitEvent('focusout', { relatedTarget: focusableToolbarChild });
    expectCorridorActive();
    figure.emitEvent('focusout', { relatedTarget: new TestElement('button') });
    expectCorridorInactive();
    windowStub.emit('resize');
    windowStub.emit('scroll');
    expectCorridorInactive();

    figure.emit('mouseenter');
    expectCorridorActive();
    expectSafeCorridor();

    pageScroll.rect = { left: 0, top: 50, width: 520, height: 550 };
    pageScroll.clientHeight = 550;
    figure.rect = { ...figure.rect, top: 551.625 };
    wrapper.rect = { ...wrapper.rect, top: 597 };
    image.rect = { ...image.rect, top: 597 };
    handle.rect = { ...handle.rect, top: 599.546875 };
    windowStub.emit('scroll');
    const bottomToolbar = toolbar.getBoundingClientRect();
    expect(bottomToolbar.top).toBeGreaterThanOrEqual(pageScroll.rect.top);
    expect(bottomToolbar.bottom).toBeLessThanOrEqual(pageScroll.rect.top + pageScroll.clientHeight);
    expectSafeCorridor();

    pageScroll.rect = { left: 240, top: 50, width: 240, height: 550 };
    pageScroll.clientLeft = 1;
    pageScroll.clientWidth = 238;
    paneContent.rect = { ...paneContent.rect, left: 240, width: 240 };
    figure.rect = { ...figure.rect, left: 240, width: 240 };
    wrapper.rect = { ...wrapper.rect, left: 250 };
    image.rect = { ...image.rect, left: 250 };
    handle.rect = { ...handle.rect, left: 250 };
    toolbar.rect = { ...toolbar.rect, width: 200 };
    windowStub.emit('resize');
    const resizedToolbar = toolbar.getBoundingClientRect();
    expect(resizedToolbar.left).toBeGreaterThanOrEqual(pageScroll.rect.left + pageScroll.clientLeft);
    expect(resizedToolbar.right).toBeLessThanOrEqual(pageScroll.rect.left + pageScroll.clientLeft + pageScroll.clientWidth);
    expectSafeCorridor();

    figure.emit('mouseleave');
    expectCorridorInactive();
    windowStub.emit('resize');
    windowStub.emit('scroll');
    expectCorridorInactive();
    nodeView.destroy?.();
    expect(windowStub.innerWidth).toBe(520);
  });
});
describe('Image NodeView source updates', () => {
  test('renders the updated fileId, uses its natural ratio, and ignores a late old URL', async () => {
    const oldFileUrl = deferred<string | null>();
    const newFileUrl = deferred<string | null>();
    vi.mocked(fileUrl).mockImplementation((fileId) =>
      String(fileId) === 'old-file' ? oldFileUrl.promise : newFileUrl.promise,
    );
    stubDocument();

    const nodeView = renderImageNodeView(makeImageNode('old-file'));
    await flushPromises();
    expect(fileUrl).toHaveBeenCalledWith('old-file');

    expect(nodeView.update(makeImageNode('new-file'))).toBe(true);
    await flushPromises();
    expect(fileUrl).toHaveBeenCalledWith('new-file');

    newFileUrl.resolve('blob:synthetic-portrait');
    await flushPromises();

    const image = findElement(nodeView.dom as unknown as TestElement, 'img');
    expect(image.src).toBe('blob:synthetic-portrait');
    image.naturalWidth = 200;
    image.naturalHeight = 400;
    image.currentSrc = image.src;
    image.emit('load');
    expect(image.parentElement?.style.aspectRatio).toBe('0.5 / 1');

    oldFileUrl.resolve('blob:synthetic-landscape');
    await flushPromises();
    expect(image.src).toBe('blob:synthetic-portrait');

    nodeView.destroy?.();
  });

  test('does not apply an image URL that resolves after the NodeView is destroyed', async () => {
    const pendingUrl = deferred<string | null>();
    vi.mocked(fileUrl).mockReturnValue(pendingUrl.promise);
    stubDocument();

    const nodeView = renderImageNodeView(makeImageNode('removed-file'));
    await flushPromises();
    const image = findElement(nodeView.dom as unknown as TestElement, 'img');

    nodeView.destroy?.();
    pendingUrl.resolve('blob:late-image');
    await flushPromises();

    expect(image.src).toBe('');
  });

  test('ignores a late load event from image A after image B fails to resolve', async () => {
    const oldUrl = deferred<string | null>();
    const newUrl = deferred<string | null>();
    vi.mocked(fileUrl).mockImplementation((fileId) =>
      String(fileId) === 'old-file' ? oldUrl.promise : newUrl.promise,
    );
    const elements = stubDocument();

    const nodeView = renderImageNodeView(makeImageNode('old-file'));
    await flushPromises();
    oldUrl.resolve('blob:old-image');
    await flushPromises();
    const image = findElement(nodeView.dom as unknown as TestElement, 'img');
    image.naturalWidth = 400;
    image.naturalHeight = 200;
    image.currentSrc = image.src;
    image.emit('load');

    nodeView.update(makeImageNode('new-file'));
    await flushPromises();
    newUrl.resolve(null);
    await flushPromises();

    image.currentSrc = 'blob:old-image';
    image.emit('load');

    const missingMessage = elements.find((element) => element.className === 'image-missing-message');
    expect(image.src).toBe('');
    expect(image.style.visibility).toBe('hidden');
    expect(missingMessage?.style.display).toBe('');
    expect((nodeView.dom as unknown as TestElement).classList.contains('is-missing')).toBe(true);
    nodeView.destroy?.();
  });

  test('updates remote and missing sources to local files in the same NodeView', async () => {
    vi.mocked(fileUrl).mockImplementation((fileId) => Promise.resolve(`blob:${String(fileId)}`));
    const remoteElements = stubDocument();
    const remoteNodeView = renderImageNodeView(
      makeImageNode(null, { src: 'https://images.example/synthetic.png' }),
    );
    await flushPromises();
    const remoteBox = remoteElements.find((element) => element.className === 'image-remote');
    expect(remoteBox?.parentElement).toBe(remoteNodeView.dom);

    remoteNodeView.update(makeImageNode('local-from-remote'));
    await flushPromises();
    expect(fileUrl).toHaveBeenCalledWith('local-from-remote');
    expect(findElement(remoteNodeView.dom as unknown as TestElement, 'img').src).toBe(
      'blob:local-from-remote',
    );
    expect(remoteBox?.parentElement).toBeNull();
    remoteNodeView.destroy?.();

    const missingElements = stubDocument();
    const missingNodeView = renderImageNodeView(makeImageNode(null));
    expect(missingElements.find((element) => element.className === 'image-missing-message')?.style.display).toBe('');
    missingNodeView.update(makeImageNode('local-from-missing'));
    await flushPromises();
    expect(fileUrl).toHaveBeenCalledWith('local-from-missing');
    expect(findElement(missingNodeView.dom as unknown as TestElement, 'img').src).toBe(
      'blob:local-from-missing',
    );
    expect(missingElements.find((element) => element.className === 'image-missing-message')?.style.display).toBe(
      'none',
    );
    missingNodeView.destroy?.();
  });

  test('switches a local source back to the remote preview and explicit load action', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:local-image');
    const elements = stubDocument();
    const nodeView = renderImageNodeView(makeImageNode('local-file'));
    await flushPromises();

    nodeView.update(makeImageNode(null, { src: 'https://images.example/remote.png' }));
    const image = findElement(nodeView.dom as unknown as TestElement, 'img');
    const remoteBox = elements.find((element) => element.className === 'image-remote');
    expect(image.src).toBe('');
    expect(remoteBox?.parentElement).toBe(nodeView.dom);

    const loadButton = remoteBox?.children.find((element) => element.tagName === 'button');
    expect(loadButton).toBeDefined();
    loadButton!.emit('click');
    expect(image.src).toBe('https://images.example/remote.png');
    expect(remoteBox?.parentElement).toBeNull();
    nodeView.destroy?.();
  });

  test('stops ProseMirror events only for image controls', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:local-image');
    const elements = stubDocument();
    vi.stubGlobal('Element', TestElement);
    const nodeView = renderImageNodeView(makeImageNode('local-file'));
    await flushPromises();

    const toolbar = elements.find((element) => element.className === 'image-toolbar');
    const toolbarButton = toolbar?.children[0];
    const cropHandle = elements.find((element) => element.className.includes('handle-tl'));
    const captionInput = elements.find((element) => element.className === 'image-caption-input');
    const image = findElement(nodeView.dom as unknown as TestElement, 'img');
    expect(toolbarButton).toBeDefined();
    expect(cropHandle).toBeDefined();
    expect(captionInput).toBeDefined();

    expect(nodeView.stopEvent({ target: toolbarButton } as unknown as Event)).toBe(true);
    expect(nodeView.stopEvent({ target: cropHandle } as unknown as Event)).toBe(true);
    expect(nodeView.stopEvent({ target: captionInput } as unknown as Event)).toBe(true);
    expect(nodeView.stopEvent({ target: image } as unknown as Event)).toBe(false);
    expect(nodeView.stopEvent({ target: nodeView.dom } as unknown as Event)).toBe(false);

    nodeView.destroy?.();
  });

  test('replacing an image dispatches current attrs and updates the live img source', async () => {
    const oldNode = makeImageNode('old-file', { align: 'right', caption: 'Keep this caption', width: 48 });
    const mock = createMockView(oldNode);
    vi.mocked(fileUrl).mockImplementation((fileId) =>
      Promise.resolve(String(fileId) === 'old-file' ? 'blob:old-image' : 'blob:new-image'),
    );
    vi.mocked(storeFiles).mockResolvedValue([{ id: 'new-file' } as FileMeta]);
    const elements = stubDocument();
    vi.stubGlobal('window', {
      Image: class {
        naturalWidth = 200;
        naturalHeight = 400;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          this.onload?.();
        }
      },
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const nodeView = renderImageNodeView(oldNode, mock.view);
    mock.setNodeView(nodeView);
    await flushPromises();

    const toolbar = elements.find((element) => element.className === 'image-toolbar');
    const replaceButton = toolbar?.children[0];
    expect(replaceButton).toBeDefined();
    replaceButton!.emit('click');
    const input = elements.filter((element) => element.tagName === 'input').at(-1);
    expect(input).toBeDefined();
    input!.files = [{ type: 'image/png', size: 128 } as File];
    input!.emit('change');
    await flushPromises();

    expect(storeFiles).toHaveBeenCalledTimes(1);
    expect(mock.readNode().attrs).toMatchObject({
      fileId: 'new-file',
      src: null,
      align: 'right',
      caption: 'Keep this caption',
      crop: null,
      width: 48,
    });
    expect(fileUrl).toHaveBeenCalledWith('new-file');
    expect(findElement(nodeView.dom as unknown as TestElement, 'img').src).toBe('blob:new-image');

    const updatedToolbar = elements.find((element) => element.className === 'image-toolbar');
    updatedToolbar?.children[0]?.emit('click');
    const canceledInput = elements.filter((element) => element.tagName === 'input').at(-1);
    expect(canceledInput).toBeDefined();
    canceledInput!.emit('cancel');
    canceledInput!.files = [{ type: 'image/png', size: 128 } as File];
    canceledInput!.emit('change');
    await flushPromises();
    expect(storeFiles).toHaveBeenCalledTimes(1);
    expect(mock.readNode().attrs.fileId).toBe('new-file');

    nodeView.destroy?.();
  });
});

describe('Image NodeView sizing', () => {
  test('previews a continuous drag and commits one width update while preserving image metadata', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const windowStub = stubWindow();
    const originalCrop = { x: 0.1, y: 0.2, width: 0.6, height: 0.7 };
    const mock = createMockView(
      makeImageNode('photo', {
        align: 'left',
        caption: 'Synthetic caption',
        crop: originalCrop,
        width: 50,
        markerMetadata: {
          raw: `<!-- morrow:image align="left" width="50%" custom="opaque" -->`,
          baseline: { align: 'left', caption: 'Synthetic caption', crop: originalCrop, width: 50 },
        },
      }),
    );
    const nodeView = renderImageNodeView(mock.readNode(), mock.view);
    mock.setNodeView(nodeView);
    const parent = new TestElement('column-content');
    parent.rect.width = 400;
    parent.appendChild(nodeView.dom as unknown as TestElement);
    const cropWrapper = findByClass(nodeView.dom as unknown as TestElement, 'image-crop-wrapper');
    cropWrapper.rect.width = 200;
    await flushPromises();

    const resizeHandle = elements.find((element) => element.className === 'image-resize-handle');
    expect(resizeHandle).toBeDefined();
    resizeHandle!.emitEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
    windowStub.emit('pointermove', { clientX: 140, pointerId: 1 });

    expect((nodeView.dom as unknown as TestElement).style.width).toBe('60%');
    expect(mock.readNode().attrs.width).toBe(50);
    expect(mock.dispatchCount).toBe(0);

    windowStub.emit('pointerup', { clientX: 140, pointerId: 1 });
    expect(mock.readNode().attrs).toMatchObject({
      width: 60,
      align: 'left',
      caption: 'Synthetic caption',
      crop: originalCrop,
      markerMetadata: {
        raw: `<!-- morrow:image align="left" width="50%" custom="opaque" -->`,
        baseline: { align: 'left', caption: 'Synthetic caption', crop: originalCrop, width: 50 },
      },
    });
    expect(mock.dispatchCount).toBe(1);
    expect(storeFiles).not.toHaveBeenCalled();
    expect((nodeView.dom as unknown as TestElement).style.marginInlineStart).toBe('0');
    expect((nodeView.dom as unknown as TestElement).style.marginInlineEnd).toBe('auto');
    nodeView.destroy?.();
  });

  test('restores the stored width when a drag is canceled', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const windowStub = stubWindow();
    const mock = createMockView(makeImageNode('photo', { align: 'left', width: 40 }));
    const nodeView = renderImageNodeView(mock.readNode(), mock.view);
    mock.setNodeView(nodeView);
    const parent = new TestElement('column-content');
    parent.rect.width = 400;
    parent.appendChild(nodeView.dom as unknown as TestElement);
    findByClass(nodeView.dom as unknown as TestElement, 'image-crop-wrapper').rect.width = 160;
    await flushPromises();

    const resizeHandle = elements.find((element) => element.className === 'image-resize-handle');
    resizeHandle!.emitEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
    windowStub.emit('pointermove', { clientX: 180, pointerId: 1 });
    expect((nodeView.dom as unknown as TestElement).style.width).toBe('60%');

    windowStub.emit('pointercancel', { pointerId: 1 });
    expect((nodeView.dom as unknown as TestElement).style.width).toBe('40%');
    expect(mock.readNode().attrs.width).toBe(40);
    expect(mock.dispatchCount).toBe(0);
    nodeView.destroy?.();
  });

  test('does not commit a resize if the editor becomes read-only before pointerup', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const windowStub = stubWindow();
    const mock = createMockView(makeImageNode('photo', { align: 'left', width: 40 }));
    const nodeView = renderImageNodeView(mock.readNode(), mock.view);
    mock.setNodeView(nodeView);
    const parent = new TestElement('column-content');
    parent.rect.width = 400;
    parent.appendChild(nodeView.dom as unknown as TestElement);
    findByClass(nodeView.dom as unknown as TestElement, 'image-crop-wrapper').rect.width = 160;
    await flushPromises();

    const resizeHandle = elements.find((element) => element.className === 'image-resize-handle');
    resizeHandle!.emitEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
    windowStub.emit('pointermove', { clientX: 160, pointerId: 1 });
    mock.setEditable(false);
    windowStub.emit('pointerup', { clientX: 160, pointerId: 1 });

    expect(mock.readNode().attrs.width).toBe(40);
    expect(mock.dispatchCount).toBe(0);
    expect((nodeView.dom as unknown as TestElement).style.width).toBe('40%');
    nodeView.destroy?.();
  });

  test('cancels a held resize and refreshes controls when only editability changes', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const windowStub = stubWindow();
    const observers: Array<{ target: unknown; callback: () => void; disconnected: boolean }> = [];
    vi.stubGlobal('MutationObserver', class {
      target: unknown;
      disconnected = false;
      constructor(readonly callback: () => void) { observers.push(this); }
      observe(target: unknown) { this.target = target; }
      disconnect() { this.disconnected = true; }
    });
    const editorDom = new TestElement('div');
    const mock = createMockView(makeImageNode('photo', { align: 'left', width: 40 }));
    Object.assign(mock.view, { dom: editorDom });
    const nodeView = renderImageNodeView(mock.readNode(), mock.view);
    mock.setNodeView(nodeView);
    const parent = new TestElement('column-content');
    parent.rect.width = 400;
    parent.appendChild(nodeView.dom as unknown as TestElement);
    findByClass(nodeView.dom as unknown as TestElement, 'image-crop-wrapper').rect.width = 160;
    await flushPromises();

    const figure = nodeView.dom as unknown as TestElement;
    const handle = elements.find((element) => element.className === 'image-resize-handle')!;
    handle.emitEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
    windowStub.emit('pointermove', { clientX: 160, pointerId: 1 });
    expect(figure.style.width).toBe('55%');
    mock.setEditable(false);
    editorDom.setAttribute('contenteditable', 'false');
    observers.filter((observer) => observer.target === editorDom).forEach((observer) => observer.callback());

    expect(figure.style.width).toBe('40%');
    expect(handle.style.display).toBe('none');
    windowStub.emit('pointerup', { clientX: 160, pointerId: 1 });
    expect(mock.dispatchCount).toBe(0);
    expect(mock.readNode().attrs.width).toBe(40);

    mock.setEditable(true);
    editorDom.setAttribute('contenteditable', 'true');
    observers.filter((observer) => observer.target === editorDom).forEach((observer) => observer.callback());
    expect(handle.style.display).toBe('');
    expect(mock.dispatchCount).toBe(0);
    nodeView.destroy?.();
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    mock.setEditable(false);
    observers.forEach((observer) => observer.callback());
    expect(handle.style.display).toBe('');
    expect(mock.dispatchCount).toBe(0);
  });

  test('offers an accessible range control and commits its configuration as one update', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const mock = createMockView(makeImageNode('photo', { width: 40 }));
    const nodeView = renderImageNodeView(mock.readNode(), mock.view);
    mock.setNodeView(nodeView);
    await flushPromises();

    const resizeButton = elements.find(
      (element) => element.className.includes('image-tool-btn') && element.getAttribute('aria-label') === 'editor.imageResize',
    );
    const resizeInput = elements.find((element) => element.tagName === 'input' && element.type === 'range');
    expect(resizeButton?.getAttribute('aria-expanded')).toBe('false');
    expect(resizeInput?.getAttribute('aria-label')).toBe('editor.imageResize');
    expect(resizeInput?.min).toBe('1');
    expect(resizeInput?.max).toBe('100');

    resizeButton!.emit('click');
    resizeInput!.value = '65';
    resizeInput!.emit('input');
    expect((nodeView.dom as unknown as TestElement).style.width).toBe('65%');
    expect(mock.readNode().attrs.width).toBe(40);
    expect(mock.dispatchCount).toBe(0);

    resizeInput!.emit('change');
    expect(mock.readNode().attrs.width).toBe(65);
    expect(mock.dispatchCount).toBe(1);
    nodeView.destroy?.();
  });

  test('keeps widths independent for two images sharing a column container', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const windowStub = stubWindow();
    const first = createMockView(makeImageNode('first', { align: 'left', width: 35 }));
    const second = createMockView(makeImageNode('second', { align: 'left', width: 65 }));
    const firstView = renderImageNodeView(first.readNode(), first.view);
    const secondView = renderImageNodeView(second.readNode(), second.view);
    first.setNodeView(firstView);
    second.setNodeView(secondView);
    const parent = new TestElement('column-content');
    parent.rect.width = 400;
    parent.appendChild(firstView.dom as unknown as TestElement);
    parent.appendChild(secondView.dom as unknown as TestElement);
    findByClass(firstView.dom as unknown as TestElement, 'image-crop-wrapper').rect.width = 140;
    findByClass(secondView.dom as unknown as TestElement, 'image-crop-wrapper').rect.width = 260;
    await flushPromises();

    const firstHandle = elements.find((element) => element.className === 'image-resize-handle');
    firstHandle!.emitEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1 });
    windowStub.emit('pointermove', { clientX: 120, pointerId: 1 });
    windowStub.emit('pointerup', { clientX: 120, pointerId: 1 });

    expect(first.readNode().attrs.width).toBe(40);
    expect(second.readNode().attrs.width).toBe(65);
    expect(first.dispatchCount).toBe(1);
    expect(second.dispatchCount).toBe(0);
    firstView.destroy?.();
    secondView.destroy?.();
  });

  test.each(
    (['left', 'center', 'right'] as const).flatMap((align) =>
      ([1, 35] as const).map((width) => ({ align, width })),
    ),
  )('moves the toolbar stack away from the $align resize handle at $width%', async ({ align, width }) => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align, width }));
    const figure = nodeView.dom as unknown as TestElement;
    const parent = new TestElement('column-content');
    const parentBounds = { left: 40, top: 100, width: 440, height: 700 };
    Object.assign(parent.rect, parentBounds);
    parent.appendChild(figure);

    const imageWidth = (parentBounds.width * width) / 100;
    const imageHeight = imageWidth * 0.5625;
    const figureLeft =
      align === 'left'
        ? parentBounds.left
        : align === 'right'
          ? parentBounds.left + parentBounds.width - imageWidth
          : parentBounds.left + (parentBounds.width - imageWidth) / 2;
    Object.assign(figure.rect, { left: figureLeft, top: 180, width: imageWidth, height: imageHeight + 40 });

    const wrapper = findByClass(figure, 'image-crop-wrapper');
    Object.assign(wrapper.rect, { left: figureLeft, top: 188, width: imageWidth, height: imageHeight });
    const toolbar = findByClass(figure, 'image-toolbar');
    const toolbarWidth = 220;
    const toolbarLeft = Math.max(
      parentBounds.left,
      Math.min(figureLeft + imageWidth - 8 - toolbarWidth, parentBounds.left + parentBounds.width - toolbarWidth),
    );
    Object.assign(toolbar.rect, { left: toolbarLeft, top: 188, width: toolbarWidth, height: 80 });

    const handle = findByClass(figure, 'image-resize-handle');
    const requestedHandleLeft =
      align === 'right' ? figureLeft - 24 : imageWidth < 24 ? figureLeft : figureLeft + imageWidth - 24;
    Object.assign(handle.rect, {
      left: Math.max(parentBounds.left, Math.min(requestedHandleLeft, parentBounds.left + parentBounds.width - 24)),
      top: 188 + (imageHeight < 24 ? imageHeight : imageHeight - 24),
      width: 24,
      height: 24,
    });
    const panel = findByClass(figure, 'image-resize-panel');
    Object.assign(panel.rect, {
      left: toolbarLeft,
      top: figure.rect.top + figure.rect.height + 4,
      width: 180,
      height: 40,
    });

    figure.emit('mouseenter');
    const toolbarTop = figure.rect.top + Number.parseFloat(toolbar.style.top ?? '8');
    expect(toolbar.getAttribute('data-resize-gap')).toBe('after');
    expect(toolbarTop).toBeGreaterThanOrEqual(0);
    expect(toolbarTop + toolbar.rect.height).toBeLessThanOrEqual(720);
    expect(toolbarTop + toolbar.rect.height).toBeLessThanOrEqual(handle.rect.top - 4);
    expect(handle.style.display).not.toBe('none');

    const resizeButton = toolbar.children.find(
      (child) => child.getAttribute('aria-label') === 'editor.imageResize',
    );
    resizeButton?.emit('click');
    expect(panel.style.display).toBe('');
    expect(toolbar.getAttribute('data-resize-gap')).toBeNull();
    const panelBounds = panel.getBoundingClientRect();
    const handleBounds = handle.getBoundingClientRect();
    const panelOverlapsHandle = panelBounds.left < handleBounds.right &&
      panelBounds.right > handleBounds.left &&
      panelBounds.top < handleBounds.bottom &&
      panelBounds.bottom > handleBounds.top;
    expect(panelOverlapsHandle).toBe(false);
    nodeView.destroy?.();
  });

  test.each(
    (['left', 'center', 'right'] as const).map((align) => ({ align })),
  )(
    'reclamps a reopened resize panel in its real offset parent for a $align image after the pane narrows',
    async ({ align }) => {
      vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
      stubDocument();
      const windowStub = stubWindow();
      windowStub.innerWidth = 520;
      windowStub.innerHeight = 720;
      const nodeView = renderImageNodeView(makeImageNode('photo', { align, width: 1 }));
      const figure = nodeView.dom as unknown as TestElement;
      const parent = new TestElement('column-content');
      const paneLeft = 28;
      let paneWidth = 454;
      Object.assign(parent.rect, { left: paneLeft, top: 0, width: paneWidth, height: 900 });
      parent.appendChild(figure);

      const imageWidth = () => paneWidth * 0.01;
      const figureLeft = () => align === 'left'
        ? paneLeft
        : align === 'center'
          ? paneLeft + (paneWidth - imageWidth()) / 2
          : paneLeft + paneWidth - imageWidth();
      const setImageGeometry = () => {
        const left = figureLeft();
        Object.assign(figure.rect, { left, top: 481.375, width: imageWidth(), height: 48 });
        const wrapper = findByClass(figure, 'image-crop-wrapper');
        Object.assign(wrapper.rect, { left, top: 481.375, width: imageWidth(), height: imageWidth() * 0.5625 });
      };
      setImageGeometry();

      const toolbar = findByClass(figure, 'image-toolbar');
      Object.assign(toolbar.rect, { left: 56, top: 489.375, width: 224, height: 36 });
      toolbar.clientLeft = 1;
      toolbar.clientTop = 1;
      toolbar.scrollLeft = 7;
      toolbar.scrollTop = 3;
      const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
        left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
      } as DOMRect);
      toolbar.getBoundingClientRect = () => {
        const leftValue = Number.parseFloat(toolbar.style.left ?? '');
        const topValue = Number.parseFloat(toolbar.style.top ?? '');
        const left = Number.isFinite(leftValue)
          ? figure.rect.left + figure.clientLeft + leftValue - figure.scrollLeft
          : toolbar.rect.left;
        const top = Number.isFinite(topValue)
          ? figure.rect.top + figure.clientTop + topValue - figure.scrollTop
          : toolbar.rect.top;
        return rect(left, top, toolbar.rect.width, toolbar.rect.height);
      };

      const handle = findByClass(figure, 'image-resize-handle');
      Object.assign(handle.rect, { left: 400, top: 100, width: 24, height: 24 });
      const resizePanel = findByClass(figure, 'image-resize-panel');
      Object.assign(resizePanel.rect, { left: 389, top: 700, width: 122, height: 67 });
      // These are stale local coordinates left by an earlier open before toolbar relayout.
      resizePanel.style.left = '332px';
      resizePanel.style.top = '210px';
      resizePanel.getBoundingClientRect = () => {
        const toolbarRect = toolbar.getBoundingClientRect();
        const leftValue = Number.parseFloat(resizePanel.style.left ?? '');
        const topValue = Number.parseFloat(resizePanel.style.top ?? '');
        const left = Number.isFinite(leftValue)
          ? toolbarRect.left + toolbar.clientLeft + leftValue - toolbar.scrollLeft
          : toolbarRect.left + toolbar.rect.width - resizePanel.rect.width - toolbar.clientRight - toolbar.scrollLeft;
        const top = Number.isFinite(topValue)
          ? toolbarRect.top + toolbar.clientTop + topValue - toolbar.scrollTop
          : toolbarRect.top + toolbar.rect.height + 4 - toolbar.scrollTop;
        return rect(left, top, resizePanel.rect.width, resizePanel.rect.height);
      };

      figure.emit('mouseenter');
      const resizeButton = toolbar.children.find((child) => child.getAttribute('aria-label') === 'editor.imageResize');
      resizeButton?.emit('click');
      expect(resizePanel.style.display).toBe('');
      resizeButton?.emit('click');
      expect(resizePanel.style.display).toBe('none');

      paneWidth = 300;
      Object.assign(parent.rect, { width: paneWidth });
      setImageGeometry();
      windowStub.emit('resize');
      resizeButton?.emit('click');
      expect(resizePanel.style.display).toBe('');

      const panelBounds = resizePanel.getBoundingClientRect();
      const expectedLeft = paneLeft + paneWidth - panelBounds.width;
      expect(panelBounds.left).toBeCloseTo(expectedLeft);
      expect(panelBounds.left).toBeGreaterThanOrEqual(paneLeft);
      expect(panelBounds.right).toBeLessThanOrEqual(paneLeft + paneWidth);
      expect(panelBounds.top).toBeGreaterThanOrEqual(0);
      expect(panelBounds.bottom).toBeLessThanOrEqual(windowStub.innerHeight);
      nodeView.destroy?.();
    },
  );
  test('moves a reachable hover corridor on scroll and resize without retaining a disconnected bridge', () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const parent = new TestElement('column-content');
    parent.rect = { left: 40, top: 0, width: 440, height: 700 };
    parent.appendChild(figure);
    const imageWidth = 4.4;
    const imageHeight = imageWidth * 0.5625;
    const wrapper = findByClass(figure, 'image-crop-wrapper');
    const image = findElement(figure, 'img');
    const toolbar = findByClass(figure, 'image-toolbar');
    const handle = findByClass(figure, 'image-resize-handle');
    toolbar.rect = { left: 40, top: 8, width: 220, height: 80 };
    toolbar.getBoundingClientRect = () => {
      const cssLeft = Number.parseFloat(toolbar.style.left ?? '');
      const cssTop = Number.parseFloat(toolbar.style.top ?? '');
      const left = Number.isFinite(cssLeft) ? figure.rect.left + cssLeft : toolbar.rect.left;
      const top = Number.isFinite(cssTop) ? figure.rect.top + cssTop : toolbar.rect.top;
      return { left, top, right: left + 220, bottom: top + 80, width: 220, height: 80 } as DOMRect;
    };
    const setGeometry = (top: number) => {
      figure.rect = { left: 40, top, width: imageWidth, height: imageHeight + 40 };
      wrapper.rect = image.rect = { left: 40, top: top + 8, width: imageWidth, height: imageHeight };
      handle.rect = { left: 40, top: top + 8 + imageHeight, width: 24, height: 24 };
    };
    const assertReachable = () => {
      const bounds = toolbar.getBoundingClientRect();
      const corridor = findDirectHoverCorridor(
        { left: 40, top: image.rect.top, right: 40 + imageWidth, bottom: image.rect.top + imageHeight },
        bounds,
        { left: 0, top: 0, right: windowStub.innerWidth, bottom: windowStub.innerHeight },
        [{ left: handle.rect.left, top: handle.rect.top, right: handle.rect.left + 24, bottom: handle.rect.top + 24 }],
      );
      expect(corridor).not.toBeNull();
      expect(findByClass(figure, 'image-toolbar-hover-corridor').style.pointerEvents).toBe('auto');
      expect(toolbar.getAttribute('data-resize-gap')).toBeNull();
      expect(toolbar.style['--image-toolbar-bridge-left']).toBeUndefined();
    };
    setGeometry(0);
    figure.emit('mouseenter');
    assertReachable();
    setGeometry(180);
    windowStub.emit('scroll');
    assertReachable();
    setGeometry(0);
    windowStub.emit('resize');
    assertReachable();
    nodeView.destroy?.();
  });
  test('restores a reachable image-to-toolbar path after resize-panel relayout and focus leaves a tiny image', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const parent = new TestElement('column-content');
    Object.assign(parent.rect, { left: 28, top: 0, width: 464, height: 900 });
    parent.appendChild(figure);
    Object.assign(figure.rect, { left: 28, top: 180, width: 4.53125, height: 48 });

    const wrapper = findByClass(figure, 'image-crop-wrapper');
    Object.assign(wrapper.rect, { left: 28, top: 188, width: 4.53125, height: 2.546875 });
    const image = findElement(figure, 'img');
    Object.assign(image.rect, wrapper.rect);
    const toolbar = findByClass(figure, 'image-toolbar');
    Object.assign(toolbar.rect, { left: 56, top: 188, width: 224, height: 36 });
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
    } as DOMRect);
    const positionedRect = (element: TestElement, fallback: TestElement['rect']) => {
      const leftOffset = Number.parseFloat(element.style.left ?? '');
      const topOffset = Number.parseFloat(element.style.top ?? '');
      const left = Number.isFinite(leftOffset)
        ? figure.rect.left + figure.clientLeft + leftOffset - figure.scrollLeft
        : fallback.left;
      const top = Number.isFinite(topOffset)
        ? figure.rect.top + figure.clientTop + topOffset - figure.scrollTop
        : fallback.top;
      return rect(left, top, fallback.width, fallback.height);
    };
    toolbar.getBoundingClientRect = () => positionedRect(toolbar, toolbar.rect);

    const handle = findByClass(figure, 'image-resize-handle');
    Object.assign(handle.rect, { left: 28, top: 190.546875, width: 24, height: 24 });
    handle.getBoundingClientRect = () => positionedRect(handle, handle.rect);
    const panel = findByClass(figure, 'image-resize-panel');
    Object.assign(panel.rect, { left: 300, top: 620, width: 180, height: 48 });

    const addNeighbor = (top: number, width: number, height: number) => {
      const neighbor = new TestElement('figure');
      neighbor.className = 'image-block';
      const neighborWrapper = new TestElement('div');
      neighborWrapper.className = 'image-crop-wrapper';
      Object.assign(neighborWrapper.rect, { left: 28, top, width, height });
      neighbor.appendChild(neighborWrapper);
      parent.appendChild(neighbor);
      return neighborWrapper;
    };
    const previousImage = addNeighbor(300, 190, 100);
    const nextImage = addNeighbor(540, 160, 90);

    let activeElement: TestElement | null = null;
    const resizeButton = toolbar.children.find((child) => child.getAttribute('aria-label') === 'editor.imageResize');
    const resizeInput = panel.children.find((child) => child.tagName === 'input');
    const heading = new TestElement('h2');
    parent.appendChild(heading);
    resizeButton!.focus = () => { activeElement = resizeButton!; };
    resizeInput!.focus = () => { activeElement = resizeInput!; };
    heading.focus = () => { activeElement = heading; };

    figure.emit('mouseenter');
    resizeButton!.focus();
    resizeButton!.emit('click');
    expect(panel.style.display).toBe('');
    expect(activeElement).toBe(resizeInput);
    resizeButton!.focus();
    resizeButton!.emit('click');
    expect(panel.style.display).toBe('none');

    resizeButton!.focus();
    resizeButton!.emit('click');
    expect(panel.style.display).toBe('');
    Object.assign(figure.rect, { top: 481.375 });
    Object.assign(wrapper.rect, { top: 481.375 });
    Object.assign(image.rect, { top: 481.375 });
    windowStub.emit('resize');
    resizeButton!.focus();
    resizeButton!.emit('click');
    expect(panel.style.display).toBe('none');

    // Moving focus to page content removes :focus-within before the pointer returns to the image.
    heading.focus();
    heading.emit('click');
    expect(activeElement).toBe(heading);
    figure.emit('mouseleave');
    figure.emit('mouseenter');

    const toolbarBounds = toolbar.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    const handleBounds = handle.getBoundingClientRect();
    const resizeGap = toolbar.getAttribute('data-resize-gap');
    const px = (side: string) => Number.parseFloat(toolbar.style[`--image-toolbar-bridge-${side}`] ?? '0') || 0;
    const bridgeBounds = resizeGap === 'before'
      ? rect(toolbarBounds.left + 1 + px('left'), toolbarBounds.top - 3, toolbarBounds.right - 1 - px('right') - toolbarBounds.left - 1 - px('left'), 4)
      : resizeGap === 'after'
        ? rect(toolbarBounds.left + 1 + px('left'), toolbarBounds.bottom - 1, toolbarBounds.right - 1 - px('right') - toolbarBounds.left - 1 - px('left'), 4)
        : resizeGap === 'left'
          ? rect(toolbarBounds.left - 3, toolbarBounds.top + 1 + px('top'), 4, toolbarBounds.bottom - 1 - px('bottom') - toolbarBounds.top - 1 - px('top'))
          : resizeGap === 'right'
            ? rect(toolbarBounds.right - 1, toolbarBounds.top + 1 + px('top'), 4, toolbarBounds.bottom - 1 - px('bottom') - toolbarBounds.top - 1 - px('top'))
            : rect(0, 0, 0, 0);
    const overlaps = (left: DOMRect, right: DOMRect) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const contains = (item: DOMRect, point: { x: number; y: number }) =>
      point.x >= item.left && point.x < item.right && point.y >= item.top && point.y < item.bottom;
    const pointerStart = { x: imageBounds.left + imageBounds.width / 2, y: imageBounds.top + imageBounds.height / 2 };
    const bridgeEntry = { x: bridgeBounds.left + 0.1, y: pointerStart.y };
    const pointerTarget = { x: bridgeEntry.x, y: toolbarBounds.bottom - 0.1 };

    expect(['before', 'after', 'left', 'right']).toContain(resizeGap);
    expect(imageBounds.height).toBeCloseTo(2.546875);
    expect(overlaps(toolbarBounds, imageBounds)).toBe(false);
    expect(overlaps(bridgeBounds, imageBounds)).toBe(false);
    expect(overlaps(bridgeBounds, handleBounds)).toBe(false);
    expect(overlaps(toolbarBounds, handleBounds)).toBe(false);
    expect(overlaps(toolbarBounds, previousImage.getBoundingClientRect())).toBe(false);
    expect(overlaps(toolbarBounds, nextImage.getBoundingClientRect())).toBe(false);
    expect(bridgeBounds.width > 0 && bridgeBounds.height > 0).toBe(true);

    expect(contains(bridgeBounds, bridgeEntry)).toBe(true);
    expect(contains(toolbarBounds, pointerTarget)).toBe(true);
    const route = [
      { from: pointerStart, to: bridgeEntry },
      { from: bridgeEntry, to: pointerTarget },
    ];
    for (const { from, to } of route) {
      for (let step = 0; step <= 32; step += 1) {
        const point = {
          x: from.x + ((to.x - from.x) * step) / 32,
          y: from.y + ((to.y - from.y) * step) / 32,
        };
        expect(contains(handleBounds, point)).toBe(false);
        expect(
          contains(imageBounds, point) || contains(bridgeBounds, point) || contains(toolbarBounds, point),
        ).toBe(true);
      }
    }
    nodeView.destroy?.();
  });

  test('keeps a four-pixel resize bridge off a 2.5px image and reachable from its painted edge', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const parent = new TestElement('column-content');
    Object.assign(parent.rect, { left: 28, top: 0, width: 464, height: 900 });
    parent.appendChild(figure);
    Object.assign(figure.rect, { left: 28, top: 481.375, width: 4.53125, height: 48 });

    const wrapper = findByClass(figure, 'image-crop-wrapper');
    Object.assign(wrapper.rect, { left: 28, top: 481.375, width: 4.53125, height: 2.546875 });
    const image = findElement(figure, 'img');
    Object.assign(image.rect, wrapper.rect);
    const toolbar = findByClass(figure, 'image-toolbar');
    Object.assign(toolbar.rect, { left: 28, top: 489.375, width: 224, height: 36 });
    const handle = findByClass(figure, 'image-resize-handle');
    Object.assign(handle.rect, { left: 28, top: 483.921875, width: 24, height: 24 });

    figure.emit('mouseenter');

    const toolbarRect = {
      left: figure.rect.left + Number.parseFloat(toolbar.style.left ?? '0'),
      top: figure.rect.top + Number.parseFloat(toolbar.style.top ?? '8'),
      right: figure.rect.left + Number.parseFloat(toolbar.style.left ?? '0') + toolbar.rect.width,
      bottom: figure.rect.top + Number.parseFloat(toolbar.style.top ?? '8') + toolbar.rect.height,
    };
    const resizeGap = toolbar.getAttribute('data-resize-gap');
    const bridgeInsetLeft = Number.parseFloat(toolbar.style['--image-toolbar-bridge-left'] ?? '0');
    const bridgeInsetRight = Number.parseFloat(toolbar.style['--image-toolbar-bridge-right'] ?? '0');
    const bridgeRect = resizeGap === 'after'
      ? {
          left: toolbarRect.left + 1 + bridgeInsetLeft,
          top: toolbarRect.bottom - 1,
          right: toolbarRect.right - 1 - bridgeInsetRight,
          bottom: toolbarRect.bottom - 1 + 4,
        }
      : { left: 0, top: 0, right: 0, bottom: 0 };
    const imageRect = image.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const overlaps = (left: { left: number; top: number; right: number; bottom: number }, right: { left: number; top: number; right: number; bottom: number }) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const contains = (rect: { left: number; top: number; right: number; bottom: number }, point: { x: number; y: number }) =>
      point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
    const imageStart = { x: imageRect.left + imageRect.width / 2, y: imageRect.top + imageRect.height / 2 };
    const bridgeEntry = { x: bridgeRect.left + 1, y: imageStart.y };

    expect(toolbar.getAttribute('data-resize-gap')).toBe('after');
    expect(imageRect.height).toBeCloseTo(2.546875);
    expect(contains(imageRect, imageStart)).toBe(true);
    expect(overlaps(toolbarRect, imageRect)).toBe(false);
    expect(overlaps(bridgeRect, imageRect)).toBe(false);
    expect(overlaps(bridgeRect, handleRect)).toBe(false);
    expect(contains(bridgeRect, bridgeEntry)).toBe(true);
    expect(bridgeRect.left).toBeCloseTo(imageRect.right);

    // The diagonal pointer path leaves the image at its painted edge, reaches the
    // clipped bridge without crossing the handle, and enters the toolbar directly.
    const pointerTarget = { x: toolbarRect.right - 18, y: toolbarRect.top + 18 };
    for (let step = 0; step <= 24; step += 1) {
      const point = {
        x: imageStart.x + ((pointerTarget.x - imageStart.x) * step) / 24,
        y: imageStart.y + ((pointerTarget.y - imageStart.y) * step) / 24,
      };
      expect(contains(handleRect, point)).toBe(false);
      expect(contains(imageRect, point) || contains(bridgeRect, point) || contains(toolbarRect, point)).toBe(true);
    }
    const bridgeToolbarEdge = { x: bridgeEntry.x, y: toolbarRect.bottom + 0.1 };
    const toolbarEntry = { x: bridgeEntry.x, y: toolbarRect.bottom - 0.1 };
    expect(contains(bridgeRect, bridgeToolbarEdge)).toBe(true);
    expect(contains(toolbarRect, toolbarEntry)).toBe(true);
    expect(bridgeToolbarEdge.y - toolbarEntry.y).toBeCloseTo(0.2);
    expect(windowStub.innerWidth).toBeGreaterThan(toolbarRect.right);
    nodeView.destroy?.();
  });

  test('keeps a narrow image toolbar outside neighboring painted images and its resize handle', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const windowStub = stubWindow();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align: 'left', width: 1 }));
    const figure = nodeView.dom as unknown as TestElement;
    const parent = new TestElement('column-content');
    Object.assign(parent.rect, { left: 28, top: 0, width: 464, height: 900 });
    parent.appendChild(figure);
    Object.assign(figure.rect, { left: 28, top: 471, width: 4.5, height: 48 });

    const wrapper = findByClass(figure, 'image-crop-wrapper');
    Object.assign(wrapper.rect, { left: 28, top: 471, width: 4.5, height: 4.5 });
    const toolbar = findByClass(figure, 'image-toolbar');
    Object.assign(toolbar.rect, { left: 28, top: 479, width: 220, height: 36 });
    const handle = findByClass(figure, 'image-resize-handle');
    Object.assign(handle.rect, { left: 28, top: 474, width: 24, height: 24 });
    const panel = findByClass(figure, 'image-resize-panel');
    Object.assign(panel.rect, {
      left: figure.rect.left + figure.rect.width - 180,
      top: figure.rect.top + figure.rect.height + 4,
      width: 180,
      height: 40,
    });
    panel.getBoundingClientRect = () => {
      const left = figure.rect.left + Number.parseFloat(panel.style.left ?? `${figure.rect.width - panel.rect.width}`);
      const top = figure.rect.top + Number.parseFloat(panel.style.top ?? `${figure.rect.height + 4}`);
      return {
        left,
        top,
        right: left + panel.rect.width,
        bottom: top + panel.rect.height,
        width: panel.rect.width,
        height: panel.rect.height,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };

    const addNeighbor = (top: number, width: number, height: number) => {
      const neighbor = new TestElement('figure');
      neighbor.className = 'image-block';
      const neighborWrapper = new TestElement('div');
      neighborWrapper.className = 'image-crop-wrapper';
      Object.assign(neighborWrapper.rect, { left: 28, top, width, height });
      neighbor.appendChild(neighborWrapper);
      parent.appendChild(neighbor);
      return neighborWrapper;
    };
    const previousImage = addNeighbor(322.7, 190.7, 107.25);
    const nextImage = addNeighbor(533.7, 158.9, 89.4);

    figure.emit('mouseenter');

    const toolbarRect = {
      left: figure.rect.left + Number.parseFloat(toolbar.style.left ?? '0'),
      top: figure.rect.top + Number.parseFloat(toolbar.style.top ?? '8'),
      right: figure.rect.left + Number.parseFloat(toolbar.style.left ?? '0') + toolbar.rect.width,
      bottom: figure.rect.top + Number.parseFloat(toolbar.style.top ?? '8') + toolbar.rect.height,
    };
    const overlaps = (rect: { left: number; top: number; right: number; bottom: number }) =>
      toolbarRect.left < rect.right && toolbarRect.right > rect.left &&
      toolbarRect.top < rect.bottom && toolbarRect.bottom > rect.top;
    const toolbarBridge = {
      left: toolbarRect.left,
      top: toolbarRect.bottom,
      right: toolbarRect.right,
      bottom: toolbarRect.bottom + 4,
    };
    const handleBounds = {
      left: handle.rect.left,
      top: handle.rect.top,
      right: handle.rect.left + handle.rect.width,
      bottom: handle.rect.top + handle.rect.height,
    };

    expect(toolbar.style.width).toBe('max-content');
    expect(toolbar.getAttribute('data-resize-gap')).toBe('after');
    expect(handleBounds.top - toolbarRect.bottom).toBeGreaterThanOrEqual(3.9);
    expect(handleBounds.top - toolbarRect.bottom).toBeLessThanOrEqual(4.1);
    expect(toolbarRect.left).toBeGreaterThanOrEqual(12);
    expect(toolbarRect.right).toBeLessThanOrEqual(windowStub.innerWidth - 12);
    expect(toolbarRect.left).toBeGreaterThanOrEqual(parent.rect.left);
    expect(toolbarRect.right).toBeLessThanOrEqual(parent.rect.left + parent.rect.width);
    expect(toolbarRect.top).toBeGreaterThanOrEqual(0);
    expect(toolbarRect.bottom).toBeLessThanOrEqual(windowStub.innerHeight);
    expect(overlaps(handleBounds)).toBe(false);
    expect(overlaps(previousImage.getBoundingClientRect())).toBe(false);
    expect(overlaps(nextImage.getBoundingClientRect())).toBe(false);
    expect(toolbarBridge.bottom).toBeLessThanOrEqual(handleBounds.top);
    expect(overlaps(toolbarBridge)).toBe(false);
    expect(
      toolbarBridge.left < previousImage.getBoundingClientRect().right &&
      toolbarBridge.right > previousImage.getBoundingClientRect().left &&
      toolbarBridge.top < previousImage.getBoundingClientRect().bottom &&
      toolbarBridge.bottom > previousImage.getBoundingClientRect().top,
    ).toBe(false);
    expect(
      toolbarBridge.left < nextImage.getBoundingClientRect().right &&
      toolbarBridge.right > nextImage.getBoundingClientRect().left &&
      toolbarBridge.top < nextImage.getBoundingClientRect().bottom &&
      toolbarBridge.bottom > nextImage.getBoundingClientRect().top,
    ).toBe(false);

    const resizeButton = toolbar.children.find(
      (child) => child.getAttribute('aria-label') === 'editor.imageResize',
    );
    resizeButton?.emit('click');
    expect(panel.style.display).toBe('');
    const panelBounds = panel.getBoundingClientRect();
    const panelOverlaps = (rect: { left: number; top: number; right: number; bottom: number }) =>
      panelBounds.left < rect.right && panelBounds.right > rect.left &&
      panelBounds.top < rect.bottom && panelBounds.bottom > rect.top;
    expect(panelOverlaps(wrapper.getBoundingClientRect())).toBe(false);
    expect(panelOverlaps(handleBounds)).toBe(false);
    expect(panelOverlaps(toolbarRect)).toBe(false);
    expect(panelOverlaps(previousImage.getBoundingClientRect())).toBe(false);
    expect(panelOverlaps(nextImage.getBoundingClientRect())).toBe(false);
    expect(panelBounds.left).toBeGreaterThanOrEqual(28);
    expect(panelBounds.right).toBeLessThanOrEqual(492);
    expect(panelBounds.top).toBeGreaterThanOrEqual(0);
    expect(panelBounds.bottom).toBeLessThanOrEqual(windowStub.innerHeight);
    nodeView.destroy?.();
  });

  test('hides image sizing controls in a read-only editor', async () => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    const elements = stubDocument();
    const nodeView = renderImageNodeView(makeImageNode('photo', { width: 40 }), {
      editable: false,
    } as EditorView);
    await flushPromises();

    expect(findByClass(nodeView.dom as unknown as TestElement, 'image-resize-handle').style.display).toBe('none');
    expect(findByClass(nodeView.dom as unknown as TestElement, 'image-toolbar').getAttribute('data-resize-gap')).toBeNull();
    expect(
      elements.some(
        (element) =>
          element.className.includes('image-tool-btn') &&
          element.getAttribute('aria-label') === 'editor.imageResize',
      ),
    ).toBe(false);
    nodeView.destroy?.();
  });

  test.each([
    { align: 'left', start: '0', end: 'auto' },
    { align: 'center', start: 'auto', end: 'auto' },
    { align: 'right', start: 'auto', end: '0' },
  ])('anchors a resized image to the $align alignment', async ({ align, start, end }) => {
    vi.mocked(fileUrl).mockResolvedValue('blob:synthetic-image');
    stubDocument();
    const nodeView = renderImageNodeView(makeImageNode('photo', { align, width: 36 }));
    const dom = nodeView.dom as unknown as TestElement;
    expect(dom.classList.contains(`align-${align}`)).toBe(true);
    expect(dom.style.marginInlineStart).toBe(start);
    expect(dom.style.marginInlineEnd).toBe(end);
    nodeView.destroy?.();
  });
});
