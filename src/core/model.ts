// workspace data model, plain json shared by storage, search, export and the editor

// bump when the persisted shape changes and add a migration in migrations.ts
export const SCHEMA_VERSION = 9;

export const MAX_TITLE_LENGTH = 500;
// includes compact Lucide names and local attachment references; plain emoji remain much shorter
export const MAX_ICON_LENGTH = 512;
// limits that keep hostile or corrupted documents from hanging the app
export const MAX_DOC_DEPTH = 64;
export const MAX_DOC_NODES = 200_000;
export const MAX_TREE_DEPTH = 256;

export type PageId = string;

// journal holds daily notes, templates holds reusable pages, databases and canvases have their own views
export type PageKind = 'page' | 'journal' | 'templates' | 'database' | 'canvas';
export const PAGE_KINDS: readonly PageKind[] = ['page', 'journal', 'templates', 'database', 'canvas'];

export type PropType =
  | 'text'
  | 'email'
  | 'url'
  | 'phone'
  | 'number'
  | 'currency'
  | 'percent'
  | 'slider'
  | 'progress'
  | 'scale'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'createdTime'
  | 'lastEditedTime'
  | 'checkbox'
  | 'relation'
  | 'formula'
  | 'image'
  | 'file'
  | 'richCanvas'
  | 'button';
export const PROP_TYPES: readonly PropType[] = [
  'text',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'slider',
  'progress',
  'scale',
  'select',
  'multiSelect',
  'date',
  'time',
  'datetime',
  'duration',
  'createdTime',
  'lastEditedTime',
  'checkbox',
  'relation',
  'formula',
  'image',
  'file',
  'richCanvas',
  'button',
];
export const COLORS = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type ColorName = (typeof COLORS)[number];
export type HexColor = `#${string}`;
export type ColorValue = ColorName | HexColor;

export function validHexColor(value: unknown): HexColor | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? (value.toLowerCase() as HexColor) : null;
}

export function validColor(value: unknown): ColorValue | null {
  if (COLORS.includes(value as ColorName)) return value as ColorName;
  return validHexColor(value);
}

export function validBlockBackground(value: unknown): ColorValue | null {
  return validColor(value);
}

export interface SelectOption {
  id: string;
  name: string;
  color: ColorName;
}

export interface PropDef {
  id: string;
  name: string;
  type: PropType;
  options: SelectOption[];
  description?: string;
  // how scalar values are displayed and constrained; storage values remain locale independent
  format?: PropertyFormat;
  // manual is the legacy default; defaults are materialized once when a row is created
  fillMode?: 'manual' | 'default' | 'calculated';
  defaultValue?: PropValue;
  defaultFormula?: string;
  // source spans point into the corresponding formula source and keep references attached to stable IDs
  defaultFormulaBindings?: FormulaReferenceBinding[];
  // the expression a formula property computes, see core/formula
  formula?: string;
  formulaBindings?: FormulaReferenceBinding[];
  // a number or formula shown as a progress bar filled to value out of max, 100 when not set
  display?: 'bar';
  max?: number;
  // relation values are row ids in the selected database; missing config preserves legacy title values
  relation?: RelationConfig;
  // local media properties can keep one or many stable file references
  media?: { multiple: boolean };
  // button columns run a bounded, explicitly configured sequence through workspace commands
  action?: TableActionDef;
}

export type TableActionIcon = 'play' | 'plus' | 'check' | 'refresh';

export interface ActionFormulaDef {
  source: string;
  bindings: FormulaReferenceBinding[];
}

export type TableActionStep =
  | {
      id: string;
      type: 'addRows';
      count: ActionFormulaDef;
      title: ActionFormulaDef;
      values: Record<string, ActionFormulaDef>;
    }
  | {
      id: string;
      type: 'modifyRows';
      target: 'currentRow' | 'matchingRows';
      where?: ActionFormulaDef;
      values: Record<string, ActionFormulaDef>;
    }
  | {
      id: string;
      type: 'resetControls';
      controlIds: string[];
    };

export interface TableActionDef {
  label: string;
  icon: TableActionIcon;
  color: ColorName;
  disabled?: ActionFormulaDef;
  steps: TableActionStep[];
}

