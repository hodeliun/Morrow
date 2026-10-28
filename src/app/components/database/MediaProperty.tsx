import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Download,
  FilePlus2,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Maximize2,
  Underline,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageMeta, PropDef, PropValue } from '../../../core/model';
import {
  allowsMultipleAttachments,
  emptyRichCanvasValue,
  encodeAttachmentValue,
  parseRichCanvas,
  readAttachmentValue,
} from '../../../core/propertyMedia';
import { docToPlainText } from '../../../core/doc';
import { displayTitle } from '../../../core/model';
import { FileAttachment, FileDrop, Image } from '../../editor/Media';
import { downloadFile, fileUrl, formatBytes, storeFiles } from '../../platform/attachments';
import { pickFiles } from '../../platform/files';
import { t } from '../../i18n';
import { toast } from '../../ui';
import { getSession, useWorkspace } from '../../workspace';
import { layerPortalTarget, useDismissableLayer } from '../layers';
import { setValue, updateProp } from './data';

export function MediaPropertyInput({
  prop,
  row,
  value,
  editable,
}: {
  prop: PropDef;
  row: PageMeta;
  value: PropValue;
  editable: boolean;
}) {
  if (prop.type === 'richCanvas')
    return (
      <RichCanvasField
        value={value}
        label={t('properties.valueOf', { key: prop.name, title: displayTitle(row) })}
        editable={editable}
        onChange={(next) => setValue(row.id, prop.id, next)}
      />
    );
  return (
    <AttachmentField
      prop={prop}
      value={value}
      editable={editable}
      onChange={(next) => setValue(row.id, prop.id, next)}
    />
  );
}

export function MediaPropertyDisplay({ prop, value }: { prop: PropDef; value: PropValue }) {
  if (prop.type === 'richCanvas')
    return (
      <RichCanvasField
        value={value}
        label={t('database.openRichCanvas', { name: prop.name })}
        editable={false}
        onChange={() => undefined}
      />
    );
  return <AttachmentField prop={prop} value={value} editable={false} onChange={() => undefined} />;
}

export function MediaPropertyOptions({
  prop,
  dbId,
  rows,
}: {
  prop: PropDef;
  dbId: string;
  rows: PageMeta[];
}) {
  if (prop.type !== 'image' && prop.type !== 'file') return null;
  const requiresMultiple =
    rows.some((row) => (readAttachmentValue(row.properties[prop.id])?.length ?? 0) > 1) ||
    (readAttachmentValue(prop.defaultValue)?.length ?? 0) > 1;
  return (
    <div className="media-multiple-setting">
      <label className="field-inline">
        <input
          type="checkbox"
          checked={allowsMultipleAttachments(prop)}
          disabled={!allowsMultipleAttachments(prop) && requiresMultiple}
          aria-label={t('database.multipleAttachments')}
          onChange={(event) =>
            updateProp(dbId, prop.id, (current) => ({
              ...current,
              media: { multiple: event.target.checked },
            }))
          }
        />
        <span>{t('database.multipleAttachments')}</span>
      </label>
      {!allowsMultipleAttachments(prop) && requiresMultiple && (
        <small role="status" className="muted">
          {t('database.multipleRequiredByValues')}
        </small>
      )}
    </div>
  );
}
export function MediaPropertyDefault({ prop, dbId }: { prop: PropDef; dbId: string }) {
  const value = prop.defaultValue ?? null;
  const save = (next: PropValue) =>
    updateProp(dbId, prop.id, (current) => ({ ...current, defaultValue: next ?? null }));
  if (prop.type === 'richCanvas')
    return (
      <div className="field media-default-value">
        <span>{t('database.defaultValue')}</span>
        <RichCanvasField
          value={value}
          label={t('database.editRichCanvasDefault', { name: prop.name })}
          editable
          onChange={save}
        />
      </div>
    );
  return (
    <div className="field media-default-value">
      <span>{t('database.defaultValue')}</span>
      <AttachmentField prop={prop} value={value} editable onChange={save} />
    </div>
  );
}

