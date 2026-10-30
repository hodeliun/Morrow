import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  ArchiveRestore,
  ArrowUpRight,
  Columns2,
  FileWarning,
  Image as ImageIcon,
  ListPlus,
  RotateCcw,
  SlidersHorizontal,
  Smile,
  Trash2,
  ChevronRight,
  ListTree,
} from 'lucide-react';
import { revealAncestorsForPosition } from '../editor/CollapsibleHeading';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { docToPlainText, findUnknownTypes, inlineText, isDocEmpty } from '../../core/doc';
import { backlinksTo, unlinkedMentions } from '../../core/links';
import { displayTitle, emptyDoc } from '../../core/model';
import type { DocNode, PageId, PageMeta } from '../../core/model';
import { childrenOf, isEffectivelyTrashed } from '../../core/tree';
import { findTemplatesPage } from '../../core/templates';
import { RepeatBar } from './RepeatBar';
import { findDatabaseOf } from '../../core/database';
import { basename, conflictOriginal, stripExtension } from '../../core/vault/paths';
import { PageEditor, pageEditorMatchesDocument } from '../editor/PageEditor';
import { SourceEditor } from './SourceEditor';
import { CoverBanner, CoverPicker } from './Cover';
import { NoteStylePopover } from './NoteStylePopover';
import { DailyNav, MadeThisDay } from './DailyNav';
import { PageGlyph } from './Emoji';
import { LockedPage } from './EncryptDialog';
import { PageProperties } from './PageProperties';
import { PageTags } from './TagsView';
import { deleteForever, restorePage, setArchived, trashPage } from '../operations';
import { legacyNoteStyle, usePreferences } from '../platform/preferences';
import { rememberScopedPlace, resolveReadingPlace, sessionReadingPlace } from '../readingPlace';
import { navigate, openPage, routeHash } from '../router';
import { getTabs, openSide, usePane, usePaneTabId } from '../tabs';
import { rememberTabScrollPosition, tabScrollPosition } from '../tabScroll';
import {
  shouldCancelPendingScrollRestoreForKeyboard,
  shouldCancelPendingScrollRestoreForPointer,
} from '../scrollRestoreIntent';
import { getUi, openDialog, setUi, useUi } from '../ui';
import { getSession, getState, run, useWorkspace } from '../workspace';
import type { MenuEntry } from './Menu';
import { getLocale, t } from '../i18n';
import { pageMenuEntries } from './pageMenu';
import { exactTime, relativeTime, useShowMore } from './primitives';
import { PageIcon } from './Sidebar';
import { TopBar } from './TopBar';

const EMPTY_DOC = emptyDoc();

// canvases and database views load the first time one is opened
const CanvasView = lazy(() => import('./CanvasView').then((module) => ({ default: module.CanvasView })));
const DatabaseView = lazy(() =>
  import('./database/DatabaseView').then((module) => ({ default: module.DatabaseView })),
);

// focuses right away, tiptap's own focus waits a frame and fast typing would land in the title
function focusStart(editor: Editor) {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.atStart(state.doc)));
  view.focus();
}

// enter in the title starts a new line at the top of the page, taking any title text after the cursor
function openFirstLine(editor: Editor, text: string) {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const first = state.doc.firstChild;
  if (!text && first?.type.name === 'paragraph' && first.content.size === 0) return focusStart(editor);
  const paragraph = state.schema.nodes.paragraph!.create(null, text ? state.schema.text(text) : null);
  const tr = state.tr.insert(0, paragraph);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView());
  view.focus();
}

// the first page shown after morrow opens also gets its cursor back, the way a document reopens
let firstPage = true;

