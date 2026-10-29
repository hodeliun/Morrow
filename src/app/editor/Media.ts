import { Extension, mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { FileMeta, ImageAlign, ImageCrop } from '../../core/model';
import {
  formatImageCrop,
  parseImageCrop,
  validImageAlign,
  validImageCrop,
} from '../../core/model';
import { downloadFile, fileUrl, formatBytes, storeFiles } from '../platform/attachments';
import { t } from '../i18n';
import { toast } from '../ui';

export function shouldResetCropOnImageReplace(
  oldRatio: number | null | undefined,
  newRatio: number | null | undefined,
): boolean {
  if (oldRatio == null || newRatio == null || !Number.isFinite(oldRatio) || !Number.isFinite(newRatio)) {
    return false;
  }
  return Math.abs(newRatio - oldRatio) > 0.01;
}

export function getImageCropAspectRatio(naturalAspectRatio: number, crop: ImageCrop): number {
  const imageAspectRatio = Number.isFinite(naturalAspectRatio) && naturalAspectRatio > 0
    ? naturalAspectRatio
    : 1;
  return (imageAspectRatio * crop.width) / crop.height;
}

export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (element) => element.getAttribute('data-file-id') },
      src: { default: null, parseHTML: (element) => element.getAttribute('data-src') },
      markdownHref: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-markdown-href'),
        renderHTML: (attrs) => (attrs.markdownHref ? { 'data-markdown-href': attrs.markdownHref } : {}),
      },
      markdownLabel: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-markdown-label'),
        renderHTML: (attrs) => (typeof attrs.markdownLabel === 'string' ? { 'data-markdown-label': attrs.markdownLabel } : {}),
      },
      alt: { default: '', parseHTML: (element) => element.getAttribute('alt') ?? '' },
      align: {
        default: 'center',
        parseHTML: (element) => validImageAlign(element.getAttribute('data-align')) ?? 'center',
        renderHTML: (attrs) => (attrs.align ? { 'data-align': attrs.align } : {}),
      },
      caption: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-caption') ?? '',
        renderHTML: (attrs) => (attrs.caption ? { 'data-caption': attrs.caption } : {}),
      },
      crop: {
        default: null,
        parseHTML: (element) => parseImageCrop(element.getAttribute('data-crop')),
        renderHTML: (attrs) => {
          const formatted = formatImageCrop(attrs.crop as ImageCrop | null);
          return formatted ? { 'data-crop': formatted } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-file-id]' }, { tag: 'img[data-src]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-file-id': node.attrs.fileId,
        'data-src': node.attrs.src,
        'data-markdown-href': node.attrs.markdownHref || undefined,
        'data-markdown-label': typeof node.attrs.markdownLabel === 'string' ? node.attrs.markdownLabel : undefined,
        alt: node.attrs.alt,
        'data-align': node.attrs.align || 'center',
        'data-caption': node.attrs.caption || undefined,
        'data-crop': formatImageCrop(node.attrs.crop as ImageCrop | null) || undefined,
      }),
    ];
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      let currentNode = node;
      let isCropping = false;
      let cropDraft: ImageCrop = (node.attrs.crop as ImageCrop) ?? { x: 0, y: 0, width: 1, height: 1 };
      let naturalAspectRatio = 1;
      let imageLoadRequest = 0;
      let replacementRequest = 0;
      let activeImageUrl: string | null = null;
      let imageSourceKey: string | null = null;
      let remoteBox: HTMLElement | null = null;
      let isDestroyed = false;

      const dom = document.createElement('figure');
      dom.className = 'image-block is-loading';
      dom.contentEditable = 'false';
      dom.tabIndex = 0;

      const cropWrapper = document.createElement('div');
      cropWrapper.className = 'image-crop-wrapper';
      dom.appendChild(cropWrapper);

      const img = document.createElement('img');
      img.alt = String(node.attrs.alt ?? '');
      img.draggable = false;
      cropWrapper.appendChild(img);

      const captionEl = document.createElement('figcaption');
      captionEl.className = 'image-caption';
      dom.appendChild(captionEl);

      const captionInput = document.createElement('input');
      captionInput.className = 'image-caption-input';
      captionInput.type = 'text';
      captionInput.placeholder = t('editor.imageCaption');
      captionInput.style.display = 'none';
      dom.appendChild(captionInput);

      const toolbar = document.createElement('div');
      toolbar.className = 'image-toolbar';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', t('slash.items.image.title'));
      dom.appendChild(toolbar);

      const missingMessage = document.createElement('div');
      missingMessage.className = 'image-missing-message';
      missingMessage.textContent = t('editor.imageMissing');
      missingMessage.style.display = 'none';
      dom.appendChild(missingMessage);

      // Interactive Crop Overlay
      const cropOverlay = document.createElement('div');
      cropOverlay.className = 'image-crop-overlay';
      cropOverlay.style.display = 'none';
      cropWrapper.appendChild(cropOverlay);

      const cropBox = document.createElement('div');
      cropBox.className = 'image-crop-box';
      cropOverlay.appendChild(cropBox);

      const makeCorner = (cornerClass: string) => {
        const corner = document.createElement('div');
        corner.className = `image-crop-handle ${cornerClass}`;
        cropBox.appendChild(corner);
        return corner;
      };

      const cornerTL = makeCorner('handle-tl');
      const cornerTR = makeCorner('handle-tr');
      const cornerBL = makeCorner('handle-bl');
      const cornerBR = makeCorner('handle-br');

      const cropActions = document.createElement('div');
      cropActions.className = 'image-crop-actions';
      cropOverlay.appendChild(cropActions);

      const applyCropBtn = document.createElement('button');
      applyCropBtn.type = 'button';
      applyCropBtn.className = 'button small primary';
      applyCropBtn.innerHTML = `<span class="icon-inline">✓</span> ${t('editor.applyCrop')}`;
      cropActions.appendChild(applyCropBtn);

      const cancelCropBtn = document.createElement('button');
      cancelCropBtn.type = 'button';
      cancelCropBtn.className = 'button small';
      cancelCropBtn.innerHTML = `<span class="icon-inline">✕</span> ${t('editor.cancelCrop')}`;
      cropActions.appendChild(cancelCropBtn);

      const renderCropOverlay = () => {
        cropBox.style.left = `${cropDraft.x * 100}%`;
        cropBox.style.top = `${cropDraft.y * 100}%`;
        cropBox.style.width = `${cropDraft.width * 100}%`;
        cropBox.style.height = `${cropDraft.height * 100}%`;
      };

      const updatePresentation = () => {
        dom.setAttribute('data-align', String(currentNode.attrs.align || 'center'));

        const caption = typeof currentNode.attrs.caption === 'string' ? currentNode.attrs.caption.trim() : '';
        if (caption) {
          captionEl.textContent = caption;
          captionEl.style.display = '';
        } else {
          captionEl.textContent = '';
          captionEl.style.display = 'none';
        }

        const crop = validImageCrop(currentNode.attrs.crop);
        if (crop && !isCropping) {
          cropWrapper.style.overflow = 'hidden';
          cropWrapper.style.position = 'relative';
          cropWrapper.style.aspectRatio = `${getImageCropAspectRatio(naturalAspectRatio, crop)} / 1`;
          cropWrapper.style.width = '100%';
          cropWrapper.style.maxWidth = '100%';

          img.style.position = 'absolute';
          img.style.left = `${-(crop.x / crop.width) * 100}%`;
          img.style.top = `${-(crop.y / crop.height) * 100}%`;
          img.style.width = `${(1 / crop.width) * 100}%`;
          img.style.height = `${(1 / crop.height) * 100}%`;
          img.style.maxWidth = 'none';
          img.style.maxHeight = 'none';
          img.style.objectFit = 'fill';
        } else {
          cropWrapper.style.overflow = isCropping ? 'hidden' : 'visible';
          cropWrapper.style.position = 'relative';
          cropWrapper.style.aspectRatio = '';
          cropWrapper.style.width = '';
          cropWrapper.style.maxWidth = '100%';

          img.style.position = 'static';
          img.style.left = '';
          img.style.top = '';
          img.style.width = '';
          img.style.height = '';
          img.style.maxWidth = '100%';
          img.style.objectFit = 'contain';
        }

        if (isCropping) {
          cropOverlay.style.display = 'block';
          renderCropOverlay();
        } else {
          cropOverlay.style.display = 'none';
        }

        buildToolbar();
      };

      const commitAttrs = (updates: Partial<typeof currentNode.attrs>) => {
        const position = getPos();
        if (typeof position !== 'number') return;
        const state = view.state;
        const liveNode = state.doc.nodeAt(position);
        if (!liveNode || liveNode.type !== currentNode.type) return;
        view.dispatch(state.tr.setNodeMarkup(position, undefined, { ...liveNode.attrs, ...updates }));
      };

      const showImageMissing = () => {
        activeImageUrl = null;
        dom.classList.remove('is-loading');
        dom.classList.add('is-missing');
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
        missingMessage.style.display = '';
      };

      const loadImageFile = (fileId: string) => {
        const request = ++imageLoadRequest;
        naturalAspectRatio = 1;
        activeImageUrl = null;
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
        missingMessage.style.display = 'none';
        dom.classList.remove('is-missing');
        dom.classList.add('is-loading');

        void Promise.resolve()
          .then(() => fileUrl(fileId))
          .then((url) => {
            if (
              isDestroyed ||
              request !== imageLoadRequest ||
              String(currentNode.attrs.fileId ?? '') !== fileId
            )
              return;
            if (!url) {
              showImageMissing();
              return;
            }
            img.src = url;
            activeImageUrl = img.src;
            updatePresentation();
          })
          .catch(() => {
            if (
              !isDestroyed &&
              request === imageLoadRequest &&
              String(currentNode.attrs.fileId ?? '') === fileId
            )
              showImageMissing();
          });
      };

      const isExpectedImageUrl = () =>
        activeImageUrl !== null &&
        img.src === activeImageUrl &&
        (!img.currentSrc || img.currentSrc === activeImageUrl);

      const showRemoteSource = (src: string) => {
        imageLoadRequest += 1;
        activeImageUrl = null;
        naturalAspectRatio = 1;
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
        missingMessage.style.display = 'none';
        dom.classList.remove('is-loading', 'is-missing');
        remoteBox?.remove();

        const remote = /^https:\/\//i.test(src);
        const box = document.createElement('div');
        box.className = 'image-remote';
        const label = document.createElement('span');
        label.textContent = remote
          ? t('editor.imageFrom', { host: safeHost(src) })
          : t('editor.imageNotFound', { src });
        box.append(label);
        if (remote) {
          const load = document.createElement('button');
          load.type = 'button';
          load.className = 'button small';
          load.textContent = t('editor.loadImage');
          load.addEventListener('click', (event) => {
            event.preventDefault();
            if (imageSourceKey !== `src:${src}` || currentNode.attrs.fileId) return;
            naturalAspectRatio = 1;
            img.removeAttribute('src');
            img.style.visibility = 'hidden';
            img.src = src;
            activeImageUrl = img.src;
            box.remove();
            if (remoteBox === box) remoteBox = null;
          });
          box.append(load);
        }
        remoteBox = box;
        dom.prepend(box);
      };

      const updateImageSource = (attrs: typeof currentNode.attrs) => {
        const fileId = typeof attrs.fileId === 'string' && attrs.fileId ? attrs.fileId : null;
        const src = typeof attrs.src === 'string' && attrs.src ? attrs.src : null;
        const nextKey = fileId ? `file:${fileId}` : src ? `src:${src}` : 'missing';
        if (nextKey === imageSourceKey) return;

        imageSourceKey = nextKey;
        replacementRequest += 1;
        remoteBox?.remove();
        remoteBox = null;

        if (fileId) {
          loadImageFile(fileId);
        } else if (src) {
          showRemoteSource(src);
        } else {
          imageLoadRequest += 1;
          showImageMissing();
        }
      };

      const startCropping = () => {
        isCropping = true;
        cropDraft = (currentNode.attrs.crop as ImageCrop) ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
        updatePresentation();
      };

      const cancelCropping = () => {
        isCropping = false;
        updatePresentation();
      };

      const applyCropping = () => {
        isCropping = false;
        commitAttrs({ crop: validImageCrop(cropDraft) });
      };

      applyCropBtn.addEventListener('click', (e) => {
        e.preventDefault();
        applyCropping();
      });

      cancelCropBtn.addEventListener('click', (e) => {
        e.preventDefault();
        cancelCropping();
      });

      // Dragging crop handles
      const setupHandleDrag = (
        handleEl: HTMLElement,
        onDrag: (dx: number, dy: number, startCrop: ImageCrop) => ImageCrop,
      ) => {
        handleEl.addEventListener('pointerdown', (event: PointerEvent) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const startY = event.clientY;
          const startCrop = { ...cropDraft };
          const rect = cropWrapper.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          const onMove = (moveEvt: PointerEvent) => {
            const dx = (moveEvt.clientX - startX) / rect.width;
            const dy = (moveEvt.clientY - startY) / rect.height;
            cropDraft = onDrag(dx, dy, startCrop);
            renderCropOverlay();
          };

          const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
          };

          window.addEventListener('pointermove', onMove, true);
          window.addEventListener('pointerup', onUp, true);
          window.addEventListener('pointercancel', onUp, true);
        });
      };

      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

      setupHandleDrag(cropBox, (dx, dy, startCrop) => ({
        ...startCrop,
        x: clamp(startCrop.x + dx, 0, 1 - startCrop.width),
        y: clamp(startCrop.y + dy, 0, 1 - startCrop.height),
      }));

      setupHandleDrag(cornerTL, (dx, dy, startCrop) => {
        const right = startCrop.x + startCrop.width;
        const bottom = startCrop.y + startCrop.height;
        const x = clamp(startCrop.x + dx, 0, right - 0.1);
        const y = clamp(startCrop.y + dy, 0, bottom - 0.1);
        return { x, y, width: right - x, height: bottom - y };
      });

      setupHandleDrag(cornerTR, (dx, dy, startCrop) => {
        const bottom = startCrop.y + startCrop.height;
        const y = clamp(startCrop.y + dy, 0, bottom - 0.1);
        return {
          x: startCrop.x,
          y,
          width: clamp(startCrop.width + dx, 0.1, 1 - startCrop.x),
          height: bottom - y,
        };
      });

      setupHandleDrag(cornerBL, (dx, dy, startCrop) => {
        const right = startCrop.x + startCrop.width;
        const x = clamp(startCrop.x + dx, 0, right - 0.1);
        return {
          x,
          y: startCrop.y,
          width: right - x,
          height: clamp(startCrop.height + dy, 0.1, 1 - startCrop.y),
        };
      });

      setupHandleDrag(cornerBR, (dx, dy, startCrop) => ({
        ...startCrop,
        width: clamp(startCrop.width + dx, 0.1, 1 - startCrop.x),
        height: clamp(startCrop.height + dy, 0.1, 1 - startCrop.y),
      }));

      // Replace image helper
      const triggerReplace = () => {
        const request = ++replacementRequest;
        const originalFileId = currentNode.attrs.fileId;
        const isCurrentRequest = () => {
          if (isDestroyed || request !== replacementRequest || currentNode.attrs.fileId !== originalFileId) {
            return false;
          }
          const position = getPos();
          if (typeof position !== 'number') return false;
          const liveNode = view.state.doc.nodeAt(position);
          return !!liveNode && liveNode.type === currentNode.type && liveNode.attrs.fileId === originalFileId;
        };
        const invalidateRequest = () => {
          if (request === replacementRequest) replacementRequest += 1;
        };
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('cancel', invalidateRequest);
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) {
            invalidateRequest();
            return;
          }
          if (!isCurrentRequest()) return;
          if (!file.type.startsWith('image/')) {
            toast(t('database.imageFilesOnly'), { tone: 'error' });
            invalidateRequest();
            return;
          }
          try {
            const stored = await storeFiles([file]);
            if (!isCurrentRequest()) return;
            if (!stored.length) return;
            const newMeta = stored[0]!;

            // Measure natural aspect ratio of the new image
            const objectUrl = URL.createObjectURL(file);
            let newRatio: number | null = null;
            try {
              newRatio = await new Promise<number | null>((resolve) => {
                const tempImg = new window.Image();
                tempImg.onload = () => {
                  if (tempImg.naturalWidth && tempImg.naturalHeight) {
                    resolve(tempImg.naturalWidth / tempImg.naturalHeight);
                  } else {
                    resolve(null);
                  }
                };
                tempImg.onerror = () => resolve(null);
                tempImg.src = objectUrl;
              });
            } finally {
              URL.revokeObjectURL(objectUrl);
            }

            if (!isCurrentRequest()) return;

            const oldRatio =
              img.naturalWidth && img.naturalHeight
                ? img.naturalWidth / img.naturalHeight
                : naturalAspectRatio || null;

            const shouldReset = shouldResetCropOnImageReplace(oldRatio, newRatio);
            let nextCrop = currentNode.attrs.crop ?? null;
            if (shouldReset) {
              nextCrop = null;
            }

            commitAttrs({ fileId: newMeta.id, src: null, crop: nextCrop });
          } catch {
            if (isCurrentRequest()) toast(t('editor.couldNotCopy'), { tone: 'error' });
          } finally {
            invalidateRequest();
          }
        });
        input.click();
      };

      // Caption toggle
      const triggerCaption = () => {
        if (captionInput.style.display === 'none') {
          captionInput.style.display = 'block';
          captionInput.value = String(currentNode.attrs.caption ?? '');
          captionInput.focus();
        } else {
          captionInput.style.display = 'none';
        }
      };

      captionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitAttrs({ caption: captionInput.value.trim() });
          captionInput.style.display = 'none';
        } else if (e.key === 'Escape') {
          e.preventDefault();
          captionInput.style.display = 'none';
        }
      });
      captionInput.addEventListener('blur', () => {
        commitAttrs({ caption: captionInput.value.trim() });
        captionInput.style.display = 'none';
      });

      const buildToolbar = () => {
        toolbar.replaceChildren();
        if (isCropping) return;

        // Replace
        const replaceBtn = document.createElement('button');
        replaceBtn.type = 'button';
        replaceBtn.className = 'image-tool-btn';
        replaceBtn.title = t('editor.replaceImage');
        replaceBtn.setAttribute('aria-label', t('editor.replaceImage'));
        replaceBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
        replaceBtn.addEventListener('click', triggerReplace);
        toolbar.appendChild(replaceBtn);

        // Caption
        const captionBtn = document.createElement('button');
        captionBtn.type = 'button';
        captionBtn.className = `image-tool-btn${currentNode.attrs.caption ? ' is-active' : ''}`;
        captionBtn.title = t('editor.imageCaption');
        captionBtn.setAttribute('aria-label', t('editor.imageCaption'));
        captionBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
        captionBtn.addEventListener('click', triggerCaption);
        toolbar.appendChild(captionBtn);

        const divider1 = document.createElement('span');
        divider1.className = 'image-tool-divider';
        toolbar.appendChild(divider1);

        // Alignments
        const aligns: Array<{ align: ImageAlign; icon: string; title: string }> = [
          {
            align: 'left',
            title: t('editor.alignLeft'),
            icon: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
          },
          {
            align: 'center',
            title: t('editor.alignCenter'),
            icon: '<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>',
          },
          {
            align: 'right',
            title: t('editor.alignRight'),
            icon: '<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>',
          },
        ];

        aligns.forEach(({ align, title, icon }) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          const active = (currentNode.attrs.align || 'center') === align;
          btn.className = `image-tool-btn${active ? ' is-active' : ''}`;
          btn.title = title;
          btn.setAttribute('aria-label', title);
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
          btn.addEventListener('click', () => commitAttrs({ align }));
          toolbar.appendChild(btn);
        });

        const divider2 = document.createElement('span');
        divider2.className = 'image-tool-divider';
        toolbar.appendChild(divider2);

        // Crop
        const cropBtn = document.createElement('button');
        cropBtn.type = 'button';
        cropBtn.className = `image-tool-btn${currentNode.attrs.crop ? ' is-active' : ''}`;
        cropBtn.title = t('editor.cropImage');
        cropBtn.setAttribute('aria-label', t('editor.cropImage'));
        cropBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>`;
        cropBtn.addEventListener('click', startCropping);
        toolbar.appendChild(cropBtn);

        // Reset Crop
        if (currentNode.attrs.crop) {
          const resetCropBtn = document.createElement('button');
          resetCropBtn.type = 'button';
          resetCropBtn.className = 'image-tool-btn';
          resetCropBtn.title = t('editor.resetCrop');
          resetCropBtn.setAttribute('aria-label', t('editor.resetCrop'));
          resetCropBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;
          resetCropBtn.addEventListener('click', () => commitAttrs({ crop: null }));
          toolbar.appendChild(resetCropBtn);
        }
      };

      img.addEventListener('load', () => {
        if (!isExpectedImageUrl()) return;
        const nw = img.naturalWidth || 1;
        const nh = img.naturalHeight || 1;
        naturalAspectRatio = nw / nh;
        img.style.visibility = '';
        dom.classList.remove('is-loading', 'is-missing');
        missingMessage.style.display = 'none';
        updatePresentation();
      });

      img.addEventListener('error', () => {
        if (!isExpectedImageUrl()) return;
        showImageMissing();
      });

      updateImageSource(currentNode.attrs);

      dom.addEventListener('morrow:image-crop', () => startCropping());
      dom.addEventListener('morrow:image-replace', () => triggerReplace());
      dom.addEventListener('morrow:image-caption', () => triggerCaption());

      updatePresentation();

      return {
        dom,
        update(updated) {
          if (updated.type !== currentNode.type) return false;
          currentNode = updated;
          updateImageSource(updated.attrs);
          updatePresentation();
          return true;
        },
        stopEvent(event) {
          const target = event.target;
          if (!(target instanceof Element)) return false;
          return (
            target.closest(
              '.image-toolbar, .image-crop-overlay, .image-caption-input, .image-remote button',
            ) !== null
          );
        },
        destroy() {
          isDestroyed = true;
          imageLoadRequest += 1;
          replacementRequest += 1;
        },
      };
    };
  },
});

export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (element) => element.getAttribute('data-file-id') },
      name: { default: 'file', parseHTML: (element) => element.textContent ?? 'file' },
      markdownHref: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-markdown-href'),
        renderHTML: (attrs) => (attrs.markdownHref ? { 'data-markdown-href': attrs.markdownHref } : {}),
      },
      markdownLabel: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-markdown-label'),
        renderHTML: (attrs) => (typeof attrs.markdownLabel === 'string' ? { 'data-markdown-label': attrs.markdownLabel } : {}),
      },
      size: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-attachment]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-file-attachment': '', 'data-file-id': node.attrs.fileId }),
      String(node.attrs.name ?? 'file'),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'file-block';
      dom.contentEditable = 'false';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = String(node.attrs.name ?? 'file');
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = typeof node.attrs.size === 'number' ? formatBytes(node.attrs.size) : '';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'file-save';
      save.textContent = t('editor.saveACopy');
      save.addEventListener('click', (event) => {
        event.preventDefault();
        void downloadFile(String(node.attrs.fileId ?? ''));
      });
      dom.append(name, meta, save);
      const kind = mediaKind(String(node.attrs.name ?? ''));
      if (!kind) return { dom };
      const shell = document.createElement('div');
      shell.className = `media-block media-${kind}`;
      shell.contentEditable = 'false';
      const player =
        kind === 'pdf'
          ? document.createElement('iframe')
          : document.createElement(kind === 'audio' ? 'audio' : 'video');
      if (player instanceof HTMLMediaElement) {
        player.controls = true;
        player.preload = 'metadata';
      } else {
        player.title = String(node.attrs.name ?? 'PDF');
      }
      dom.classList.add('is-compact');
      shell.append(player, dom);
      void fileUrl(String(node.attrs.fileId ?? '')).then((url) => {
        if (url) player.src = url;
        else shell.classList.add('is-missing');
      });
      return {
        dom: shell,
        stopEvent: (event) => event.target === player,
        ignoreMutation: () => true,
      };
    };
  },
});

export function mediaKind(name: string): 'audio' | 'video' | 'pdf' | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'].includes(extension)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  return null;
}

function safeHost(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return 'the web';
  }
}

export function mediaNodes(files: FileMeta[]) {
  return files.map((file) =>
    file.type.startsWith('image/')
      ? { type: 'image', attrs: { fileId: file.id, alt: file.name.replace(/\.[^.]+$/, '') } }
      : { type: 'fileAttachment', attrs: { fileId: file.id, name: file.name, size: file.size } },
  );
}

export async function insertFiles(editor: Editor, files: File[], at?: number): Promise<void> {
  const stored = await storeFiles(files);
  if (stored.length === 0 || editor.isDestroyed) return;
  const position = at ?? editor.state.selection.to;
  editor
    .chain()
    .focus()
    .insertContentAt(Math.min(position, editor.state.doc.content.size), [
      ...mediaNodes(stored),
      { type: 'paragraph' },
    ])
    .run();
}

function filesFrom(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

export const FileDrop = Extension.create({
  name: 'fileDrop',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('fileDrop'),
        props: {
          handlePaste(_view: EditorView, event: ClipboardEvent) {
            const files = filesFrom(event.clipboardData);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertFiles(editor, files);
            return true;
          },
          handleDrop(view: EditorView, event: DragEvent, _slice, moved: boolean) {
            const files = filesFrom(event.dataTransfer);
            if (moved || files.length === 0) return false;
            event.preventDefault();
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertFiles(editor, files, position);
            return true;
          },
        },
      }),
    ];
  },
});
