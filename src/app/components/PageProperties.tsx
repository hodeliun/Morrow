import { Columns3, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { stringify } from 'yaml';
import { isRecord } from '../../core/doc';
import { displayTitle } from '../../core/model';
import type { DatabaseDef, DocNode, PageId, PageMeta, PropDef } from '../../core/model';
import { inferFrontmatterType } from '../../core/properties';
import { findKey, MANAGED_KEYS, parseStructuredYaml } from '../../core/vault/frontmatter';
import { diagnoseOkfPage, isOkfPath } from '../../core/vault/okf';
import { RECURRENCE_KEYS } from '../../core/recurring';
import { findTemplatesPage } from '../../core/templates';
import { getSession, getState } from '../workspace';
import { toast } from '../ui';
import { run } from '../workspace';
import { addColumnsFromPages } from './database/data';
import { DraftInput, NewProperty, PropertyInput, RelationChips } from './database/PropertyValue';
import { PropertySettings } from './database/PropertySettings';
import { PropertyGlyph } from './database/PropertyTypeSelect';
import { Popover } from './Popover';
import { t } from '../i18n';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// the properties at the top of a page: its database values, then any other frontmatter it has, such as the
// properties of a note written in obsidian, shown and edited as plain values
export function PageProperties({
  page,
  database,
  doc,
  editable,
  adding,
  onAdded,
}: {
  page: PageMeta;
  database: { id: PageId; database: DatabaseDef } | null;
  doc: DocNode | undefined;
  editable: boolean;
  // set when the page header asked to add the first property
  adding: boolean;
  onAdded: () => void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [naming, setNaming] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ prop: PropDef; anchor: HTMLElement } | null>(null);
  const state = getState();
  const session = getSession();
  const pathOf = (id: PageId) => session.pathOf(id);
  const path = pathOf(page.id);
  const okfMode = isOkfPath(state, path, pathOf);
  const diagnostics = okfMode ? diagnoseOkfPage(page, path, state, doc, pathOf) : [];
  const onIndexPath = path?.toLowerCase().endsWith('/index.md') || path?.toLowerCase() === 'index.md';
  const showOkfHint =
    !okfMode &&
    (Object.hasOwn(page.extra, 'type') || (onIndexPath && Object.hasOwn(page.extra, 'okf_version')));
  // a template's repeat settings have their own bar under its title
  const extraKeys = Object.keys(page.extra).filter(
    (key) => !(isTemplate(page) && RECURRENCE_KEYS.includes(key.toLowerCase())),
  );
  const props = database?.database.properties ?? [];
  const showNaming = editable && (naming || adding);
  const showMetadata = extraKeys.length > 0 || diagnostics.length > 0 || showOkfHint;
  if (props.length === 0 && !showMetadata && !showNaming && !(database && editable)) return null;

  const setExtra = (extra: Record<string, unknown>) => saveExtra(page.id, extra);

  const addKey = (name: string): boolean => {
    const clean = name.trim();
    if (!clean) return false;
    if (MANAGED_KEYS.has(clean) || clean.length > 200) {
      toast(t('toasts.propNameUsed', { name: clean }), { tone: 'error' });
      return false;
    }
    if (
      findKey(page.extra, clean) !== undefined ||
      props.some((prop) => prop.name.toLowerCase() === clean.toLowerCase())
    ) {
      toast(t('toasts.pageHasProp', { name: clean }), { tone: 'error' });
      return false;
    }
    if (!setExtra({ ...page.extra, [clean]: '' })) return false;
    setFocusKey(clean);
    return true;
  };

  return (
    <section className="row-props" aria-label={t('properties.properties')}>
      {database &&
        props.map((prop) => (
          <div key={prop.id} className="row-prop">
            {editable ? (
              <button
                type="button"
                className="row-prop-name row-prop-button"
                title={t('properties.editProperty')}
                onClick={(event) => setSettings({ prop, anchor: event.currentTarget })}
              >
                <PropertyGlyph prop={prop} size={14} />
                <span>{prop.name}</span>
              </button>
            ) : (
              <span className="row-prop-name">
                <PropertyGlyph prop={prop} size={14} />
                <span>{prop.name}</span>
              </span>
            )}
            <span className="row-prop-value">
              <PropertyInput dbId={database.id} prop={prop} row={page} editable={editable} />
            </span>
          </div>
        ))}
      {showMetadata && (
        <details className="metadata-details">
          <summary className="metadata-summary">
            <span>{t('properties.metadata')}</span>
            {extraKeys.length > 0 && <span className="metadata-count">{extraKeys.length}</span>}
          </summary>
          <div className="metadata-panel">
            {showOkfHint && <p className="metadata-note">{t('properties.okfModeHint')}</p>}
            {diagnostics.length > 0 && (
              <ul className="metadata-diagnostics" aria-label={t('properties.okfDiagnostics')}>
                {diagnostics.map((diagnostic, index) => (
                  <li
                    key={`${diagnostic.code}-${index}`}
                    className={diagnostic.code === 'missing-link-target' ? 'is-info' : 'is-warning'}
                  >
                    {diagnosticText(diagnostic)}
                  </li>
                ))}
              </ul>
            )}
            {okfMode &&
              path &&
              !['index.md', 'log.md'].includes(path.split('/').at(-1)!.toLowerCase()) &&
              diagnostics.length === 0 && <p className="metadata-note">{t('properties.okfReady')}</p>}
            {extraKeys.map((key) => (
              <div key={key} className="row-prop is-extra">
                <span className="row-prop-name" title={key}>
                  {key}
                </span>
                <div className="row-prop-value">
                  <ExtraValue
                    label={t('properties.valueOf', { key, title: displayTitle(page) })}
                    value={page.extra[key]}
                    editable={editable}
                    autoFocus={focusKey === key}
                    onChange={(value) => setExtra({ ...page.extra, [key]: value })}
                  />
                </div>
                {editable && (
                  <span className="row-prop-actions">
                    {database && inferFrontmatterType([page.extra[key]]) !== null && (
                      <button
                        type="button"
                        className="icon-button tiny"
                        aria-label={t('properties.makeColumnAria', { key })}
                        title={t('properties.makeColumn')}
                        onClick={() => addColumnsFromPages(database.id, [key])}
                      >
                        <Columns3 size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('properties.removeAria', { key })}
                      title={t('properties.remove')}
                      onClick={() => {
                        const { [key]: _removed, ...rest } = page.extra;
                        setExtra(rest);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {showNaming && (
        <form
          className="row-prop row-prop-new"
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement;
            if (addKey(input.value)) {
              setNaming(false);
              onAdded();
            }
          }}
        >
          <input
            name="name"
            className="prop-input row-prop-name-input"
            placeholder={t('page.propertyNamePlaceholder')}
            aria-label={t('page.newPropertyNameAria')}
            autoFocus
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              setNaming(false);
              onAdded();
            }}
            onBlur={(event) => {
              if (event.currentTarget.value.trim()) return;
              setNaming(false);
              onAdded();
            }}
          />
          <span className="muted small">{t('page.pressEnterToAdd')}</span>
        </form>
      )}
      {editable && !showNaming && (
        <>
          <button
            type="button"
            className="link-button row-prop-add"
            onClick={(event) => (database ? setMenu(event.currentTarget) : setNaming(true))}
          >
            <Plus size={13} /> {t('page.addAProperty')}
          </button>
          {menu && database && (
            <Popover
              anchor={menu}
              onClose={() => setMenu(null)}
              label={t('properties.newProperty')}
              className="db-panel"
            >
              <NewProperty dbId={database.id} database={database.database} onDone={() => setMenu(null)} />
            </Popover>
          )}
        </>
      )}
      {database && settings && (
        <PropertySettings
          dbId={database.id}
          database={database.database}
          prop={settings.prop}
          anchor={settings.anchor}
          onClose={() => setSettings(null)}
        />
      )}
    </section>
  );
}

const isTemplate = (page: PageMeta) =>
  page.parentId !== null && page.parentId === findTemplatesPage(getState())?.id;

function saveExtra(id: PageId, extra: Record<string, unknown>): boolean {
  return run({ type: 'page.setFields', id, extra, now: Date.now() }).ok;
}

function diagnosticText(diagnostic: ReturnType<typeof diagnoseOkfPage>[number]): string {
  switch (diagnostic.code) {
    case 'missing-type':
      return t('properties.okfTypeMissing');
    case 'invalid-type':
      return t('properties.okfTypeInvalid');
    case 'invalid-sources':
      return t('properties.okfSourcesInvalid');
    case 'invalid-source-resource':
      return t('properties.okfSourceResourceMissing');
    case 'reserved-filename':
      return t('properties.okfReservedFilename');
    case 'missing-link-target':
      return t('properties.okfLinkMissing', { href: diagnostic.href });
    case 'invalid-link-path':
      return t('properties.okfLinkInvalid', { href: diagnostic.href });
  }
}

// one frontmatter value, edited in a way that fits what it holds
function ExtraValue({
  label,
  value,
  editable,
  autoFocus,
  onChange,
}: {
  label: string;
  value: unknown;
  editable: boolean;
  autoFocus: boolean;
  onChange: (value: unknown) => void;
}) {
  const [editingLinks, setEditingLinks] = useState(false);
  if (value === null || Array.isArray(value) || isRecord(value))
    return <StructuredValue label={label} value={value} editable={editable} onChange={onChange} />;
  if (typeof value === 'boolean')
    return (
      <input
        type="checkbox"
        className="prop-checkbox"
        aria-label={label}
        checked={value}
        disabled={!editable}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (typeof value === 'number')
    return (
      <DraftInput
        type="number"
        label={label}
        value={String(value)}
        editable={editable}
        onCommit={(text) => {
          const number = Number(text);
          onChange(text.trim() && Number.isFinite(number) ? number : text);
        }}
      />
    );
  if (typeof value === 'string' && DAY.test(value))
    return (
      <input
        type="date"
        className="prop-input"
        aria-label={label}
        value={value}
        disabled={!editable}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  const text = value === undefined ? '' : String(value);
  const links = inferFrontmatterType([value]) === 'relation' && !editingLinks && !autoFocus;
  if (links)
    return (
      <span
        className="prop-select prop-links"
        role="button"
        tabIndex={editable ? 0 : -1}
        aria-label={label}
        onClick={() => editable && setEditingLinks(true)}
        onKeyDown={(event) => event.key === 'Enter' && editable && setEditingLinks(true)}
      >
        <RelationChips targets={[text.replace(/^\[\[|\]\]$/g, '')]} />
      </span>
    );
  return (
    <DraftInput
      type="text"
      label={label}
      value={text}
      editable={editable}
      autoFocus={autoFocus || editingLinks}
      onCommit={(next) => {
        onChange(next);
      }}
      onDone={() => setEditingLinks(false)}
    />
  );
}

function StructuredValue({
  label,
  value,
  editable,
  onChange,
}: {
  label: string;
  value: unknown;
  editable: boolean;
  onChange: (value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => stringify(value, { lineWidth: 0 }));
  const [error, setError] = useState<string | null>(null);
  const relationList = Array.isArray(value) && inferFrontmatterType([value]) === 'relation';
  if (!editing) {
    return (
      <div className="structured-value">
        {relationList ? (
          <RelationChips targets={(value as string[]).map((item) => item.replace(/^\[\[|\]\]$/g, ''))} />
        ) : (
          <pre className="prop-yaml">{stringify(value, { lineWidth: 0 }).trim()}</pre>
        )}
        {editable && (
          <button
            type="button"
            className="link-button metadata-edit"
            aria-label={t('properties.editYamlValue', { label })}
            onClick={() => {
              setDraft(stringify(value, { lineWidth: 0 }));
              setError(null);
              setEditing(true);
            }}
          >
            {t('properties.editYaml')}
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="structured-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseStructuredYaml(draft);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        onChange(parsed.value);
        setEditing(false);
        setError(null);
      }}
    >
      <textarea
        className="prop-input structured-editor-input"
        aria-label={t('properties.editYamlValue', { label })}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        autoFocus
      />
      {error && (
        <p className="structured-editor-error" role="alert">
          {t('properties.invalidYamlValue', { error })}
        </p>
      )}
      <div className="structured-editor-actions">
        <button type="submit" className="button small">
          {t('properties.saveYaml')}
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => {
            setDraft(stringify(value, { lineWidth: 0 }));
            setError(null);
            setEditing(false);
          }}
        >
          {t('properties.cancelYaml')}
        </button>
      </div>
    </form>
  );
}
