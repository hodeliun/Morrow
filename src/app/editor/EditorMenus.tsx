import type { Editor } from '@tiptap/core';
import { findParentNode } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { BubbleMenuProps } from '@tiptap/react/menus';
import {
  ArrowDown,
  ArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronRight,
  Columns2,
  Crop,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Code,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Highlighter,
  ImageIcon,
  Info,
  Italic,
  Link2,
  Link2Off,
  List,
  ListChecks,
  ListOrdered,
  Palette,
  Pencil,
  Pilcrow,
  Quote,
  Smile,
  Strikethrough,
  Trash2,
  Type,
  Underline,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { pageIdFromHref } from '../../core/links';
import { BACKGROUND_HEX, COLORS, TEXT_HEX, validBlockBackground, validColor, validHexColor } from '../../core/model';
import type { ColorName, ColorValue, HexColor } from '../../core/model';
import { withLinkedViewCollapseEnabled } from '../components/database/LinkedDatabaseView';
import { formatShortcut } from '../actions';
import { Menu } from '../components/Menu';
import { t } from '../i18n';
import type { MenuEntry } from '../components/Menu';
import { copyImageFile, downloadFile } from '../platform/attachments';
import { copyText, desktop, openExternal } from '../platform/desktop';
import { openPage } from '../router';
import { moveBlock } from './BlockHandle';
import type { BlockMenuRequest } from './BlockHandle';
import {
  isTableToggle,
  setHeadingCollapsible,
  toggleSectionCollapsed,
  unwrapDetailsToParagraph,
  wrapBlockInDetails,
} from './CollapsibleHeading';
import { clearBlockSelection, selectedBlocks } from './BlockSelect';
import type { BlockRange } from './BlockSelect';
import { turnListItem } from './turnInto';
import type { TurnTarget } from './turnInto';
import { openDialog, toast } from '../ui';
import { colorLabel } from '../i18n/labels';

function ToolButton({
  label,
  icon: Icon,
  active,
  onClick,
  shortcut,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick: () => void;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className={`tool-button${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${formatShortcut(shortcut)})` : label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

export function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:|mailto:|#\/page\/)/i.test(value)) return value;
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(value)) return `mailto:${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return `https://${value}`;
}

export function openHref(href: string): void {
  const pageId = pageIdFromHref(href);
  if (pageId) openPage(pageId);
  else openExternal(href);
}

function LinkInput({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [value, setValue] = useState(() => String(editor.getAttributes('link').href ?? ''));
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const apply = () => {
    if (!value.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onDone();
      return;
    }
    const href = normalizeHref(value);
    if (!href) {
      setError(true);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    onDone();
  };
  return (
    <form
      className="link-form"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <input
        ref={inputRef}
        className={`link-input${error ? ' is-invalid' : ''}`}
        placeholder={t('editor.linkPlaceholder')}
        aria-label={t('editor.linkAddressAria')}
        aria-invalid={error}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editor.commands.focus();
            onDone();
          }
        }}
      />
      <button type="submit" className="link-apply">
        {t('editor.apply')}
      </button>
    </form>
  );
}

// bubble menu props must keep their identity, new objects make tiptap dispatch and rerender in a loop
const showFormatting: BubbleMenuProps['shouldShow'] = ({ editor, state, from, to }) => {
  if (!editor.isEditable || from === to || state.selection instanceof NodeSelection) return false;
  // whole blocks picked in the margin have the block menu instead
  return !editor.isActive('codeBlock') && !selectedBlocks(state);
};
const showLink: BubbleMenuProps['shouldShow'] = ({ editor, from, to }) =>
  from === to && editor.isActive('link');
const showTable: BubbleMenuProps['shouldShow'] = ({ editor, from, to }) =>
  editor.isEditable && from === to && editor.isActive('table');
const TABLE_OPTIONS = { placement: 'top-start', offset: 8, flip: true, shift: { padding: 8 } } as const;

function useMarks(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      highlight: current.isActive('highlight'),
      link: current.isActive('link'),
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      h4: current.isActive('heading', { level: 4 }),
      h5: current.isActive('heading', { level: 5 }),
      h6: current.isActive('heading', { level: 6 }),
      href: String(current.getAttributes('link').href ?? ''),
    }),
  });
}