interface FormulaBindingSpan {
  start: number;
  end: number;
  source: string;
}

export type FormulaReferenceBinding =
  | (FormulaBindingSpan & { kind: 'database'; databaseId: PageId })
  | (FormulaBindingSpan & { kind: 'property'; databaseId: PageId; propertyId: string })
  | (FormulaBindingSpan & { kind: 'control'; pageId: PageId; controlId: string })
  | (FormulaBindingSpan & { kind: 'result'; pageId: PageId; resultId: string })
  | (FormulaBindingSpan & { kind: 'ambiguous'; pageId: PageId });

export type NamedControlType = 'text' | 'number' | 'slider' | 'select' | 'checkbox' | 'date' | 'relation';

export interface NamedControlDef {
  id: string;
  name: string;
  type: NamedControlType;
  value: PropValue;
  defaultValue: PropValue;
  options: SelectOption[];
  format?: PropertyFormat;
  relation?: {
    targetDatabaseId: PageId | null;
    multiple: boolean;
  };
}

export interface ControlReference {
  pageId: PageId;
  controlId: string;
}

export interface PropertyFormat {
  locale?: string;
  linkLabel?: string;
  currency?: string;
  precision?: number;
  negativeFormat?: 'minus' | 'parentheses';
  min?: number;
  max?: number;
  step?: number;
  dateStyle?: 'short' | 'medium' | 'long' | 'full';
  timeStyle?: 'short' | 'medium' | 'long' | 'full';
  timeZone?: string;
  // display unit only; stored durations are seconds and the default display unit is minutes
  durationUnit?: 'seconds' | 'minutes' | 'hours' | 'days';
  scaleIcon?: 'star' | 'number';
  color?: ColorName;
  showValue?: boolean;
}

export interface RelationConfig {
  targetDatabaseId: PageId | null;
  multiple: boolean;
  // inverse fields are projections; only the owning field stores row ids
  isInverse: boolean;
  displayPropertyId: string | null;
  inversePropertyId: string | null;
  filters: FilterRule[];
}

export type FilterOp =
  'contains' | 'notContains' | 'is' | 'isNot' | 'empty' | 'notEmpty' | 'gt' | 'lt' | 'checked' | 'unchecked';

export interface FilterRule {
  id: string;
  // a property id, or title
  prop: string;
  op: FilterOp;
  value: PropValue;
  controlRef?: ControlReference;
  formula?: string;
  formulaBindings?: FormulaReferenceBinding[];
}

export interface FilterGroup {
  id: string;
  logic: 'and' | 'or';
  filters: FilterRule[];
}

export type SummaryOperation = 'sum' | 'average' | 'count' | 'min' | 'max';

export interface ConditionalFormatRule extends FilterRule {
  scope: 'row' | 'cell';
  color: ColorName;
}

export interface SortRule {
  // a property id, or title, created or updated
  prop: string;
  dir: 'asc' | 'desc';
}

export type ViewType = 'table' | 'board' | 'calendar' | 'list' | 'gallery';
export const VIEW_TYPES: readonly ViewType[] = ['table', 'board', 'calendar', 'list', 'gallery'];

export interface ViewDef {
  id: string;
  name: string;
  type: ViewType;
  filters: FilterRule[];
  sorts: SortRule[];
  groupBy: string | null;
  dateProp: string | null;
  hidden: string[];
  // table column widths in pixels, by property id or title, missing means the default width
  widths?: Record<string, number>;
  // Each group combines its rules with AND/OR; the view combines groups with AND/OR.
  filterGroups?: FilterGroup[];
  filterGroupLogic?: 'and' | 'or';
  // visible text search is scoped to this view and applies before sorting and layout rendering
  search?: string;
  // view-local property order; missing properties follow the database schema order
  order?: string[];
  wrap?: string[];
  align?: Record<string, 'left' | 'center' | 'right'>;
  summaries?: Record<string, SummaryOperation>;
  conditionalFormats?: ConditionalFormatRule[];
  cardProperties?: string[];
  cardImageProp?: string | null;
}

export interface DatabaseDef {
  properties: PropDef[];
  views: ViewDef[];
  // opaque future schema entries are kept intact and make the database read-only in this version
  unsupportedProperties?: unknown[];
}

