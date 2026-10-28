import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { FileMeta } from '../../core/model';
import { Image as ImageExtension } from './Media';

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
  parentElement: TestElement | null = null;
  className = '';
  textContent = '';
  innerHTML = '';
  src = '';
  currentSrc = '';
  files: File[] | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  type = '';
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
  }

  appendChild(child: TestElement): TestElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
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
    this.listeners.get(type)?.forEach((listener) =>
      listener({ preventDefault() {}, stopPropagation() {} }),
    );
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
    src?: string | null;
  } = {},
): ProseMirrorNode {
  return imageSchema.nodes.image.create({
    fileId,
    src: attrs.src ?? null,
    alt: 'synthetic image',
    align: attrs.align ?? 'center',
    caption: attrs.caption ?? '',
    crop: attrs.crop ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
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

function createMockView(initialNode: ProseMirrorNode) {
  let state = EditorState.create({ schema: imageSchema, doc: imageSchema.nodes.doc.create(null, [initialNode]) });
  const holder: { nodeView: TestNodeView | null } = { nodeView: null };
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
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
    readNode() {
      return state.doc.firstChild!;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
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
    const oldNode = makeImageNode('old-file', { align: 'right', caption: 'Keep this caption' });
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