function CustomColorPicker({
  value,
  palette,
  fallback,
  label,
  disabled = false,
  onChange,
}: {
  value: ColorValue | null;
  palette: Record<ColorName, string>;
  fallback: string;
  label: string;
  disabled?: boolean;
  onChange: (color: HexColor) => void;
}) {
  const currentHex = value ? (validHexColor(value) ?? palette[value as ColorName]) : fallback;
  const [draft, setDraft] = useState(currentHex);
  const errorId = useId();
  const validDraft = validHexColor(draft);
  const selectedCustom = validHexColor(value) !== null;

  const apply = (raw: string) => {
    setDraft(raw);
    const color = validHexColor(raw);
    if (color) onChange(color);
  };

  return (
    <span className={`color-custom-control${selectedCustom ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}>
      <label className="color-custom-picker" title={label}>
        <Palette size={14} aria-hidden="true" />
        <input
          type="color"
          aria-label={label}
          disabled={disabled}
          value={validDraft ?? currentHex}
          onChange={(event) => apply(event.target.value)}
        />
      </label>
      <input
        className="color-hex-input"
        type="text"
        aria-label={t('editor.hexColorFor', { target: label })}
        aria-invalid={validDraft === null}
        aria-describedby={validDraft === null ? errorId : undefined}
        disabled={disabled}
        value={draft}
        placeholder="#RRGGBB"
        maxLength={7}
        spellCheck={false}
        onChange={(event) => apply(event.target.value)}
      />
      <span className="visually-hidden" id={errorId}>
        {t('editor.invalidHexColor')}
      </span>
    </span>
  );
}

function ColorPanel({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      text: validColor(e.getAttributes('textColor').color),
      bg: e.isActive('highlight')
        ? (validColor(e.getAttributes('highlight').color) ?? 'yellow')
        : null,
      blockBackground: validBlockBackground(e.state.selection.$from.parent.attrs.blockBackground),
      canSetBlockBackground: e.state.selection.$from.sameParent(e.state.selection.$to),
    }),
  });
  const setCurrentBlockBackground = (color: ColorValue | null) => {
    const { $from, $to } = editor.state.selection;
    if (!$from.sameParent($to)) return;
    const node = $from.node($from.depth);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup($from.before($from.depth), undefined, {
        ...node.attrs,
        blockBackground: color,
      }),
    );
  };
  const row = (kind: 'text' | 'bg') => {
    const value = kind === 'text' ? current.text : current.bg;
    const customLabel = t(kind === 'text' ? 'editor.customTextColor' : 'editor.customHighlightColor');
    return (
      <div
        className="color-row"
        role="group"
        aria-label={kind === 'text' ? t('editor.textColour') : t('editor.highlight')}
      >
        <button
          type="button"
          className={`color-dot default${value === null ? ' is-active' : ''}`}
          title={kind === 'text' ? t('editor.defaultTextColor') : t('editor.noHighlight')}
          aria-label={kind === 'text' ? t('editor.defaultTextColor') : t('editor.noHighlight')}
          aria-pressed={value === null}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            kind === 'text'
              ? editor.chain().focus().setTextColor(null).run()
              : editor.chain().focus().setHighlightColor(null).run()
          }
        >
          {kind === 'text' ? 'A' : ''}
        </button>
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-dot ${kind}-${color}${value === color ? ' is-active' : ''}`}
            title={kind === 'bg' ? t('editor.colourHighlight', { colour: colorLabel(color) }) : colorLabel(color)}
            aria-label={
              kind === 'bg'
                ? t('editor.colourHighlight', { colour: colorLabel(color) })
                : t('editor.colourText', { colour: colorLabel(color) })
            }
            aria-pressed={value === color}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              kind === 'text'
                ? editor.chain().focus().setTextColor(color).run()
                : editor.chain().focus().setHighlightColor(color).run()
            }
          >
            {kind === 'text' ? 'A' : ''}
          </button>
        ))}
        <CustomColorPicker
          key={`${kind}-${value ?? 'default'}`}
          value={value}
          palette={kind === 'text' ? TEXT_HEX : BACKGROUND_HEX}
          fallback={kind === 'text' ? TEXT_HEX.gray : BACKGROUND_HEX.yellow}
          label={customLabel}
          onChange={(hex) =>
            kind === 'text'
              ? editor.chain().focus().setTextColor(hex).run()
              : editor.chain().focus().setHighlightColor(hex).run()
          }
        />
      </div>
    );
  };
  return (
    <div className="color-panel" onKeyDown={(event) => event.key === 'Escape' && onDone()}>
      <span className="color-panel-label">{t('slash.items.text.title')}</span>
      {row('text')}
      <span className="color-panel-label">{t('editor.highlight')}</span>
      {row('bg')}
      <span className="color-panel-label">{t('editor.blockBackground')}</span>
      <div className="color-row" role="group" aria-label={t('editor.blockBackground')}>
        <button
          type="button"
          className={`color-dot default${current.blockBackground === null ? ' is-active' : ''}`}
          title={t('editor.noBlockBackground')}
          aria-label={t('editor.noBlockBackground')}
          aria-pressed={current.blockBackground === null}
          disabled={!current.canSetBlockBackground}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setCurrentBlockBackground(null)}
        />
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-dot bg-${color}${current.blockBackground === color ? ' is-active' : ''}`}
            title={t('editor.colourBlockBackground', { colour: colorLabel(color) })}
            aria-label={t('editor.colourBlockBackground', { colour: colorLabel(color) })}
            aria-pressed={current.blockBackground === color}
            disabled={!current.canSetBlockBackground}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCurrentBlockBackground(color)}
          />
        ))}
        <CustomColorPicker
          key={`block-${current.blockBackground ?? 'default'}`}
          value={current.blockBackground}
          palette={BACKGROUND_HEX}
          fallback={BACKGROUND_HEX.yellow}
          label={t('editor.customBlockBackgroundColor')}
          disabled={!current.canSetBlockBackground}
          onChange={setCurrentBlockBackground}
        />
      </div>
    </div>
  );
}

export function FormattingMenu({ editor }: { editor: Editor }) {
  const [editingLink, setEditingLink] = useState(false);
  const [coloring, setColoring] = useState(false);
  const marks = useMarks(editor);
  const [options] = useState(
    () =>
      ({
        placement: 'top',
        offset: 8,
        flip: true,
        shift: { padding: 8 },
        onHide: () => {
          setEditingLink(false);
          setColoring(false);
        },
      }) as const,
  );

  useEffect(() => {
    // capture the node now, the editor can be destroyed before this cleanup runs
    const dom = editor.view.dom;
    const open = () => setEditingLink(true);
    dom.addEventListener('morrow:edit-link', open);
    return () => dom.removeEventListener('morrow:edit-link', open);
  }, [editor]);

  return (
    <BubbleMenu editor={editor} pluginKey="formattingMenu" options={options} shouldShow={showFormatting}>
      <div className="toolbar popover" role="toolbar" aria-label={t('editor.formattingAria')}>
        {editingLink ? (
          <LinkInput editor={editor} onDone={() => setEditingLink(false)} />
        ) : coloring ? (
          <ColorPanel editor={editor} onDone={() => setColoring(false)} />
        ) : (
          <>
            <ToolButton
              label={t('editor.bold')}
              icon={Bold}
              shortcut="Mod+B"
              active={marks.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <ToolButton
              label={t('editor.italic')}
              icon={Italic}
              shortcut="Mod+I"
              active={marks.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <ToolButton
              label={t('editor.underline')}
              icon={Underline}
              shortcut="Mod+U"
              active={marks.underline}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            />
            <ToolButton
              label={t('editor.strikethrough')}
              icon={Strikethrough}
              shortcut="Mod+Shift+S"
              active={marks.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            />
            <ToolButton
              label={t('editor.code')}
              icon={Code}
              shortcut="Mod+E"
              active={marks.code}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            <ToolButton
              label={t('editor.highlight')}
              icon={Highlighter}
              shortcut="Mod+Shift+H"
              active={marks.highlight}
              onClick={() => editor.chain().focus().toggleHighlight().run()}
            />
            <ToolButton label={t('editor.colour')} icon={Palette} onClick={() => setColoring(true)} />
            <span className="toolbar-divider" />
            <ToolButton
              label={t('editor.link')}
              icon={Link2}
              shortcut="Mod+K"
              active={marks.link}
              onClick={() => setEditingLink(true)}
            />
            <span className="toolbar-divider" />
            <ToolButton
              label={t('slash.items.h1.title')}
              icon={Heading1}
              active={marks.h1}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            />
            <ToolButton
              label={t('slash.items.h2.title')}
              icon={Heading2}
              active={marks.h2}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            />
            <ToolButton
              label={t('slash.items.h3.title')}
              icon={Heading3}
              active={marks.h3}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            />
            <ToolButton
              label={t('slash.items.h4.title')}
              icon={Heading4}
              active={marks.h4}
              onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
            />
            <ToolButton
              label={t('slash.items.h5.title')}
              icon={Heading5}
              active={marks.h5}
              onClick={() => editor.chain().focus().toggleHeading({ level: 5 }).run()}
            />
            <ToolButton
              label={t('slash.items.h6.title')}
              icon={Heading6}
              active={marks.h6}
              onClick={() => editor.chain().focus().toggleHeading({ level: 6 }).run()}
            />
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

export function LinkMenu({ editor }: { editor: Editor }) {
  const [editing, setEditing] = useState(false);
  const { href } = useMarks(editor);
  const [options] = useState(
    () => ({ placement: 'bottom-start', offset: 6, flip: true, onHide: () => setEditing(false) }) as const,
  );
  return (
    <BubbleMenu editor={editor} pluginKey="linkMenu" options={options} shouldShow={showLink}>
      <div className="toolbar popover link-popover">
        {editing ? (
          <LinkInput editor={editor} onDone={() => setEditing(false)} />
        ) : (
          <>
            <button
              type="button"
              className="link-preview"
              title={href}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => openHref(href)}
            >
              {href.replace(/^https?:\/\//, '').replace(/^#\/page\/.*/, t('editor.morrowPage'))}
            </button>
            <ToolButton label={t('editor.openLink')} icon={ExternalLink} onClick={() => openHref(href)} />
            <ToolButton
              label={t('editor.copyLink')}
              icon={Copy}
              onClick={() =>
                void copyText(href).then((copied) =>
                  copied
                    ? toast(t('editor.linkCopied'), { durationMs: 2000 })
                    : toast(t('editor.couldNotCopy'), { tone: 'error' }),
                )
              }
            />
            <ToolButton label={t('editor.editLink')} icon={Pencil} onClick={() => setEditing(true)} />
            <ToolButton
              label={t('editor.removeLink')}
              icon={Link2Off}
              onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
            />
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

export function TableMenu({ editor }: { editor: Editor }) {
  const reference = useCallback(() => {
    const table = findParentNode((node) => node.type.name === 'table')(editor.state.selection);
    const dom = table ? (editor.view.nodeDOM(table.pos) as HTMLElement | null) : null;
    return dom ? { getBoundingClientRect: () => dom.getBoundingClientRect() } : null;
  }, [editor]);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      options={TABLE_OPTIONS}
      getReferencedVirtualElement={reference}
      shouldShow={showTable}
    >
      <div className="toolbar popover table-toolbar" role="toolbar" aria-label={t('slash.items.table.title')}>
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().addRowAfter().run()}
        >
          {t('editor.addRow')}
        </button>
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          {t('editor.addColumn')}
        </button>
        <span className="toolbar-divider" />
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          {t('editor.deleteRow')}
        </button>
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          {t('editor.deleteColumn')}
        </button>
        <span className="toolbar-divider" />
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        >
          {t('editor.headerRow')}
        </button>
        <button
          type="button"
          className="text-tool"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
        >
          {t('editor.headerColumn')}
        </button>
        <button
          type="button"
          className="text-tool is-danger"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          {t('editor.deleteTable')}
        </button>
      </div>
    </BubbleMenu>
  );
}

// a short id for a block, only needs to be unique within its page
function newBlockId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// copies a [[link]] to one block: a heading by its text, anything else by a ^id written after it,
// the same way obsidian links blocks, so the link works in both apps
function copyBlockLink(editor: Editor, pos: number, pageTitle: string): void {
  const block = editor.state.doc.nodeAt(pos);
  if (!block) return;
  let anchor: string;
  if (block.type.name === 'heading') anchor = block.textContent.trim();
  else {
    // a list item's id belongs to its first paragraph
    const at = block.type.name === 'paragraph' ? pos : pos + 1;
    const paragraph = editor.state.doc.nodeAt(at);
    if (paragraph?.type.name !== 'paragraph' || !paragraph.textContent.trim()) return;
    let id = typeof paragraph.attrs.blockId === 'string' ? paragraph.attrs.blockId : '';
    if (!id) {
      id = newBlockId();
      editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...paragraph.attrs, blockId: id }));
    }
    anchor = `^${id}`;
  }
  const link = `[[${pageTitle.replace(/[[\]|#^]/g, ' ').trim()}#${anchor}]]`;
  void copyText(link).then((copied) =>
    copied ? toast(t('editor.blockLinkCopied')) : toast(t('editor.couldNotCopy'), { tone: 'error' }),
  );
}

// blocks that can be linked to on their own
function linkable(editor: Editor, pos: number): boolean {
  const block = editor.state.doc.nodeAt(pos);
  if (!block || !block.textContent.trim()) return false;
  if (block.type.name === 'heading' || block.type.name === 'paragraph') return true;
  return (
    (block.type.name === 'listItem' || block.type.name === 'taskItem') &&
    block.firstChild?.type.name === 'paragraph'
  );
}

function CustomBlockBackgroundRow({
  initialColor,
  onApply,
  onClear,
  onCancel,
}: {
  initialColor: ColorValue | null;
  onApply: (color: ColorValue) => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const initialRef = useRef(initialColor);
  const isCustomHex = validHexColor(initialColor) !== null;
  const [draft, setDraft] = useState(isCustomHex ? String(initialColor) : '#ffd580');
  const valid = validHexColor(draft);

  const handleCancel = () => {
    if (initialRef.current !== null) {
      onApply(initialRef.current);
    } else {
      onClear();
    }
    onCancel();
  };

  return (
    <div
      className="menu-custom-color-row"
      role="group"
      aria-label={t('editor.customBlockBackgroundColor')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          handleCancel();
        } else if (e.key === 'Enter') {
          e.stopPropagation();
          if (valid) onApply(valid);
        }
      }}
    >
      <input
        type="color"
        aria-label={t('editor.customBlockBackgroundColor')}
        value={valid ?? '#ffd580'}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = validHexColor(e.target.value);
          if (v) onApply(v);
        }}
      />
      <input
        className="color-hex-input"
        type="text"
        aria-label={t('editor.hexColorFor', { target: t('editor.blockBackground') })}
        aria-invalid={valid === null}
        value={draft}
        placeholder="#RRGGBB"
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = validHexColor(e.target.value);
          if (v) onApply(v);
        }}
      />
      <button
        type="button"
        title={t('editor.clearColor')}
        aria-label={t('editor.clearColor')}
        onClick={() => {
          onClear();
        }}
      >
        {t('editor.clearColor')}
      </button>
      <button
        type="button"
        title={t('common.cancel')}
        aria-label={t('common.cancel')}
        onClick={handleCancel}
      >
        {t('common.cancel')}
      </button>
    </div>
  );
}