// option ids for selects, yyyy mm dd for dates
export type PropValue = string | number | boolean | string[] | null;

export interface PageMeta {
  id: PageId;
  parentId: PageId | null;
  title: string;
  icon: string | null;
  kind: PageKind;
  order: number;
  createdAt: number;
  updatedAt: number;
  // set only on the page that was trashed, its subpages are hidden with it
  trashedAt: number | null;
  favorite: boolean;
  dailyDate: string | null;
  lastOpenedAt: number | null;
  tags: string[];
  // named, page-scoped inputs used by document formulas and view filters
  controls: NamedControlDef[];
  // values for the properties of the database this page is a row of, keyed by property id
  properties: Record<string, PropValue>;
  // frontmatter keys morrow gives no meaning to, such as obsidian properties, shown and edited as they are
  extra: Record<string, unknown>;
  database: DatabaseDef | null;
  // a gradient such as gradient-3, or the path of an image in the vault
  cover: string | null;
  // vertical focal point of the cover, as a percentage from top to bottom
  coverPosition: number;
  // a saved override; null keeps the appearance this page had before per-note styles
  noteStyle: NoteStyle | null;
  // the page file is encrypted with a password, its content is only in memory while it is unlocked
  encrypted: boolean;
}

export const COVER_GRADIENTS = 12;
export const DEFAULT_COVER_POSITION = 50;

export type NoteFont = 'serif' | 'sans' | 'mono';
export type NoteWidth = 'comfortable' | 'wide';

export interface NoteStyle {
  font: NoteFont;
  fontSize: number;
  lineHeight: number;
  blockSpacing: number;
  width: NoteWidth;
}

export const DEFAULT_NOTE_STYLE: NoteStyle = {
  font: 'sans',
  fontSize: 16,
  lineHeight: 1.68,
  blockSpacing: 9,
  width: 'comfortable',
};

export function validCoverPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function normalizeCoverPosition(value: unknown): number {
  return validCoverPosition(value) ? Math.round(value) : DEFAULT_COVER_POSITION;
}

export function validNoteStyle(value: unknown): value is NoteStyle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const style = value as Record<string, unknown>;
  return (
    ['serif', 'sans', 'mono'].includes(style.font as string) &&
    typeof style.fontSize === 'number' &&
    Number.isFinite(style.fontSize) &&
    style.fontSize >= 12 &&
    style.fontSize <= 32 &&
    typeof style.lineHeight === 'number' &&
    Number.isFinite(style.lineHeight) &&
    style.lineHeight >= 1.2 &&
    style.lineHeight <= 2.4 &&
    typeof style.blockSpacing === 'number' &&
    Number.isFinite(style.blockSpacing) &&
    style.blockSpacing >= 0 &&
    style.blockSpacing <= 40 &&
    ['comfortable', 'wide'].includes(style.width as string)
  );
}

// persisted styles are normalized so an invalid or older value cannot break page layout
export function normalizeNoteStyle(
  value: unknown,
  fallback: NoteStyle = DEFAULT_NOTE_STYLE,
): NoteStyle | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const style = value as Record<string, unknown>;
  const bounded = (item: unknown, min: number, max: number, otherwise: number) =>
    typeof item === 'number' && Number.isFinite(item) && item >= min && item <= max ? item : otherwise;
  return {
    font: ['serif', 'sans', 'mono'].includes(style.font as string) ? (style.font as NoteFont) : fallback.font,
    fontSize: bounded(style.fontSize, 12, 32, fallback.fontSize),
    lineHeight: bounded(style.lineHeight, 1.2, 2.4, fallback.lineHeight),
    blockSpacing: bounded(style.blockSpacing, 0, 40, fallback.blockSpacing),
    width: ['comfortable', 'wide'].includes(style.width as string)
      ? (style.width as NoteWidth)
      : fallback.width,
  };
}

export function validCover(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cover = value.trim();
  if (/^gradient-([1-9]|1[0-2])$/.test(cover)) return cover;
  // images are vault paths, never web addresses, so a cover never loads anything from elsewhere
  if (cover.length <= 500 && !/^[a-z][a-z0-9+.-]*:/i.test(cover) && !cover.includes('..')) return cover;
  return null;
}

