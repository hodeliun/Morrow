import {
  ArrowLeftRight,
  BarChart2,
  Calendar,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CheckSquare,
  ChevronDown,
  Clock,
  Coins,
  FunctionSquare,
  Hash,
  Hourglass,
  Image,
  Layout,
  Link,
  ListFilter,
  Mail,
  Paperclip,
  Percent,
  Phone,
  PlaySquare,
  Sliders,
  Star,
  Tags,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { PROP_TYPES } from '../../../core/model';
import type { PropDef, PropType } from '../../../core/model';
import { foldText } from '../../../core/search';
import { t } from '../../i18n';
import { propLabel } from '../../i18n/labels';
import { PageGlyph } from '../Emoji';
import { Popover } from '../Popover';

export const TYPE_ICONS: Record<PropType, LucideIcon> = {
  text: Type,
  number: Hash,
  select: ListFilter,
  multiSelect: Tags,
  date: Calendar,
  checkbox: CheckSquare,
  relation: ArrowLeftRight,
  formula: FunctionSquare,
  currency: Coins,
  percent: Percent,
  url: Link,
  email: Mail,
  phone: Phone,
  time: Clock,
  datetime: CalendarClock,
  duration: Hourglass,
  slider: Sliders,
  progress: BarChart2,
  scale: Star,
  createdTime: CalendarPlus,
  lastEditedTime: CalendarCheck,
  image: Image,
  file: Paperclip,
  richCanvas: Layout,
  button: PlaySquare,
};

export function PropertyGlyph({
  prop,
  className,
  size = 14,
}: {
  prop: Pick<PropDef, 'type'> & { icon?: string | null };
  className?: string;
  size?: number;
}) {
  if (prop.icon) {
    return <PageGlyph icon={prop.icon} className={className} />;
  }
  const Icon = TYPE_ICONS[prop.type] ?? Type;
  return <Icon size={size} className={className} />;
}

export const PROP_TYPE_ALIASES: Record<PropType, string[]> = {
  text: ['text', 'texto', 'string', 'escrita', 'palavra', 'caracteres', 'plain text'],
  number: ['number', 'número', 'numero', 'numeric', 'numérico', 'numerico', 'int', 'integer', 'float', 'decimal', 'quantidade', 'valor'],
  select: ['select', 'seleção', 'selecao', 'escolha', 'choice', 'opção', 'opcao', 'dropdown', 'categoria', 'single'],
  multiSelect: ['multiselect', 'multi-select', 'seleção múltipla', 'selecao multipla', 'tags', 'etiquetas', 'rótulos', 'rotulos', 'múltiplo'],
  date: ['date', 'data', 'dia', 'calendário', 'calendario', 'calendar', 'prazo', 'deadline'],
  checkbox: ['checkbox', 'caixa de seleção', 'caixa de selecao', 'booleano', 'boolean', 'check', 'feito', 'done', 'sim/não', 'sim/nao', 'flag'],
  relation: ['relation', 'relação', 'relacao', 'vínculo', 'vinculo', 'link', 'tabela', 'referência', 'referencia', 'lookup'],
  formula: ['formula', 'fórmula', 'cálculo', 'calculo', 'computed', 'fx', 'expressão', 'expressao', 'equação', 'function'],
  currency: ['currency', 'moeda', 'dinheiro', 'preço', 'preco', 'price', 'money', 'cifrão', 'cifrao', 'financeiro', 'valor'],
  percent: ['percent', 'percentual', 'porcentagem', 'porcento', 'taxa', '%', 'rate', 'percentage'],
  url: ['url', 'link', 'endereço', 'endereco', 'site', 'web', 'hiperlink', 'página'],
  email: ['email', 'e-mail', 'correio', 'mensagem', 'contato'],
  phone: ['phone', 'telefone', 'celular', 'tel', 'whatsapp', 'contato', 'fone'],
  time: ['time', 'hora', 'horário', 'horario', 'tempo', 'clock'],
  datetime: ['datetime', 'data e hora', 'data/hora', 'data hora', 'timestamp'],
  duration: ['duration', 'duração', 'duracao', 'tempo', 'minutos', 'horas', 'cronômetro', 'cronometro', 'time span'],
  slider: ['slider', 'controle deslizante', 'deslizante', 'faixa', 'range', 'barra'],
  progress: ['progress', 'progresso', 'barra de progresso', 'andamento', 'status', 'porcentagem'],
  scale: ['scale', 'escala', 'estrelas', 'avaliação', 'avaliacao', 'rating', 'score', 'nota', 'nível', 'nivel'],
  createdTime: ['created time', 'data de criação', 'data de criacao', 'criado em', 'criação', 'created'],
  lastEditedTime: ['last edited time', 'última edição', 'ultima edicao', 'modificado em', 'atualizado em', 'modified', 'updated'],
  image: ['image', 'imagem', 'foto', 'figura', 'picture', 'photo', 'mídia'],
  file: ['file', 'arquivo', 'anexo', 'attachment', 'documento', 'doc', 'pdf'],
  richCanvas: ['canvas', 'quadro', 'board', 'diagrama', 'whiteboard'],
  button: ['button', 'botão', 'botao', 'ação', 'acao', 'trigger', 'clique', 'disparador'],
};

export function propertyTypeDescription(type: PropType): string {
  switch (type) {
    case 'text':
      return t('database.propTypeDesc.text');
    case 'number':
      return t('database.propTypeDesc.number');
    case 'currency':
      return t('database.propTypeDesc.currency');
    case 'percent':
      return t('database.propTypeDesc.percent');
    case 'date':
      return t('database.propTypeDesc.date');
    case 'time':
      return t('database.propTypeDesc.time');
    case 'datetime':
      return t('database.propTypeDesc.datetime');
    case 'duration':
      return t('database.propTypeDesc.duration');
    case 'checkbox':
      return t('database.propTypeDesc.checkbox');
    case 'select':
      return t('database.propTypeDesc.select');
    case 'multiSelect':
      return t('database.propTypeDesc.multiSelect');
    case 'relation':
      return t('database.propTypeDesc.relation');
    case 'formula':
      return t('database.propTypeDesc.formula');
    case 'url':
      return t('database.propTypeDesc.url');
    case 'email':
      return t('database.propTypeDesc.email');
    case 'phone':
      return t('database.propTypeDesc.phone');
    case 'slider':
      return t('database.propTypeDesc.slider');
    case 'progress':
      return t('database.propTypeDesc.progress');
    case 'scale':
      return t('database.propTypeDesc.scale');
    case 'createdTime':
      return t('database.propTypeDesc.createdTime');
    case 'lastEditedTime':
      return t('database.propTypeDesc.lastEditedTime');
    case 'image':
      return t('database.propTypeDesc.image');
    case 'file':
      return t('database.propTypeDesc.file');
    case 'richCanvas':
      return t('database.propTypeDesc.richCanvas');
    case 'button':
      return t('database.propTypeDesc.button');
    default:
      return '';
  }
}

export function searchPropertyTypes(query: string, candidates: readonly PropType[] = PROP_TYPES): PropType[] {
  const folded = foldText(query.trim());
  if (!folded) return [...candidates];

  return candidates.filter((type) => {
    const label = propLabel(type);
    if (foldText(label).includes(folded)) return true;
    if (foldText(type).includes(folded)) return true;
    const desc = propertyTypeDescription(type);
    if (foldText(desc).includes(folded)) return true;
    const aliases = PROP_TYPE_ALIASES[type] ?? [];
    return aliases.some((alias) => foldText(alias).includes(folded));
  });
}

export function PropertyTypeSelect({
  value,
  onChange,
  disabled = false,
  className,
  label = t('database.type'),
}: {
  value: PropType;
  onChange: (type: PropType) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => searchPropertyTypes(query, PROP_TYPES), [query]);

  const selectType = (type: PropType) => {
    onChange(type);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = filtered[activeIndex];
      if (current) selectType(current);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const SelectedIcon = TYPE_ICONS[value] ?? Type;

  return (
    <div className={`property-type-select-shell ${className ?? ''}`}>
      <button
        type="button"
        className="button select-button property-type-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          setAnchor(event.currentTarget);
          setQuery('');
          const idx = PROP_TYPES.indexOf(value);
          setActiveIndex(idx >= 0 ? idx : 0);
          setOpen(true);
        }}
      >
        <span className="prop-type-select-val">
          <SelectedIcon size={14} className="prop-type-icon" />
          <span>{propLabel(value)}</span>
        </span>
        <ChevronDown size={13} className="select-arrow" />
      </button>

      {open && anchor && (
        <Popover
          anchor={anchor}
          onClose={() => setOpen(false)}
          className="db-panel property-type-popover"
          label={label}
        >
          <div className="property-type-search-wrap">
            <input
              type="text"
              className="text-input small property-type-search-input"
              data-autofocus
              placeholder={t('database.searchPropertyType')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              aria-label={t('database.searchPropertyType')}
            />
          </div>

          <div
            className="property-type-list"
            role="listbox"
            ref={listRef}
            aria-label={t('database.propertyTypes')}
          >
            {filtered.map((type, index) => {
              const Icon = TYPE_ICONS[type] ?? Type;
              const isSelected = type === value;
              const isActive = index === activeIndex;
              const desc = propertyTypeDescription(type);

              return (
                <button
                  key={type}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`property-type-item${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                  onClick={() => selectType(type)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <Icon size={16} className="prop-type-item-icon" />
                  <div className="prop-type-item-text">
                    <span className="prop-type-item-title">{propLabel(type)}</span>
                    {desc && <small className="prop-type-item-desc">{desc}</small>}
                  </div>
                </button>
              );
            })}

            {filtered.length === 0 && (
              <p className="property-type-empty muted small">
                {t('database.noMatchingPropertyType')}
              </p>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