function setBlockBackground(editor: Editor, pos: number, color: ColorValue | null): void {
  if (!editor.isEditable) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockBackground: color });
  editor.view.dispatch(tr.scrollIntoView());
}

// blocks the handle menu can turn into something else, including collapsible inline tables
const TURNABLE = new Set(['listItem', 'taskItem', 'blockquote', 'details', 'table', 'linkedDatabaseView']);
function turnable(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name === 'linkedDatabaseView')
    return !!node.attrs.view && typeof node.attrs.view === 'object';
  return !!node && (node.isTextblock || TURNABLE.has(node.type.name));
}

// the first place to type inside the block at pos
function firstTextPosition(editor: Editor, pos: number): number | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  if (node.isTextblock) return pos + 1;
  let found: number | null = null;
  node.descendants((child, offset) => {
    if (found !== null) return false;
    if (child.isTextblock) found = pos + 1 + offset + 1;
    return found === null;
  });
  return found;
}

function turnListItemSafely(editor: Editor, pos: number, target: TurnTarget): boolean {
  const item = editor.state.doc.nodeAt(pos);
  if (!item || !['listItem', 'taskItem'].includes(item.type.name)) return false;
  const line = item.firstChild;
  if (!line?.isTextblock) return turnListItem(editor, pos, target);

  const rawId = line.attrs.blockId;
  const blockId =
    typeof rawId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(rawId) ? rawId : null;
  const itemBackground = validBlockBackground(item.attrs.blockBackground);
  const lineBackground = validBlockBackground(line.attrs.blockBackground);
  const blockBackground = lineBackground ?? itemBackground;
  // These targets have no Markdown representation for a block id, so keep the source item intact.
  if (blockId && (target.kind === 'heading' || target.kind === 'codeBlock')) return true;
  if (
    itemBackground &&
    lineBackground &&
    itemBackground !== lineBackground &&
    target.kind !== 'toggle' &&
    target.kind !== 'blockquote' &&
    !['bulletList', 'orderedList', 'taskList'].includes(target.kind)
  )
    return true;
  if (!turnListItem(editor, pos, target)) return false;

  const { $from } = editor.state.selection;
  const tr = editor.state.tr;
  if (['bulletList', 'orderedList', 'taskList'].includes(target.kind)) {
    if (itemBackground) {
      for (let depth = $from.depth; depth > 0; depth--) {
        if (['listItem', 'taskItem'].includes($from.node(depth).type.name)) {
          const itemPos = $from.before(depth);
          const convertedItem = tr.doc.nodeAt(itemPos);
          if (convertedItem)
            tr.setNodeMarkup(itemPos, undefined, {
              ...convertedItem.attrs,
              blockBackground: itemBackground,
            });
          break;
        }
      }
    }
    if (tr.docChanged) editor.view.dispatch(tr);
    return true;
  }
  if (target.kind === 'toggle') {
    let detailsPos: number | null = null;
    let summaryPos: number | null = null;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === 'details') {
        detailsPos = $from.before(depth);
        summaryPos = detailsPos + 1;
        break;
      }
    }
    const details = detailsPos === null ? null : tr.doc.nodeAt(detailsPos);
    const summary = summaryPos === null ? null : tr.doc.nodeAt(summaryPos);
    if (details && (blockId || itemBackground) && detailsPos !== null) {
      tr.setNodeMarkup(detailsPos, undefined, {
        ...details.attrs,
        ...(blockId ? { blockId } : {}),
        ...(itemBackground ? { blockBackground: itemBackground } : {}),
      });
    }
    if (summary && lineBackground && summaryPos !== null) {
      tr.setNodeMarkup(summaryPos, undefined, { ...summary.attrs, blockBackground: lineBackground });
    }
  } else {
    const node = $from.parent;
    const nodePos = $from.before();
    const targetBackground = target.kind === 'blockquote' ? lineBackground : blockBackground;
    if (node && (targetBackground || (blockId && 'blockId' in node.attrs))) {
      tr.setNodeMarkup(nodePos, undefined, {
        ...node.attrs,
        ...(targetBackground ? { blockBackground: targetBackground } : {}),
        ...(blockId && 'blockId' in node.attrs ? { blockId } : {}),
      });
    }
    if (target.kind === 'blockquote' && itemBackground) {
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === 'blockquote') {
          const quotePos = $from.before(depth);
          const quote = tr.doc.nodeAt(quotePos);
          if (quote)
            tr.setNodeMarkup(quotePos, undefined, { ...quote.attrs, blockBackground: itemBackground });
          break;
        }
      }
    }
  }
  if (tr.docChanged) editor.view.dispatch(tr);
  return true;
}