function AttachmentField({
  prop,
  value,
  editable,
  onChange,
}: {
  prop: PropDef;
  value: PropValue;
  editable: boolean;
  onChange: (next: PropValue) => boolean | void;
}) {
  const state = useWorkspace();
  const decoded = readAttachmentValue(value);
  const invalid = value !== null && value !== '' && decoded === null;
  const files = decoded ?? [];
  const idsKey = files.map((file) => file.id).join('|');
  const [available, setAvailable] = useState<Record<string, string | null>>({});
  const multiple = allowsMultipleAttachments(prop);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const stored = new Set((await getSession().listFiles()).map((file) => file.id));
        const urls: Record<string, string | null> = {};
        await Promise.all(
          files.map(async (file) => {
            urls[file.id] = stored.has(file.id) ? await fileUrl(file.id) : null;
          }),
        );
        if (current) setAvailable(urls);
      } catch {
        if (current) setAvailable(Object.fromEntries(files.map((file) => [file.id, null])));
      }
    };
    void load();
    return () => {
      current = false;
    };
    // State changes include files added or removed from the vault by another supported editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, state]);

  if (invalid)
    return (
      <div className="media-property-invalid" role="status">
        {t('database.attachmentUnsupported')}
      </div>
    );

  const addFiles = async () => {
    const imageOnly = prop.type === 'image';
    const selected = await pickFiles(imageOnly ? 'image/*' : '', multiple);
    if (selected.length === 0) return;
    const valid = imageOnly ? selected.filter((file) => file.type.toLowerCase().startsWith('image/')) : selected;
    if (valid.length !== selected.length) toast(t('database.imageFilesOnly'), { tone: 'error' });
    if (valid.length === 0) return;
    const stored = await storeFiles(valid);
    if (stored.length === 0) return;
    const refs = stored.map((file) => ({ ...file }));
    onChange(encodeAttachmentValue(multiple ? [...files, ...refs] : refs));
  };

  const remove = (id: string) => onChange(encodeAttachmentValue(files.filter((file) => file.id !== id)));

  return (
    <div className={`media-property${files.length ? '' : ' is-empty'}`}>
      {files.length === 0 ? (
        editable ? (
          <button type="button" className="media-add button small" onClick={() => void addFiles()}>
            {prop.type === 'image' ? <ImageIcon size={14} /> : <FilePlus2 size={14} />}
            {t(prop.type === 'image' ? 'database.addImages' : 'database.addFiles')}
          </button>
        ) : (
          <span className="prop-empty">{t('database.empty')}</span>
        )
      ) : (
        <div className="media-property-list">
          {files.map((file) => {
            const url = available[file.id];
            const missing = url === null;
            return (
              <div className={`media-property-item${missing ? ' is-missing' : ''}`} key={file.id}>
                {prop.type === 'image' && url ? (
                  <img className="media-property-thumb" src={url} alt={file.name} />
                ) : (
                  <span className="media-property-file-icon" aria-hidden="true">
                    {prop.type === 'image' ? <ImageIcon size={17} /> : <FilePlus2 size={17} />}
                  </span>
                )}
                <span className="media-property-info">
                  <span className="media-property-name" title={file.name}>
                    {file.name}
                  </span>
                  <small>{missing ? t('database.attachmentMissing') : formatBytes(file.size)}</small>
                </span>
                {!missing && (
                  <button
                    type="button"
                    className="icon-button tiny"
                    aria-label={t('database.downloadAttachment', { name: file.name })}
                    title={t('database.downloadAttachment', { name: file.name })}
                    onClick={() => void downloadFile(file.id)}
                  >
                    <Download size={13} />
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    className="icon-button tiny danger"
                    aria-label={t('database.removeAttachment', { name: file.name })}
                    title={t('database.removeAttachment', { name: file.name })}
                    onClick={() => remove(file.id)}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {editable && files.length > 0 && multiple && (
        <button type="button" className="media-add-more text-tool" onClick={() => void addFiles()}>
          <FilePlus2 size={13} /> {t(prop.type === 'image' ? 'database.addImages' : 'database.addFiles')}
        </button>
      )}
    </div>
  );
}

function RichCanvasField({
  value,
  label,
  editable,
  onChange,
}: {
  value: PropValue;
  label: string;
  editable: boolean;
  onChange: (next: string | null) => boolean | void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => setOpen(false);
  const doc = value === null ? null : parseRichCanvas(value);
  const invalid = value !== null && !doc;
  const summary = doc ? docToPlainText(doc).trim().replace(/\s+/g, ' ') : '';
  const preview = invalid ? t('database.richCanvasUnsupported') : summary || t('database.richCanvasEmpty');
  const button = (
    <button
      ref={trigger}
      type="button"
      className={`rich-canvas-preview${!editable ? ' is-readonly' : ''}${invalid ? ' is-invalid' : ''}`}
      aria-label={label}
      disabled={invalid}
      onClick={() => setOpen(true)}
    >
      <span>{preview}</span>
      {!invalid && <Maximize2 size={13} aria-hidden="true" />}
    </button>
  );
  const dialog = open ? (
    <RichCanvasDialog
      value={typeof value === 'string' ? value : emptyRichCanvasValue()}
      label={label}
      editable={editable}
      triggerRef={trigger}
      onCancel={close}
      onSave={(next) => {
        if (onChange(next) === false) return;
        close();
      }}
    />
  ) : null;
  return (
    <span className="rich-canvas-field">
      {button}
      {dialog && typeof document !== 'undefined' ? createPortal(dialog, layerPortalTarget()) : dialog}
    </span>
  );
}

function RichCanvasDialog({
  value,
  label,
  editable,
  triggerRef,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  editable: boolean;
  triggerRef: { current: HTMLButtonElement | null };
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(() => parseRichCanvas(value) ?? JSON.parse(emptyRichCanvasValue()), [value]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          link: {
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
            defaultProtocol: 'https',
            protocols: ['http', 'https', 'mailto'],
            HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
          },
        }),
        Image,
        FileAttachment,
        FileDrop,
      ],
      content: initial as JSONContent,
      editable,
      immediatelyRender: false,
      editorProps: {
        attributes: { class: 'prose rich-canvas-editor', 'aria-label': label, spellcheck: 'true' },
      },
    },
    [value, editable],
  );
  const dialogRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useDismissableLayer({
    surfaceRef: dialogRef,
    elementRef: backdropRef,
    triggerRef,
    captureFocusOnMount: Boolean(editor),
    onDismiss: () => {
      if (linkOpen) setLinkOpen(false);
      else onCancel();
    },
    restoreFocusOnEscape: false,
    restoreFocusOnUnmount: true,
  });

  useEffect(() => {
    if (!editor) return;
    if (editable) editor.commands.focus();
    else dialogRef.current?.focus();
  }, [editor, editable]);

  if (!editor) return null;
  const addImages = async () => {
    const files = await pickFiles('image/*', true);
    if (!files.length || editor.isDestroyed) return;
    const stored = await storeFiles(files.filter((file) => file.type.toLowerCase().startsWith('image/')));
    if (stored.length) {
      editor
        .chain()
        .focus()
        .insertContent([...stored.map((file) => ({ type: 'image', attrs: { fileId: file.id, alt: file.name } })), { type: 'paragraph' }])
        .run();
    }
  };
  const openLink = () => {
    const { from, to } = editor.state.selection;
    setSelection({ from, to });
    setHref(String(editor.getAttributes('link').href ?? ''));
    setLinkOpen(true);
  };
  const saveLink = (event: React.FormEvent) => {
    event.preventDefault();
    const clean = href.trim();
    if (!clean || clean.startsWith('//') || !/^(https?:\/\/|mailto:|\/|#)/i.test(clean)) {
      toast(t('database.linkMustBeSafe'), { tone: 'error' });
      return;
    }
    const command = editor.chain().focus();
    if (selection) command.setTextSelection(selection);
    command.setLink({ href: clean }).run();
    setLinkOpen(false);
  };
  const save = () => {
    const next = JSON.stringify(editor.getJSON());
    if (!parseRichCanvas(next)) {
      toast(t('database.richCanvasUnsupported'), { tone: 'error' });
      return;
    }
    onSave(next);
  };
  const toolbar = editable ? (
    <div className="rich-canvas-toolbar" role="toolbar" aria-label={t('editor.formattingAria')}>
      <button type="button" className="icon-button small" aria-label={t('editor.bold')} aria-pressed={editor.isActive('bold')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={15} />
      </button>
      <button type="button" className="icon-button small" aria-label={t('editor.italic')} aria-pressed={editor.isActive('italic')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={15} />
      </button>
      <button type="button" className="icon-button small" aria-label={t('editor.underline')} aria-pressed={editor.isActive('underline')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline size={15} />
      </button>
      <span className="rich-canvas-toolbar-divider" />
      <button type="button" className="icon-button small" aria-label={t('editor.bulletList')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={15} />
      </button>
      <button type="button" className="icon-button small" aria-label={t('editor.orderedList')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={15} />
      </button>
      <button type="button" className="icon-button small" aria-label={t('editor.link')} onMouseDown={(event) => event.preventDefault()} onClick={openLink}>
        <Link2 size={15} />
      </button>
      <button type="button" className="icon-button small" aria-label={t('database.addImages')} onMouseDown={(event) => event.preventDefault()} onClick={() => void addImages()}>
        <ImageIcon size={15} />
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={backdropRef}
      className="rich-canvas-backdrop"
      role="presentation"
    >
      <section
        ref={dialogRef}
        className="rich-canvas-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [contenteditable="true"]',
            ),
          ).filter((item) => item.offsetParent !== null);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="rich-canvas-dialog-head">
          <strong>{label}</strong>
          <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        {toolbar}
        {linkOpen && (
          <form className="rich-canvas-link-form" onSubmit={saveLink}>
            <input
              autoFocus
              type="text"
              className="text-input small"
              aria-label={t('editor.link')}
              placeholder="https://example.com"
              value={href}
              onChange={(event) => setHref(event.target.value)}
            />
            {editor.isActive('link') && (
              <button
                type="button"
                className="button small"
                onClick={() => {
                  editor.chain().focus().unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                {t('editor.removeLink')}
              </button>
            )}
            <button type="submit" className="button small">
              {t('common.save')}
            </button>
          </form>
        )}
        <EditorContent editor={editor} />
        {editable ? (
          <footer className="rich-canvas-dialog-actions">
            <button type="button" className="button small" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button type="button" className="button small primary" onClick={save}>
              {t('common.save')}
            </button>
          </footer>
        ) : (
          <footer className="rich-canvas-dialog-actions">
            <button type="button" className="button small" onClick={onCancel}>
              {t('common.close')}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