export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

export interface WorkspaceState {
  pages: Readonly<Record<PageId, PageMeta>>;
  docs: Readonly<Record<PageId, DocNode>>;
}

// anything outside these sets is preserved but opened read only, so a type belongs here only
// once the editor registers it, otherwise the editor would drop it on load and the next save loses it
export const KNOWN_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'pageLink',
  'image',
  'fileAttachment',
  'callout',
  'details',
  'detailsSummary',
  'detailsContent',
  'inlineMath',
  'blockMath',
  'rawBlock',
  'columns',
  'column',
  'tableOfContents',
  'dateMention',
  'linkedDatabaseView',
  'namedControl',
  'calculatedResult',
]);

export const KNOWN_MARK_TYPES = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'highlight',
  'textColor',
]);

// the colours text and highlights are written with in files, readable by any markdown app that shows html
export const TEXT_HEX: Record<ColorName, string> = {
  gray: '#787774',
  brown: '#9f6b53',
  orange: '#d9730d',
  yellow: '#cb912f',
  green: '#448361',
  blue: '#337ea9',
  purple: '#9065b0',
  pink: '#c14c8a',
  red: '#d44c47',
};
export const BACKGROUND_HEX: Record<ColorName, string> = {
  gray: '#f1f1ef',
  brown: '#f4eeee',
  orange: '#fbecdd',
  yellow: '#fbf3db',
  green: '#edf3ec',
  blue: '#e7f3f8',
  purple: '#f6f3f9',
  pink: '#faf1f5',
  red: '#fdebec',
};

// the palette colour closest to any css colour written as #rgb or #rrggbb
export function nearestColor(hex: string, palette: Record<ColorName, string>): ColorName | null {
  const parse = (value: string) => {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join('') : match[1]!;
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  };
  const wanted = parse(hex);
  if (!wanted) return null;
  let best: ColorName | null = null;
  let distance = Infinity;
  for (const [name, value] of Object.entries(palette) as Array<[ColorName, string]>) {
    const rgb = parse(value)!;
    const d = rgb.reduce((sum, channel, i) => sum + (channel - wanted[i]!) ** 2, 0);
    if (d < distance) {
      distance = d;
      best = name;
    }
  }
  return best;
}

export type FileId = string;

// metadata of a stored image or attachment, the bytes live next to it in storage
export interface FileMeta {
  id: FileId;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

export interface Snapshot {
  id: string;
  pageId: PageId;
  title: string;
  doc: DocNode;
  createdAt: number;
}

export const CALLOUT_TONES = ['note', 'tip', 'warning', 'danger'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

// obsidian and github callout types, each drawn in one of the four tones
const CALLOUT_KIND_TONES: Record<string, CalloutTone> = {
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  question: 'warning',
  help: 'warning',
  faq: 'warning',
  danger: 'danger',
  error: 'danger',
  failure: 'danger',
  fail: 'danger',
  missing: 'danger',
  bug: 'danger',
};

export function calloutTone(kind: string): CalloutTone {
  return CALLOUT_KIND_TONES[kind.toLowerCase()] ?? 'note';
}

export function emptyDoc(): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function emptyWorkspace(): WorkspaceState {
  return { pages: {}, docs: {} };
}

export const UNTITLED = 'Untitled';

export function displayTitle(page: Pick<PageMeta, 'title'> | undefined): string {
  const title = page?.title.trim();
  return title ? title : UNTITLED;
}

// every new page record goes through here so added fields always get safe defaults
export function newPageMeta(fields: Pick<PageMeta, 'id' | 'parentId'> & Partial<PageMeta>): PageMeta {
  const now = fields.createdAt ?? 0;
  return {
    title: '',
    icon: null,
    kind: 'page',
    order: 0,
    createdAt: now,
    updatedAt: fields.updatedAt ?? now,
    trashedAt: null,
    favorite: false,
    dailyDate: null,
    lastOpenedAt: null,
    tags: [],
    controls: [],
    properties: {},
    extra: {},
    database: null,
    cover: null,
    coverPosition: DEFAULT_COVER_POSITION,
    noteStyle: null,
    encrypted: false,
    ...fields,
  };
}