// turns one block into another the way notion does: the block is first taken out of its list or quote, so a
// single list item changes on its own and a line inside a toggle stays in the toggle
function turnInto(editor: Editor, pos: number, target: TurnTarget): void {
  if (!editor.isEditable) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  if (turnListItemSafely(editor, pos, target)) return;
  if (target.kind === 'toggle') {
    if (node.type.name === 'heading') {
      const tr = editor.state.tr;
      if (setHeadingCollapsible(tr, pos, true)) editor.view.dispatch(tr.scrollIntoView());
      return;
    }
    if (node.type.name === 'table') {
      const tr = editor.state.tr;
      const source = tr.doc.nodeAt(pos);
      const label = tr.doc.type.schema.text(t('slash.items.table.title'));
      if (
        source &&
        wrapBlockInDetails(tr, pos, Fragment.from(label), Fragment.from(source), {}, { tableToggleTitle: label.text })
      ) {
        tr.setSelection(TextSelection.create(tr.doc, pos + 2 + label.nodeSize));
        editor.view.dispatch(tr.scrollIntoView());
      }
      return;
    }
    if (node.type.name === 'linkedDatabaseView') {
      const view = node.attrs.view;
      if (!view || typeof view !== 'object') return;
      const collapseEnabled = (view as { collapseEnabled?: boolean }).collapseEnabled !== false;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          view: withLinkedViewCollapseEnabled(view, !collapseEnabled),
        }),
      );
      return;
    }
    if (node.type.name === 'details') return;
    const at = firstTextPosition(editor, pos);
    if (at === null) return;
    const line = editor.state.doc.resolve(at).parent;
    if (!line.isTextblock || line.type.name === 'codeBlock') return;
    const start = editor.state.doc.resolve(at).before();
    const placeholder = editor.state.schema.nodes.paragraph?.create();
    if (!placeholder) return;
    const tr = editor.state.tr;
    const summaryAttrs = {
      ...(validBlockBackground(line.attrs.blockBackground)
        ? { blockBackground: validBlockBackground(line.attrs.blockBackground) }
        : {}),
      ...(target.level ? { level: target.level } : {}),
    };
    if (wrapBlockInDetails(tr, start, line.content, Fragment.from(placeholder), summaryAttrs)) {
      tr.setSelection(TextSelection.create(tr.doc, start + 2 + line.content.size));
      editor.view.dispatch(tr.scrollIntoView());
    }
    return;
  }
  if (node.type.name === 'details' && target.kind === 'paragraph') {
    const tr = editor.state.tr;
    if (unwrapDetailsToParagraph(tr, pos)) {
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
      editor.view.dispatch(tr.scrollIntoView());
    }
    return;
  }
  if (node.type.name === 'details') {
    // a toggle opens up into its title as a line followed by what was folded inside it
    const summary = firstTextPosition(editor, pos);
    if (summary === null) return;
    const folded = node.lastChild;
    const empty =
      folded?.childCount === 1 && folded.firstChild!.isTextblock && !folded.firstChild!.content.size;
    editor.chain().setTextSelection(summary).unsetDetails().run();
    // nothing was folded inside, so its empty line goes with it
    const title = editor.state.doc.nodeAt(pos);
    if (empty && title) {
      const after = pos + title.nodeSize;
      const line = editor.state.doc.nodeAt(after);
      if (line) editor.commands.deleteRange({ from: after, to: after + line.nodeSize });
    }
  }
  const at = firstTextPosition(editor, pos);
  if (at === null) return;
  const chain = editor.chain().focus().setTextSelection(at).clearNodes();
  switch (target.kind) {
    case 'paragraph':
      chain.run();
      return;
    case 'heading':
      chain.setHeading({ level: target.level }).run();
      return;
    case 'bulletList':
      chain.toggleBulletList().run();
      return;
    case 'orderedList':
      chain.toggleOrderedList().run();
      return;
    case 'taskList':
      chain.toggleTaskList().run();
      return;
    case 'blockquote':
      chain.setBlockquote().run();
      return;
    case 'codeBlock':
      chain.setCodeBlock().run();
      return;
  }
}