export function PageView({ id, find, anchor }: { id: PageId; find: string | null; anchor?: string | null }) {
  const state = useWorkspace();
  const page = state.pages[id];
  const doc = state.docs[id] ?? EMPTY_DOC;
  const hasUnknownContent = useMemo(() => findUnknownTypes(doc).length > 0, [doc]);
  const activeTabId = usePaneTabId() ?? 'unassigned';
  const pane = usePane();
  const [editing, setEditing] = useState(false);
  const [coverPicker, setCoverPicker] = useState<HTMLElement | null>(null);
  const [stylePicker, setStylePicker] = useState<HTMLElement | null>(null);
  // the page whose header asked for a first property, so the request does not follow to another page
  const [addingFor, setAddingFor] = useState<PageId | null>(null);
  // a database with text of its own keeps showing it above its views, even once that text is cleared
  const [databaseTextFor, setDatabaseTextFor] = useState<PageId | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const vaultKey = getSession().location ?? '';
  const scrollIdentity = JSON.stringify([vaultKey, activeTabId, pane, id]);
  const scrollScopeRef = useRef({ tabId: activeTabId, pane, pageId: id, vaultKey });
  const scrollRestoreRef = useRef({
    identity: scrollIdentity,
    status: anchor || find ? 'explicit' : 'pending',
  });
  // enter in the title can arrive before the editor exists, focus it once it does
  const focusWhenReady = useRef(false);
  const requestRestoreRef = useRef<(() => void) | null>(null);
  const startupFocus = useRef(false);
  const prefs = usePreferences();
  const ui = useUi();

  useLayoutEffect(() => {
    const previous = scrollRestoreRef.current;
    const previousScope = scrollScopeRef.current;
    const nextScope = { tabId: activeTabId, pane, pageId: id, vaultKey };
    if (
      previousScope.tabId === activeTabId &&
      previousScope.pageId === id &&
      previousScope.vaultKey === vaultKey &&
      previousScope.pane !== pane &&
      !anchor &&
      !find
    ) {
      const position = tabScrollPosition(previousScope) ?? scrollRef.current?.scrollTop;
      if (position !== undefined) {
        rememberScopedPlace(nextScope, { ...sessionReadingPlace(previousScope), scroll: position });
      }
    }
    scrollScopeRef.current = nextScope;
    scrollRestoreRef.current = {
      identity: scrollIdentity,
      status:
        previous.identity === scrollIdentity
          ? anchor || find
            ? 'explicit'
            : previous.status
          : anchor || find
            ? 'explicit'
            : 'pending',
    };
  }, [activeTabId, pane, id, vaultKey, scrollIdentity, anchor, find]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const scope = { tabId: activeTabId, pane, pageId: id, vaultKey };
    const shouldRestore = scrollRestoreRef.current.status === 'pending';
    let fontsReady = !shouldRestore || !document.fonts || document.fonts.status === 'loaded';
    let restored = false;
    let selectionPrepared = false;
    const place = resolveReadingPlace(scope);
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const contentIsRendered = () => {
      if (scroller.querySelector('.banner.is-error, .locked-page')) return true;
      if (!fontsReady) return false;
      if (
        Array.from(scroller.querySelectorAll('img')).some(
          (image) => image.loading !== 'lazy' && !image.complete,
        )
      )
        return false;
      if (scroller.querySelector('.database[aria-busy="true"]')) return false;
      return Boolean(scroller.querySelector('.source-editor, .database, .editor-surface, .readonly-text'));
    };
    let userStarted = false;
    let canSave = false;
    let firstFrame = 0;
    let secondFrame = 0;

    const savePosition = () => {
      rememberTabScrollPosition(scope, scroller.scrollTop);
      canSave = true;
    };
    const onScroll = () => {
      if (userStarted || scrollRestoreRef.current.status === 'explicit') savePosition();
    };
    const cancelFramesAndTimer = () => {
      if (settleTimer) clearTimeout(settleTimer);
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      settleTimer = null;
      firstFrame = 0;
      secondFrame = 0;
    };
    const cancelPendingRestore = () => {
      if (userStarted) return;
      userStarted = true;
      if (
        scrollRestoreRef.current.identity === scrollIdentity &&
        scrollRestoreRef.current.status === 'pending'
      )
        scrollRestoreRef.current.status = 'cancelled';
      savePosition();
      cancelFramesAndTimer();
    };
    // Trusted input in the capture phase wins before editor/grid handlers; focus and programmatic scroll stay inert.
    const keyboardTargetIntent = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      const canEdit = Boolean(
        element &&
        (element.isContentEditable ||
          element.closest(
            '[contenteditable="true"], [contenteditable="plaintext-only"], .db-table td[data-row-id][data-col-id]',
          )),
      );
      const isTextControl = Boolean(
        element?.closest(
          'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled]), [role="combobox"], [role="textbox"]',
        ),
      );
      const preventsPageScroll = Boolean(element?.closest('input, textarea, select, [role="combobox"]'));
      return { canEdit, isTextControl, preventsPageScroll };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIntent = keyboardTargetIntent(event.target);
      if (
        shouldCancelPendingScrollRestoreForKeyboard({
          eventType: 'keydown',
          isTrusted: event.isTrusted,
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          altGraph: event.getModifierState('AltGraph'),
          isComposing: event.isComposing,
          targetCanEdit: targetIntent.canEdit,
          targetIsTextControl: targetIntent.isTextControl,
          targetPreventsPageScroll: targetIntent.preventsPageScroll,
        })
      ) {
        cancelPendingRestore();
      }
    };
    const onCompositionStart = (event: CompositionEvent) => {
      const targetIntent = keyboardTargetIntent(event.target);
      if (
        shouldCancelPendingScrollRestoreForKeyboard({
          eventType: 'compositionstart',
          isTrusted: event.isTrusted,
          key: '',
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          altGraph: false,
          isComposing: true,
          targetCanEdit: targetIntent.canEdit,
          targetIsTextControl: targetIntent.isTextControl,
          targetPreventsPageScroll: targetIntent.preventsPageScroll,
        })
      ) {
        cancelPendingRestore();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const gutter = scroller.offsetWidth - scroller.clientWidth;
      const rect = scroller.getBoundingClientRect();
      if (
        shouldCancelPendingScrollRestoreForPointer({
          isTrusted: event.isTrusted,
          targetIsPageContent: Boolean(
            target?.closest('.ProseMirror, .readonly-text, .source-editor, .database, .locked-page'),
          ),
          targetIsNavigationControl: Boolean(
            target?.closest('.page-outline-toggle, .page-outline, .heading-fold-btn'),
          ),
          targetIsInteractiveControl: Boolean(
            target?.closest(
              [
                'a[href]',
                'area[href]',
                'audio[controls]',
                'button',
                'input',
                'select',
                'summary',
                'textarea',
                'video[controls]',
                '[role="button"]',
                '[role="checkbox"]',
                '[role="combobox"]',
                '[role="gridcell"]',
                '[role="link"]',
                '[role="menuitem"]',
                '[role="menuitemcheckbox"]',
                '[role="menuitemradio"]',
                '[role="option"]',
                '[role="radio"]',
                '[role="scrollbar"]',
                '[role="slider"]',
                '[role="spinbutton"]',
                '[role="switch"]',
                '[role="tab"]',
                '[role="textbox"]',
                '[role="treeitem"]',
                '[tabindex]:not([tabindex="-1"])',
              ].join(', '),
            ),
          ),
          inScrollbarGutter: gutter > 0 && event.clientX >= rect.right - gutter,
        })
      ) {
        cancelPendingRestore();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.page-outline-toggle, .page-outline, .heading-fold-btn')) cancelPendingRestore();
    };
    const onImageSettled = () => scheduleRestore();

    const scheduleRestore = () => {
      if (
        cancelled ||
        restored ||
        userStarted ||
        scrollRestoreRef.current.identity !== scrollIdentity ||
        scrollRestoreRef.current.status !== 'pending' ||
        !contentIsRendered()
      )
        return;
      cancelFramesAndTimer();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (
          cancelled ||
          restored ||
          userStarted ||
          scrollRestoreRef.current.identity !== scrollIdentity ||
          scrollRestoreRef.current.status !== 'pending' ||
          !contentIsRendered()
        )
          return;
        // Let content hydrate before preparing selection, then let ProseMirror finish its
        // deferred focus synchronization before the final viewport restoration.
        if (!selectionPrepared) {
          const editor = editorRef.current;
          if (
            scroller.querySelector('.editor-surface') &&
            (!editor ||
              editor.isDestroyed ||
              !pageEditorMatchesDocument(editor, getState().docs[id] ?? EMPTY_DOC))
          )
            return;
          selectionPrepared = true;
          if (place && editor && !editor.isDestroyed) {
            const { doc: editorDoc, tr } = editor.state;
            const size = editorDoc.content.size;
            editor.view.dispatch(
              tr.setSelection(
                TextSelection.between(
                  editorDoc.resolve(Math.min(place.from, size)),
                  editorDoc.resolve(Math.min(place.to, size)),
                ),
              ),
            );
            const focused = document.activeElement;
            if (
              startupFocus.current &&
              getTabs().pane === pane &&
              (focused === document.body || focused === editor.view.dom) &&
              !getUi().dialog &&
              !getUi().palette &&
              !getUi().focusTitle
            )
              editor.view.dom.focus({ preventScroll: true });
            startupFocus.current = false;
          }
        }
        settleTimer = setTimeout(() => {
          settleTimer = null;
          firstFrame = requestAnimationFrame(() => {
            firstFrame = 0;
            if (
              cancelled ||
              restored ||
              userStarted ||
              scrollRestoreRef.current.identity !== scrollIdentity ||
              scrollRestoreRef.current.status !== 'pending' ||
              !contentIsRendered()
            )
              return;
            secondFrame = requestAnimationFrame(() => {
              secondFrame = 0;
              if (
                cancelled ||
                restored ||
                userStarted ||
                scrollRestoreRef.current.identity !== scrollIdentity ||
                scrollRestoreRef.current.status !== 'pending' ||
                !contentIsRendered()
              )
                return;
              restored = true;
              scrollRestoreRef.current.status = 'restored';
              scroller.scrollTop = place?.scroll ?? 0;
              observer?.disconnect();
              resizeObserver?.disconnect();
            });
          });
        }, 32);
      }, 120);
    };
    const resizeObserver = shouldRestore ? new ResizeObserver(scheduleRestore) : null;
    const observedSizeTargets = new WeakSet<Element>();
    const observeSizeTargets = () => {
      if (!resizeObserver) return;
      for (const element of [scroller, ...scroller.querySelectorAll('.page, .database')]) {
        if (observedSizeTargets.has(element)) continue;
        resizeObserver.observe(element);
        observedSizeTargets.add(element);
      }
    };
    const observer = shouldRestore
      ? new MutationObserver(() => {
          observeSizeTargets();
          scheduleRestore();
        })
      : null;
    requestRestoreRef.current = scheduleRestore;

    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', cancelPendingRestore, { passive: true });
    scroller.addEventListener('touchstart', cancelPendingRestore, { passive: true });
    scroller.addEventListener('pointerdown', onPointerDown, true);
    scroller.addEventListener('click', onClick, true);
    scroller.addEventListener('keydown', onKeyDown, true);
    scroller.addEventListener('compositionstart', onCompositionStart, true);
    scroller.addEventListener('load', onImageSettled, true);
    scroller.addEventListener('error', onImageSettled, true);
    if (observer) {
      observer.observe(scroller, {
        attributes: true,
        attributeFilter: ['aria-busy'],
        childList: true,
        subtree: true,
      });
      observeSizeTargets();
      if (document.fonts && !fontsReady) {
        void document.fonts.ready.then(() => {
          fontsReady = true;
          scheduleRestore();
        });
      }
      scheduleRestore();
    }

    return () => {
      cancelled = true;
      if (requestRestoreRef.current === scheduleRestore) requestRestoreRef.current = null;
      observer?.disconnect();
      resizeObserver?.disconnect();
      cancelFramesAndTimer();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', cancelPendingRestore);
      scroller.removeEventListener('touchstart', cancelPendingRestore);
      scroller.removeEventListener('pointerdown', onPointerDown, true);
      scroller.removeEventListener('click', onClick, true);
      scroller.removeEventListener('keydown', onKeyDown, true);
      scroller.removeEventListener('compositionstart', onCompositionStart, true);
      scroller.removeEventListener('load', onImageSettled, true);
      scroller.removeEventListener('error', onImageSettled, true);
      if (canSave && getTabs().tabs.some((tab) => tab.id === scope.tabId)) savePosition();
    };
  }, [activeTabId, pane, id, vaultKey, scrollIdentity, anchor, find]);

  // A local draft can reach the workspace without changing editor DOM.
  useEffect(() => {
    requestRestoreRef.current?.();
  }, [doc]);

  useEffect(() => {
    if (state.pages[id]) run({ type: 'page.markOpened', id, now: Date.now() });
    // only when a different page opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!page) {
    return (
      <div className="view">
        <TopBar />
        <div className="empty-state">
          <FileWarning size={28} strokeWidth={1.5} />
          <h1>{t('page.pageNotFoundTitle')}</h1>
          <p>{t('page.pageNotFoundBody')}</p>
          <button type="button" className="button" onClick={() => navigate({ name: 'home' })}>
            {t('page.goHome')}
          </button>
        </div>
      </div>
    );
  }

  const trashed = isEffectivelyTrashed(state.pages, id);
  const noteStyle = page.noteStyle ?? legacyNoteStyle(prefs.font, prefs.width);
  const unreadable = getSession().unreadable.has(id);
  const isTemplate = page.parentId !== null && page.parentId === findTemplatesPage(state)?.id;

  const menu = (): MenuEntry[] => {
    const words = docToPlainText(doc).split(/\s+/).filter(Boolean).length;
    const info: MenuEntry = {
      heading: t('pageMenu.infoHeading', {
        words: words.toLocaleString(getLocale()),
        time: relativeTime(page.createdAt),
      }),
      title: [
        t('topBar.created', { time: exactTime(page.createdAt) }),
        t('topBar.edited', { time: exactTime(page.updatedAt) }),
      ].join('\n'),
    };
    if (trashed) return [info];
    return [info, ...pageMenuEntries(id, () => titleRef.current?.focus())];
  };

  const hasText = page.kind === 'database' && !isDocEmpty(doc);
  if (hasText && databaseTextFor !== id) setDatabaseTextFor(id);
  const showText = page.kind !== 'database' || hasText || databaseTextFor === id;

  const database = findDatabaseOf(state, page);
  // rows and pages that already show properties add more from that list instead
  const canAddProperty =
    page.kind === 'page' &&
    !database &&
    !unreadable &&
    Object.keys(page.extra).length === 0 &&
    addingFor !== id;

  if (page.kind === 'canvas') {
    return (
      <div className="view">
        <TopBar page={page} editing={editing} menu={menu} />
        {trashed && (
          <div className="banner" role="note">
            <span>{t('page.canvasInTrash')}</span>
            <button
              type="button"
              className="button small"
              onClick={() => restorePage(findTrashedAncestor(state.pages, id) ?? id)}
            >
              <RotateCcw size={14} /> {t('page.restore')}
            </button>
          </div>
        )}
        {unreadable ? (
          <div className="banner is-error" role="alert">
            {t('page.canvasUnreadable')}
          </div>
        ) : (
          <Suspense fallback={<div className="canvas-view" aria-busy="true" />}>
            <CanvasView pageId={id} doc={state.docs[id]} editable={!trashed} />
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <div className="view">
      <TopBar page={page} editing={editing} menu={menu} />
      <div ref={scrollRef} className="page-scroll">
        {trashed && (
          <div className="banner" role="note">
            <span>{t('page.pageInTrash')}</span>
            <button
              type="button"
              className="button small"
              onClick={() => restorePage(findTrashedAncestor(state.pages, id) ?? id)}
            >
              <RotateCcw size={14} /> {t('page.restore')}
            </button>
            <button
              type="button"
              className="button small danger"
              onClick={() => deleteForever(findTrashedAncestor(state.pages, id) ?? id)}
            >
              <Trash2 size={14} /> {t('page.deleteForever')}
            </button>
          </div>
        )}
        {!trashed && page.archivedAt !== null && (
          <div className="banner" role="note">
            <span>{t('page.pageArchived')}</span>
            <button type="button" className="button small" onClick={() => setArchived(id, false)}>
              <ArchiveRestore size={14} /> {t('page.unarchive')}
            </button>
          </div>
        )}
        {page.kind !== 'database' && !unreadable && !hasUnknownContent && (
          <Outline doc={doc} editorRef={editorRef} />
        )}
        <CoverBanner page={page} editable={!trashed} />
        <article
          className={`page font-${noteStyle.font} width-${noteStyle.width}${page.cover ? ' has-cover' : ''}`}
          style={
            {
              '--note-font-size': `${noteStyle.fontSize}px`,
              '--note-line-height': noteStyle.lineHeight,
              '--note-block-spacing': `${noteStyle.blockSpacing}px`,
            } as React.CSSProperties
          }
        >
          {!trashed && <ConflictBanner id={id} />}
          {page.icon && (
            <div className="page-icon-row">
              <button
                type="button"
                className="page-icon"
                aria-label={t('page.changeIcon')}
                disabled={trashed}
                onClick={() => openDialog({ kind: 'icon', pageId: id })}
              >
                <PageGlyph icon={page.icon} />
              </button>
            </div>
          )}
          {!trashed && (!page.icon || !page.cover || canAddProperty) && (
            <div className="page-header-actions">
              {!page.icon && (
                <button
                  type="button"
                  className="add-icon"
                  onClick={() => openDialog({ kind: 'icon', pageId: id })}
                >
                  <Smile size={14} /> {t('page.addIcon')}
                </button>
              )}
              {!page.cover && (
                <button
                  type="button"
                  className="add-icon"
                  onClick={(event) => setCoverPicker(event.currentTarget)}
                >
                  <ImageIcon size={14} /> {t('page.addCover')}
                </button>
              )}
              {canAddProperty && (
                <button type="button" className="add-icon" onClick={() => setAddingFor(id)}>
                  <ListPlus size={14} /> {t('page.addProperty')}
                </button>
              )}
            </div>
          )}
          {coverPicker && (
            <CoverPicker page={page} anchor={coverPicker} onClose={() => setCoverPicker(null)} />
          )}
          {page.dailyDate && <DailyNav page={page} />}
          <h1 className="page-title-heading">
            <TitleField
              page={page}
              readOnly={trashed}
              inputRef={titleRef}
              onEnter={(rest) => {
                const editor = editorRef.current;
                if (!editor) focusWhenReady.current = true;
                else if (rest === null || !editor.isEditable) focusStart(editor);
                else openFirstLine(editor, rest);
              }}
            />
          </h1>
          {!trashed && !unreadable && (
            <div className="page-style-action">
              <button
                type="button"
                className="button small"
                aria-label={t('page.style.title')}
                onClick={(event) => setStylePicker(event.currentTarget)}
              >
                <SlidersHorizontal size={14} /> {t('page.style.title')}
              </button>
              {stylePicker && (
                <NoteStylePopover
                  page={page}
                  style={noteStyle}
                  defaults={prefs.defaultNoteStyle}
                  anchor={stylePicker}
                  onClose={() => setStylePicker(null)}
                />
              )}
            </div>
          )}
          {page.kind !== 'database' && <PageTags page={page} editable={!trashed && !unreadable} />}
          {isTemplate && <RepeatBar page={page} editable={!trashed && !unreadable} />}
          {!unreadable && (
            <PageProperties
              page={page}
              database={database?.database ? { id: database.id, database: database.database } : null}
              doc={doc}
              editable={!trashed}
              adding={addingFor === id}
              onAdded={() => setAddingFor(null)}
            />
          )}
          {unreadable && page.encrypted ? (
            <LockedPage page={page} />
          ) : unreadable ? (
            <div className="banner is-error" role="alert">
              {t('page.contentUnreadable')}
            </div>
          ) : ui.sourceMode === id && page.kind === 'page' ? (
            <>
              <div className="banner source-banner" role="note">
                <span>{t('page.editingAsMarkdown')}</span>
                <button type="button" className="button small" onClick={() => setUi({ sourceMode: null })}>
                  {t('page.backToEditor')}
                </button>
              </div>
              <SourceEditor pageId={id} doc={doc} editable={!trashed} />
            </>
          ) : (
            showText && (
              <PageBody
                id={id}
                doc={doc}
                editable={!trashed}
                find={find}
                anchor={anchor ?? null}
                onDirty={setEditing}
                onExitTop={(text) => {
                  const title = titleRef.current;
                  if (!title) return;
                  const end = title.value.length;
                  if (text && !trashed) {
                    const joined = title.value + text;
                    run({ type: 'page.rename', id, title: joined, now: Date.now() });
                    // the textarea is controlled, set it now so the cursor lands between the two parts
                    title.value = joined;
                  }
                  title.focus();
                  title.setSelectionRange(end, end);
                }}
                onReady={(editor) => {
                  editorRef.current = editor;
                  editor.on('selectionUpdate', ({ editor: current }) => {
                    const scope = scrollScopeRef.current;
                    if (
                      scrollRestoreRef.current.status === 'pending' ||
                      getTabs().pane !== scope.pane ||
                      !current.view.dom.closest('.view')?.checkVisibility()
                    )
                      return;
                    const { from, to } = current.state.selection;
                    rememberScopedPlace(scope, { from, to });
                  });
                  if (firstPage && getTabs().pane === scrollScopeRef.current.pane) {
                    startupFocus.current = true;
                    firstPage = false;
                  }
                  if (!focusWhenReady.current) {
                    requestRestoreRef.current?.();
                    return;
                  }
                  scrollRestoreRef.current.status = 'cancelled';
                  focusWhenReady.current = false;
                  requestAnimationFrame(() => focusStart(editor));
                }}
              />
            )
          )}
          {page.kind === 'database' && (
            <Suspense fallback={<div className="database" aria-busy="true" />}>
              <DatabaseView page={page} editable={!trashed && !unreadable} />
            </Suspense>
          )}
          {page.kind !== 'database' && <Subpages parentId={id} />}
          {page.dailyDate && <MadeThisDay dailyDate={page.dailyDate} />}
          <Backlinks id={id} />
        </article>
      </div>
    </div>
  );
}

// a copy a sync app kept because this page changed on two computers at once, next to the page it copies
// the app that kept a conflicted copy, named in the reader's language when it is a description, not a name
function syncAppName(app: string): string {
  if (app === 'your sync app') return t('page.yourSyncApp');
  if (app === 'Morrow sync') return t('page.morrowSync');
  return app;
}

function ConflictBanner({ id }: { id: PageId }) {
  const state = useWorkspace();
  const session = getSession();
  const path = session.pathOf(id);
  const conflict = path ? conflictOriginal(path) : null;
  if (!conflict) return null;
  const wanted = conflict.original.toLowerCase();
  const original = Object.keys(state.pages).find(
    (other) => other !== id && session.pathOf(other)?.toLowerCase() === wanted,
  );
  const title = original ? displayTitle(state.pages[original]) : basename(stripExtension(conflict.original));
  return (
    <div className="banner conflict-banner" role="note">
      <span>{t('page.conflictCopy', { app: syncAppName(conflict.app), title })}</span>
      {original && (
        <button
          type="button"
          className="button small"
          onClick={() => openSide(routeHash({ name: 'page', id: original, find: null }))}
        >
          <Columns2 size={14} /> {t('page.compareSideBySide')}
        </button>
      )}
      <button type="button" className="button small" onClick={() => trashPage(id)}>
        <Trash2 size={14} /> {t('page.moveCopyToTrash')}
      </button>
    </div>
  );
}

function findTrashedAncestor(pages: Record<PageId, PageMeta>, id: PageId): PageId | null {
  let current = pages[id];
  for (let guard = 0; current && guard < 256; guard++) {
    if (current.trashedAt !== null) return current.id;
    current = current.parentId ? pages[current.parentId] : undefined;
  }
  return null;
}

function PageBody(props: {
  id: PageId;
  doc: typeof EMPTY_DOC;
  editable: boolean;
  find: string | null;
  anchor: string | null;
  onDirty: (dirty: boolean) => void;
  onExitTop: (text?: string) => void;
  onReady: (editor: Editor) => void;
}) {
  const unknown = useMemo(() => findUnknownTypes(props.doc), [props.doc]);
  if (unknown.length > 0) {
    return (
      <>
        <div className="banner" role="note">
          {t('page.newerVersion', { types: unknown.join(', ') })}
        </div>
        <pre className="readonly-text">{docToPlainText(props.doc)}</pre>
      </>
    );
  }
  return (
    <PageEditor
      pageId={props.id}
      doc={props.doc}
      editable={props.editable}
      find={props.find}
      anchor={props.anchor}
      onDirty={props.onDirty}
      onExitTop={props.onExitTop}
      onReady={props.onReady}
    />
  );
}

function TitleField({
  page,
  readOnly,
  inputRef,
  onEnter,
}: {
  page: PageMeta;
  readOnly: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  // the title text after the cursor when enter was pressed, null when the cursor only moves down
  onEnter: (rest: string | null) => void;
}) {
  const ui = useUi();

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${element.scrollHeight}px`;
  });

  // a narrower side of a split wraps the title onto more lines, so it is measured again
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      element.style.height = '0px';
      element.style.height = `${element.scrollHeight}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [inputRef]);

  useEffect(() => {
    if (ui.focusTitle !== page.id) return;
    inputRef.current?.focus();
    if (getUi().focusTitle === page.id) setUi({ focusTitle: null });
  }, [ui.focusTitle, page.id, inputRef]);

  return (
    <textarea
      ref={inputRef}
      className="page-title"
      rows={1}
      placeholder={t('page.untitled')}
      aria-label={t('page.titleAria')}
      value={page.title}
      readOnly={readOnly}
      spellCheck
      onChange={(event) =>
        run({ type: 'page.rename', id: page.id, title: event.target.value, now: Date.now() })
      }
      onKeyDown={(event) => {
        const target = event.currentTarget;
        const atEnd =
          target.selectionStart === target.value.length && target.selectionEnd === target.value.length;
        if (event.key === 'ArrowDown' && atEnd) {
          event.preventDefault();
          onEnter(null);
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (readOnly) return onEnter(null);
          const rest = target.value.slice(target.selectionEnd).trim();
          if (rest)
            run({
              type: 'page.rename',
              id: page.id,
              title: target.value.slice(0, target.selectionStart).trimEnd(),
              now: Date.now(),
            });
          onEnter(rest);
        }
      }}
    />
  );
}

function Subpages({ parentId }: { parentId: PageId }) {
  const state = useWorkspace();
  const children = useMemo(() => childrenOf(state.pages, parentId), [state.pages, parentId]);
  if (children.length === 0) return null;
  return (
    <section className="page-section" aria-label={t('page.subpages')}>
      <h2 className="section-label">{t('page.subpages')}</h2>
      <ul className="link-list">
        {children.map((child) => {
          return (
            <li key={child.id}>
              <button type="button" className="link-row" onClick={() => openPage(child.id)}>
                <span className="tree-icon">
                  <PageIcon page={child} />
                </span>
                <span className="link-row-title">{displayTitle(child)}</span>
                <span className="link-row-meta">{relativeTime(child.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Backlinks({ id }: { id: PageId }) {
  const state = useWorkspace();
  const backlinks = useMemo(() => backlinksTo(state, id), [state, id]);
  const linked = useShowMore(backlinks, 30);
  const [showMentions, setShowMentions] = useState(false);
  const mentions = useMemo(
    () => (showMentions ? unlinkedMentions(state, id) : []),
    [state, id, showMentions],
  );
  const title = displayTitle(state.pages[id]);
  const mentionsSection = (
    <section className="page-section" aria-label={t('page.unlinkedMentionsAria')}>
      <button
        type="button"
        className="section-label link-button mentions-toggle"
        aria-expanded={showMentions}
        onClick={() => setShowMentions((open) => !open)}
      >
        {showMentions ? t('page.hideMentions', { title }) : t('page.findMentions', { title })}
      </button>
      {showMentions &&
        (mentions.length === 0 ? (
          <p className="muted small">{t('page.noMentions')}</p>
        ) : (
          <ul className="link-list">
            {mentions.map(({ source, context }) => (
              <li key={source.id}>
                <button
                  type="button"
                  className="link-row backlink"
                  onClick={() => openPage(source.id, title)}
                >
                  <span className="link-row-title">
                    {displayTitle(source)} <ArrowUpRight size={13} />
                  </span>
                  <span className="backlink-context">{context}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
  if (backlinks.length === 0) return mentionsSection;
  return (
    <>
      <section className="page-section" aria-label={t('page.backlinksAria')}>
        <h2 className="section-label">
          {backlinks.length === 1
            ? t('page.linkedFromSingular')
            : t('page.linkedFromPlural', { count: backlinks.length })}
        </h2>
        <ul className="link-list">
          {linked.shown.map(({ source, contexts }) => (
            <li key={source.id}>
              <button type="button" className="link-row backlink" onClick={() => openPage(source.id)}>
                <span className="link-row-title">
                  {displayTitle(source)} <ArrowUpRight size={13} />
                </span>
                {contexts[0] && <span className="backlink-context">{contexts[0]}</span>}
              </button>
            </li>
          ))}
        </ul>
        {linked.more}
      </section>
      {mentionsSection}
    </>
  );
}

interface Heading {
  level: number;
  text: string;
}

function headingsOf(doc: DocNode): Heading[] {
  const headings: Heading[] = [];
  const visit = (node: DocNode) => {
    if (node.type === 'heading') {
      const heading = { level: Number(node.attrs?.level ?? 1), text: inlineText(node).trim() };
      if (heading.text) headings.push(heading);
    }
    node.content?.forEach(visit);
  };
  doc.content?.forEach(visit);
  return headings;
}

// the room a view needs before the outline fits beside the page
const OUTLINE_ROOM = 1090;

// a list of the page's headings beside long pages, click one to jump to it. it starts below the cover,
// marks the section being read, and a heading with smaller ones under it can fold them away
function Outline({ doc, editorRef }: { doc: DocNode; editorRef?: React.RefObject<Editor | null> }) {
  const headings = useMemo(() => headingsOf(doc), [doc]);
  const outlineId = useId();
  const ref = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(false);
  const [open, setOpen] = useState<boolean | null>(null);
  const [active, setActive] = useState(-1);
  const [top, setTop] = useState<number | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const enough = headings.length >= 3;
  const elements = () =>
    ref.current
      ?.closest('.view')
      ?.querySelectorAll<HTMLElement>('.editor-surface .prose :is(h1, h2, h3, h4, h5, h6)') ?? [];
  // measured on the view it sits in, checking right margin so outline never overlaps page content
  useEffect(() => {
    const view = ref.current?.closest('.view');
    if (!view) return;
    const checkFit = () => {
      const viewRect = view.getBoundingClientRect();
      const pageEl = view.querySelector<HTMLElement>('.page');
      const pageRect = pageEl?.getBoundingClientRect();
      const rightSpace = pageRect ? viewRect.right - pageRect.right : (viewRect.width - 700) / 2;
      setRoomy(viewRect.width >= OUTLINE_ROOM && rightSpace >= 220);
    };
    const observer = new ResizeObserver(checkFit);
    observer.observe(view);
    const pageEl = view.querySelector<HTMLElement>('.page');
    if (pageEl) observer.observe(pageEl);
    checkFit();
    return () => observer.disconnect();
  }, [enough, doc]);
  useEffect(() => {
    const view = ref.current?.closest('.view');
    const scroller = view?.querySelector('.page-scroll');
    if (!view || !scroller || !enough) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewTop = view.getBoundingClientRect().top;
      const cover = view.querySelector('.page-cover');
      const below = cover ? cover.getBoundingClientRect().bottom - viewTop + 24 : 0;
      setTop(below > 64 ? below : null);
      let current = -1;
      elements().forEach((element, index) => {
        if (element.getBoundingClientRect().top - viewTop < 120) current = index;
      });
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enough, doc]);
  if (!enough) return null;
  const jump = (index: number) => {
    const editor = editorRef?.current;
    if (editor && !editor.isDestroyed) {
      let seen = 0;
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        if (node.type.name === 'heading') {
          if (seen === index) targetPos = pos;
          seen++;
          return false;
        }
        return true;
      });
      if (targetPos !== null) {
        revealAncestorsForPosition(editor.view, targetPos);
      }
    }
    elements()[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // a heading owns the smaller headings after it, up to the next one of its size or bigger
  const hasChildren = (index: number) => (headings[index + 1]?.level ?? 0) > headings[index]!.level;
  const hidden = new Set<number>();
  for (const index of folded) {
    for (
      let next = index + 1;
      next < headings.length && headings[next]!.level > headings[index]!.level;
      next++
    )
      hidden.add(next);
  }
  // a section folded away shows as reading the heading it is folded under
  let marked = active;
  while (marked > 0 && hidden.has(marked)) marked--;
  const toggle = (index: number) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const isVisible = open ?? roomy;
  return (
    <>
      <button
        type="button"
        className={`page-outline-toggle${isVisible ? ' is-active' : ''}`}
        aria-label={t('editor.toggleOutline')}
        aria-controls={outlineId}
        aria-expanded={isVisible}
        title={t('editor.toggleOutline')}
        onClick={() => setOpen((current) => !(current ?? roomy))}
      >
        <ListTree size={14} />
      </button>
      <nav
        ref={ref}
        id={outlineId}
        className={`page-outline${isVisible ? ' is-roomy' : ''}${roomy ? '' : ' is-overlay'}`}
        hidden={!isVisible}
        style={top === null ? undefined : { top, maxHeight: `calc(100% - ${top + 46}px)` }}
        aria-label={t('page.outlineAria')}
      >
        <p className="page-outline-title">{t('page.onThisPage')}</p>
        <ul>
          {headings.map((heading, index) =>
            hidden.has(index) ? null : (
              <li
                key={index}
                className={index === marked ? 'is-active' : undefined}
                style={{ '--level': heading.level } as React.CSSProperties}
              >
                {hasChildren(index) && (
                  <button
                    type="button"
                    className="outline-fold"
                    aria-expanded={!folded.has(index)}
                    aria-label={folded.has(index) ? t('common.expand') : t('common.collapse')}
                    onClick={() => toggle(index)}
                  >
                    <ChevronRight size={12} />
                  </button>
                )}
                <button type="button" className="outline-link" onClick={() => jump(index)}>
                  {heading.text}
                </button>
              </li>
            ),
          )}
        </ul>
      </nav>
    </>
  );
}