// several blocks picked in the margin turn one by one from the last, so the ones before keep their place.
// a list stands for its items, each of them turns the way one item on its own would
function turnBlocks(editor: Editor, range: BlockRange, target: TurnTarget): void {
  const positions: Array<{ node: ProseMirrorNode; pos: number }> = [];
  editor.state.doc.forEach((node, pos) => {
    if (pos < range.from || pos + node.nodeSize > range.to) return;
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type.name)) {
      node.forEach((item, offset) => {
        if (item.type.name === 'listItem' || item.type.name === 'taskItem')
          positions.push({ node: item, pos: pos + 1 + offset });
      });
      return;
    }
    // These blocks contain their own document or data and are not text containers for bulk conversion.
    if (['table', 'linkedDatabaseView', 'columns'].includes(node.type.name)) {
      if (target.kind === 'toggle' && node.type.name !== 'columns') positions.push({ node, pos });
      return;
    }
    positions.push({ node, pos });
  });
  // lines becoming a list join into one list rather than a list each
  const list = target.kind === 'bulletList' || target.kind === 'orderedList' || target.kind === 'taskList';
  for (const { node, pos } of positions.reverse()) {
    if (isTableToggle(node) && target.kind !== 'paragraph') continue;
    turnInto(editor, pos, target);
    if (!list) continue;
    const { state } = editor;
    const $at = state.doc.resolve(Math.min(pos, state.doc.content.size));
    const index = $at.index(0);
    const here = state.doc.maybeChild(index);
    const next = state.doc.maybeChild(index + 1);
    if (here && next && here.type === next.type && here.type.name === target.kind)
      editor.view.dispatch(state.tr.join($at.posAtIndex(index + 1, 0)));
  }
}

export function BlockMenu({
  editor,
  request,
  pageTitle,
  onClose,
}: {
  editor: Editor;
  request: BlockMenuRequest;
  pageTitle: string;
  onClose: () => void;
}) {
  const picked = selectedBlocks(editor.state);
  const pickedRange = picked && request.pos >= picked.from && request.pos < picked.to ? picked : null;
  let pickedCount = 0;
  if (pickedRange)
    editor.state.doc.forEach((node, pos) => {
      if (pos >= pickedRange.from && pos + node.nodeSize <= pickedRange.to) pickedCount++;
    });
  const singlePickedBlock =
    pickedRange && pickedCount === 1 ? editor.state.doc.nodeAt(pickedRange.from) : null;
  const singlePickedList =
    singlePickedBlock && ['bulletList', 'orderedList', 'taskList'].includes(singlePickedBlock.type.name);
  const multiSelection = Boolean(pickedRange && (pickedCount > 1 || singlePickedList));
  const range = pickedRange;
  const selectedBlock = multiSelection ? null : editor.state.doc.nodeAt(request.pos);
  const blockType = selectedBlock?.type.name;
  const selectedView = selectedBlock?.attrs.view as { collapseEnabled?: boolean } | null | undefined;
  const currentBackground = validBlockBackground(selectedBlock?.attrs.blockBackground);
  const turn = (target: TurnTarget) => () => {
    if (!editor.isEditable) return;
    if (multiSelection && range) turnBlocks(editor, range, target);
    else turnInto(editor, request.pos, target);
  };
  const allTurnEntries: MenuEntry[] = [
    { heading: t('editor.turnInto') },
    { label: t('slash.items.text.title'), icon: Pilcrow, onSelect: turn({ kind: 'paragraph' }) },
    ...([Heading1, Heading2, Heading3, Heading4, Heading5, Heading6] as const).map((icon, index) => {
      const level = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6;
      return { label: t(`slash.items.h${level}.title`), icon, onSelect: turn({ kind: 'heading', level }) };
    }),
    { label: t('slash.items.bullet.title'), icon: List, onSelect: turn({ kind: 'bulletList' }) },
    { label: t('slash.items.ordered.title'), icon: ListOrdered, onSelect: turn({ kind: 'orderedList' }) },
    { label: t('slash.items.task.title'), icon: ListChecks, onSelect: turn({ kind: 'taskList' }) },
    { label: t('slash.items.toggle.title'), icon: ChevronRight, onSelect: turn({ kind: 'toggle' }) },
    ...([1, 2, 3] as const).map((level) => ({
      label: t(`slash.items.toggleH${level}.title`),
      icon: ChevronRight,
      onSelect: turn({ kind: 'toggle', level }),
    })),
    { label: t('slash.items.quote.title'), icon: Quote, onSelect: turn({ kind: 'blockquote' }) },
    { label: t('slash.items.code.title'), icon: Code2, onSelect: turn({ kind: 'codeBlock' }) },
    { separator: true },
  ];
  const tableToggle = blockType === 'details' && isTableToggle(selectedBlock);
  const turnIntoEntries: MenuEntry[] = multiSelection
    ? allTurnEntries
    : blockType === 'table'
      ? [
          { heading: t('editor.turnInto') },
          {
            label: t('editor.makeTableCollapsible'),
            icon: ChevronRight,
            onSelect: turn({ kind: 'toggle' }),
          },
          { separator: true },
        ]
      : blockType === 'linkedDatabaseView'
        ? [
            { heading: t('editor.turnInto') },
            {
              label:
                selectedView?.collapseEnabled === false
                  ? t('editor.makeTableCollapsible')
                  : t('editor.removeTableCollapse'),
              icon: ChevronRight,
              onSelect: () => {
                if (!editor.isEditable) return;
                const node = editor.state.doc.nodeAt(request.pos);
                const view = node?.attrs.view;
                if (!node || node.type.name !== 'linkedDatabaseView' || !view || typeof view !== 'object')
                  return;
                const collapseEnabled =
                  (view as { collapseEnabled?: boolean }).collapseEnabled !== false;
                editor.view.dispatch(
                  editor.state.tr.setNodeMarkup(request.pos, undefined, {
                    ...node.attrs,
                    view: withLinkedViewCollapseEnabled(view, !collapseEnabled),
                  }),
                );
              },
            },
            { separator: true },
          ]
        : tableToggle
          ? [
              { heading: t('editor.turnInto') },
              {
                label: t('editor.removeTableCollapse'),
                icon: ChevronDown,
                onSelect: turn({ kind: 'paragraph' }),
              },
              { separator: true },
            ]
          : [
            { heading: t('editor.turnInto') },
            {
              label:
                blockType === 'details'
                  ? t('editor.disableCollapsible')
                  : t('slash.items.text.title'),
              icon: blockType === 'details' ? ChevronDown : Pilcrow,
              onSelect: turn({ kind: 'paragraph' }),
            },
            ...([Heading1, Heading2, Heading3, Heading4, Heading5, Heading6] as const).map((icon, index) => {
              const level = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6;
              return {
                label: t(`slash.items.h${level}.title`),
                icon,
                onSelect: turn({ kind: 'heading', level }),
              };
            }),
            { label: t('slash.items.bullet.title'), icon: List, onSelect: turn({ kind: 'bulletList' }) },
            { label: t('slash.items.ordered.title'), icon: ListOrdered, onSelect: turn({ kind: 'orderedList' }) },
            { label: t('slash.items.task.title'), icon: ListChecks, onSelect: turn({ kind: 'taskList' }) },
            ...(blockType === 'heading' || blockType === 'details'
              ? []
              : [
                  {
                    label: t('editor.enableCollapsible'),
                    icon: ChevronRight,
                    onSelect: turn({ kind: 'toggle' }),
                  },
                ]),
            ...(blockType === 'heading' || blockType === 'details'
              ? []
              : ([1, 2, 3] as const).map((level) => ({
                  label: t(`slash.items.toggleH${level}.title`),
                  icon: ChevronRight,
                  onSelect: turn({ kind: 'toggle', level }),
                }))),
            { label: t('slash.items.quote.title'), icon: Quote, onSelect: turn({ kind: 'blockquote' }) },
            { label: t('slash.items.code.title'), icon: Code2, onSelect: turn({ kind: 'codeBlock' }) },
            { separator: true },
          ];
  const blockBackgroundEntries: MenuEntry[] = multiSelection
    ? []
    : [
        { heading: t('editor.blockBackground') },
        {
          label: t('editor.noBlockBackground'),
          swatch: 'transparent',
          checked: currentBackground === null,
          onSelect: () => setBlockBackground(editor, request.pos, null),
        },
        ...COLORS.map((color) => ({
          label: t('editor.colourBlockBackground', { colour: colorLabel(color) }),
          swatch: BACKGROUND_HEX[color],
          checked: currentBackground === color,
          onSelect: () => setBlockBackground(editor, request.pos, color),
        })),
        {
          custom: (
            <CustomBlockBackgroundRow
              initialColor={currentBackground}
              onApply={(color) => setBlockBackground(editor, request.pos, color)}
              onClear={() => setBlockBackground(editor, request.pos, null)}
              onCancel={onClose}
            />
          ),
        },
      ];
  const moveEntries: MenuEntry[] = multiSelection
    ? []
    : [
        { separator: true as const },
        {
          label: t('editor.moveUp'),
          icon: ArrowUp,
          shortcut: formatShortcut('Alt+Shift+↑'),
          onSelect: () => {
            if (editor.isEditable) moveBlock(editor.state, editor.view.dispatch, -1);
          },
        },
        {
          label: t('editor.moveDown'),
          icon: ArrowDown,
          shortcut: formatShortcut('Alt+Shift+↓'),
          onSelect: () => {
            if (editor.isEditable) moveBlock(editor.state, editor.view.dispatch, 1);
          },
        },
      ];
  const blockLinkEntries: MenuEntry[] =
    !multiSelection && linkable(editor, request.pos)
      ? [
          {
            label: t('editor.copyLinkToBlock'),
            icon: Link2,
            onSelect: () => copyBlockLink(editor, request.pos, pageTitle),
          },
        ]
      : [];
  const entries: MenuEntry[] = [
    ...turnIntoEntries,
    ...blockBackgroundEntries,
    ...moveEntries,
    ...blockLinkEntries,
    {
      label: t('editor.duplicate'),
      icon: Copy,
      onSelect: () => {
        if (!editor.isEditable) return;
        if (range) {
          const blocks = editor.state.doc.slice(range.from, range.to).content;
          editor.view.dispatch(editor.state.tr.insert(range.to, blocks));
          clearBlockSelection(editor);
          return;
        }
        const node = editor.state.doc.nodeAt(request.pos);
        if (node)
          editor
            .chain()
            .focus()
            .insertContentAt(request.pos + node.nodeSize, node.toJSON())
            .run();
      },
    },
    {
      label: t('editor.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        if (!editor.isEditable) return;
        if (range) {
          editor.chain().focus().deleteRange(range).run();
          return;
        }
        const node = editor.state.doc.nodeAt(request.pos);
        if (node)
          editor
            .chain()
            .focus()
            .deleteRange({ from: request.pos, to: request.pos + node.nodeSize })
            .run();
      },
    },
  ];
  const fileId = selectedBlock?.attrs.fileId as string | null | undefined;
  const vault = desktop?.vault;
  if (blockType === 'heading') {
    const isCollapsible = Boolean(selectedBlock?.attrs.collapsible);
    const isCollapsed = Boolean(selectedBlock?.attrs.collapsed);
    const headingLevel = (Math.min(6, Math.max(1, Number(selectedBlock?.attrs.level) || 1)) as 1 | 2 | 3 | 4 | 5 | 6);
    entries.unshift(
      { heading: t(`slash.items.h${headingLevel}.title`) },
      isCollapsible
        ? {
            label: t('editor.disableCollapsible'),
            icon: ChevronDown,
            onSelect: () => {
              if (!editor.isEditable) return;
              const tr = editor.state.tr;
              if (setHeadingCollapsible(tr, request.pos, false)) editor.view.dispatch(tr.scrollIntoView());
            },
          }
        : {
            label: t('editor.enableCollapsible'),
            icon: ChevronRight,
            onSelect: () => {
              if (!editor.isEditable) return;
              const tr = editor.state.tr;
              if (setHeadingCollapsible(tr, request.pos, true)) editor.view.dispatch(tr.scrollIntoView());
            },
          },
      ...(isCollapsible
        ? [
            {
              label: t(isCollapsed ? 'editor.unfoldSection' : 'editor.foldSection'),
              icon: ChevronRight,
              checked: isCollapsed,
              onSelect: () => {
                toggleSectionCollapsed(editor.view, request.pos);
              },
            },
          ]
        : []),
      { separator: true },
    );
  }
  if (blockType === 'image') {
    entries.unshift(
      { heading: t('slash.items.image.title') },
      {
        label: t('editor.replaceImage'),
        icon: RefreshCw,
        onSelect: () => {
          const dom = editor.view.nodeDOM(request.pos);
          if (dom instanceof HTMLElement) {
            dom.dispatchEvent(new CustomEvent('morrow:image-replace'));
          }
        },
      },
      {
        label: t('editor.editCaption'),
        icon: MessageSquare,
        onSelect: () => {
          setTimeout(() => {
            const dom = editor.view.nodeDOM(request.pos);
            if (dom instanceof HTMLElement) {
              const input = dom.querySelector<HTMLInputElement>('.image-caption-input');
              if (input) {
                input.style.display = 'block';
                input.focus();
                input.select();
              }
            }
          }, 50);
        },
      },
      {
        label: t('editor.alignLeft'),
        icon: AlignLeft,
        checked: (selectedBlock?.attrs.align || 'center') === 'left',
        onSelect: () => {
          const node = editor.state.doc.nodeAt(request.pos);
          if (node) {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(request.pos, undefined, { ...node.attrs, align: 'left' }),
            );
          }
        },
      },
      {
        label: t('editor.alignCenter'),
        icon: AlignCenter,
        checked: (selectedBlock?.attrs.align || 'center') === 'center',
        onSelect: () => {
          const node = editor.state.doc.nodeAt(request.pos);
          if (node) {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(request.pos, undefined, { ...node.attrs, align: 'center' }),
            );
          }
        },
      },
      {
        label: t('editor.alignRight'),
        icon: AlignRight,
        checked: (selectedBlock?.attrs.align || 'center') === 'right',
        onSelect: () => {
          const node = editor.state.doc.nodeAt(request.pos);
          if (node) {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(request.pos, undefined, { ...node.attrs, align: 'right' }),
            );
          }
        },
      },
      {
        label: t('editor.cropImage'),
        icon: Crop,
        onSelect: () => {
          const dom = editor.view.nodeDOM(request.pos);
          if (dom instanceof HTMLElement) {
            dom.dispatchEvent(new CustomEvent('morrow:image-crop'));
          }
        },
      },
      ...(selectedBlock?.attrs.crop
        ? [
            {
              label: t('editor.resetCrop'),
              icon: RotateCcw,
              onSelect: () => {
                const node = editor.state.doc.nodeAt(request.pos);
                if (node) {
                  editor.view.dispatch(
                    editor.state.tr.setNodeMarkup(request.pos, undefined, { ...node.attrs, crop: null }),
                  );
                }
              },
            },
          ]
        : []),
      ...(fileId
        ? [
            { label: t('editor.copyImage'), icon: ImageIcon, onSelect: () => void copyImageFile(fileId) },
            { label: t('editor.saveACopy'), icon: Download, onSelect: () => void downloadFile(fileId) },
            ...(vault
              ? [
                  {
                    label: t('editor.openInDefaultApp'),
                    icon: ExternalLink,
                    onSelect: () => void vault.openFile(fileId),
                  },
                  {
                    label: t('pageMenu.showInFolder'),
                    icon: FolderOpen,
                    onSelect: () => void vault.reveal(fileId),
                  },
                ]
              : []),
          ]
        : []),
      { separator: true },
    );
  }
  if (blockType === 'callout') {
    const tone = (value: string, label: string): MenuEntry => ({
      label,
      icon: Info,
      checked: editor.state.doc.nodeAt(request.pos)?.attrs.tone === value,
      onSelect: () => {
        // the obsidian type follows the colour, so the icon and the file agree with what is shown
        editor
          .chain()
          .focus()
          .setNodeSelection(request.pos)
          .updateAttributes('callout', { tone: value, kind: value })
          .run();
      },
    });
    const callout = editor.state.doc.nodeAt(request.pos);
    const setIcon = (icon: string | null) =>
      editor.chain().focus().setNodeSelection(request.pos).updateAttributes('callout', { icon }).run();
    const hidden = callout?.attrs.icon === 'none';
    entries.unshift(
      { heading: t('editor.callout') },
      tone('note', t('editor.note')),
      tone('tip', t('editor.tip')),
      tone('warning', t('editor.warning')),
      tone('danger', t('editor.danger')),
      { separator: true },
      {
        label: t('editor.changeIcon'),
        icon: Smile,
        onSelect: () =>
          openDialog({
            kind: 'emoji',
            title: t('editor.calloutIcon'),
            current: hidden ? null : ((callout?.attrs.icon as string | null) ?? null),
            onPick: (icon) => setIcon(icon ?? 'none'),
          }),
      },
      hidden
        ? { label: t('editor.showIcon'), icon: Eye, onSelect: () => setIcon(null) }
        : { label: t('editor.removeIcon'), icon: EyeOff, onSelect: () => setIcon('none') },
      ...(callout?.attrs.title
        ? []
        : [
            {
              label: t('editor.addATitle'),
              icon: Type,
              onSelect: () => {
                editor.chain().setNodeSelection(request.pos).updateAttributes('callout', { title: '' }).run();
                // the menu hands focus back to the editor as it closes, the new title row takes it after
                setTimeout(() => {
                  const dom = editor.view.nodeDOM(request.pos);
                  if (dom instanceof HTMLElement)
                    dom.querySelector<HTMLInputElement>('.callout-title')?.focus();
                }, 50);
              },
            },
          ]),
      {
        separator: true,
      },
    );
  }
  const $pos = editor.state.doc.resolve(request.pos);
  let insideColumns = false;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'columns') {
      insideColumns = true;
      break;
    }
  }
  if (!multiSelection && selectedBlock?.type.name === 'columns') {
    insideColumns = true;
  }

  if (insideColumns) {
    entries.push(
      { separator: true },
      { heading: t('slash.items.columns2.title') },
      {
        label: t('editor.addColumnLeft'),
        icon: Columns2,
        onSelect: () => {
          editor.chain().focus().setNodeSelection(request.pos).addColumn('left').run();
        },
      },
      {
        label: t('editor.addColumnRight'),
        icon: Columns2,
        onSelect: () => {
          editor.chain().focus().setNodeSelection(request.pos).addColumn('right').run();
        },
      },
      {
        label: t('editor.resetColumnWidths'),
        icon: RotateCcw,
        onSelect: () => {
          editor.chain().focus().setNodeSelection(request.pos).resetColumnWidths().run();
        },
      },
    );
  } else if (!multiSelection && $pos.depth === 0 && blockType !== 'columns') {
    entries.push(
      { separator: true },
      {
        label: t('editor.splitIntoColumns'),
        icon: Columns2,
        onSelect: () => {
          editor.chain().focus().setNodeSelection(request.pos).splitIntoColumns(2).run();
        },
      },
    );
  }

  const textual = multiSelection || turnable(editor, request.pos);
  const firstTurnInto = entries.findIndex(
    (entry) => 'heading' in entry && entry.heading === t('editor.turnInto'),
  );
  const afterTurnInto = entries.findIndex((entry, index) => index > firstTurnInto && 'separator' in entry);
  const shown = textual
    ? entries
    : entries.filter((_entry, index) => index < firstTurnInto || index > afterTurnInto);
  return (
    <Menu
      anchor={request.trigger ?? request.rect}
      entries={shown}
      onClose={onClose}
      placement="left-start"
      label={t('editor.blockOptions')}
    />
  );
}
