import { Check, Play, Plus, RefreshCw, Undo2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDisplayValue } from '../../../core/database';
import { BACKGROUND_HEX, displayTitle, TEXT_HEX } from '../../../core/model';
import type { PageId, PageMeta, PropDef, TableActionIcon } from '../../../core/model';
import { planTableAction, tableActionAvailability } from '../../../core/tableActions';
import type { TableActionPlan } from '../../../core/tableActions';
import { readTableActionJournal, recoverTableAction, undoTableAction } from '../../../storage/tableActions';
import type { TableActionJournal } from '../../../storage/tableActions';
import { newId } from '../../platform/files';
import { getLocale, t } from '../../i18n';
import { getSession, getState, useWorkspace } from '../../workspace';
import { executeTableAction } from '../../../storage/tableActions';

const ACTION_ICONS: Record<TableActionIcon, LucideIcon> = {
  play: Play,
  plus: Plus,
  check: Check,
  refresh: RefreshCw,
};

export function ButtonActionCell({
  dbId,
  prop,
  row,
  editable,
}: {
  dbId: PageId;
  prop: PropDef;
  row: PageMeta;
  editable: boolean;
}) {
  const state = useWorkspace();
  const action = prop.action;
  const Icon = ACTION_ICONS[action?.icon ?? 'play'];
  const availability = tableActionAvailability(state, dbId, row.id, prop);
  const [preview, setPreview] = useState<{ plan: TableActionPlan; signature: string; now: number } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useRef<PageId[]>([]);

  const makePlan = useCallback(
    (now: number) => {
      let cursor = 0;
      const result = planTableAction(
        getState(),
        dbId,
        row.id,
        prop.id,
        () => {
          const id = ids.current[cursor] ?? newId();
          ids.current[cursor] = id;
          cursor++;
          return id;
        },
        now,
      );
      ids.current.length = cursor;
      return result;
    },
    [dbId, prop.id, row.id],
  );

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (busy || !editable || availability.disabled) return;
    setMessage('');
    const now = Date.now();
    const result = makePlan(now);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    setPreview({ plan: result.value, signature: planSignature(result.value), now });
  };

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setMessage(t('database.actionSaving'));
    try {
      const latest = makePlan(preview.now);
      if (!latest.ok) {
        setMessage(latest.error);
        return;
      }
      const signature = planSignature(latest.value);
      if (signature !== preview.signature) {
        setPreview({ ...preview, plan: latest.value, signature });
        setMessage(t('database.actionPreviewStale'));
        return;
      }
      const result = await executeTableAction(getSession(), latest.value, preview.now);
      if (result.status === 'saved') {
        setPreview(null);
        setMessage(t('database.actionSaved'));
        ids.current = [];
      } else if (result.status === 'pending') {
        setPreview(null);
        setMessage(t('database.actionSavePending'));
        window.dispatchEvent(new Event('morrow-table-action-changed'));
      } else if (result.status === 'stale') {
        const updated = makePlan(preview.now);
        if (updated.ok)
          setPreview({ ...preview, plan: updated.value, signature: planSignature(updated.value) });
        setMessage(t('database.actionPreviewStale'));
      } else {
        setMessage(result.message);
      }
      if (result.status === 'saved') window.dispatchEvent(new Event('morrow-table-action-changed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="button small table-action-button"
        style={{
          color: TEXT_HEX[action?.color ?? 'blue'],
          backgroundColor: BACKGROUND_HEX[action?.color ?? 'blue'],
        }}
        aria-label={`${action?.label || prop.name}: ${displayTitle(row)}`}
        title={availability.reason ?? action?.label ?? prop.name}
        disabled={!editable || busy || availability.disabled}
        onClick={openPreview}
      >
        <Icon size={14} aria-hidden="true" />
        {action?.label || prop.name}
      </button>
      {message && !preview && (
        <span className="table-action-message" role="status">
          {message}
        </span>
      )}
      {preview && (
        <div
          className="table-action-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && !busy && setPreview(null)}
        >
          <section
            className="table-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`table-action-title-${prop.id}-${row.id}`}
            onKeyDown={(event) => event.key === 'Escape' && !busy && setPreview(null)}
          >
            <header className="table-action-dialog-header">
              <h2 id={`table-action-title-${prop.id}-${row.id}`}>
                {t('database.actionPreviewTitle', { name: action?.label || prop.name })}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t('common.close')}
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="table-action-preview">
              {preview.plan.steps.map((step, index) => (
                <section className="table-action-preview-step" key={step.id}>
                  <strong>{t('database.actionStepName', { index: index + 1 })}</strong>
                  {step.rows.length > 0 && (
                    <ul>
                      {step.rows.map((item) => (
                        <li key={item.id}>
                          <strong>{displayTitle(item)}</strong>
                          <ActionRowChanges row={item} plan={preview.plan} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {step.controlNames.length > 0 && <p>{step.controlNames.join(', ')}</p>}
                </section>
              ))}
            </div>
            {message && (
              <p className="table-action-message" role="status">
                {message}
              </p>
            )}
            <footer className="table-action-dialog-actions">
              <button type="button" className="button small" disabled={busy} onClick={() => setPreview(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="button small primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? t('database.actionSaving') : t('database.actionPreviewConfirm')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function ActionRowChanges({ row, plan }: { row: PageMeta; plan: TableActionPlan }) {
  const record = plan.records.find((item) => item.id === row.id);
  if (!record?.after) return null;
  const page = getState().pages[plan.databaseId];
  const properties = page?.database?.properties ?? [];
  const changed = properties.filter((prop) => {
    const before = record.before?.properties[prop.id] ?? null;
    const after = record.after?.properties[prop.id] ?? null;
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  if (changed.length === 0) return null;
  return (
    <ul className="table-action-preview-values">
      {changed.map((prop) => (
        <li key={prop.id}>
          <span>{prop.name}</span>
          <span>{formatDisplayValue(prop, record.after?.properties[prop.id] ?? null, getLocale())}</span>
        </li>
      ))}
    </ul>
  );
}

export function TableActionRecoveryNotice({ dbId }: { dbId: PageId }) {
  const [journal, setJournal] = useState<TableActionJournal | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const current = await readTableActionJournal(getSession());
    if (!current || current.databaseId !== dbId) {
      setJournal(null);
      return;
    }
    setJournal(current);
    if (current.status === 'prepared' || current.status === 'undoing') {
      setBusy(true);
      const recovered = await recoverTableAction(getSession());
      setJournal('journal' in recovered ? recovered.journal : current);
      setMessage(recoveryMessage(recovered.status));
      setBusy(false);
    }
  }, [dbId]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const onChanged = () => void refresh();
    window.addEventListener('morrow-table-action-changed', onChanged);
    return () => {
      window.clearTimeout(initialRefresh);
      window.removeEventListener('morrow-table-action-changed', onChanged);
    };
  }, [refresh]);

  if (!journal || journal.databaseId !== dbId || journal.status === 'aborted') return null;
  const recover = async () => {
    setBusy(true);
    const result = await recoverTableAction(getSession());
    if ('journal' in result) setJournal(result.journal);
    setMessage(recoveryMessage(result.status));
    setBusy(false);
  };
  const undo = async () => {
    setBusy(true);
    const result = await undoTableAction(getSession());
    if ('journal' in result) setJournal(result.journal);
    setMessage(
      result.status === 'undone'
        ? t('database.actionRecoveryUndone')
        : result.status === 'none'
          ? t('database.actionRecoveryPending')
          : result.message,
    );
    window.dispatchEvent(new Event('morrow-table-action-changed'));
    setBusy(false);
  };
  const needsRecovery =
    journal.status === 'prepared' || journal.status === 'undoing' || journal.status === 'conflict';
  const notice =
    journal.status === 'complete'
      ? t('database.actionRecoveryComplete')
      : journal.status === 'undone'
        ? t('database.actionRecoveryUndone')
        : journal.status === 'conflict'
          ? t('database.actionRecoveryConflict')
          : t('database.actionRecoveryPending');

  return (
    <aside className="table-action-recovery" role="status" aria-live="polite">
      <span>{message || notice}</span>
      {needsRecovery && (
        <button type="button" className="button small" disabled={busy} onClick={() => void recover()}>
          {t('database.actionRecover')}
        </button>
      )}
      {journal.status === 'complete' && (
        <button type="button" className="button small" disabled={busy} onClick={() => void undo()}>
          <Undo2 size={13} /> {t('database.actionUndo')}
        </button>
      )}
    </aside>
  );
}

function planSignature(plan: TableActionPlan): string {
  return JSON.stringify({ commands: plan.commands, records: plan.records });
}

function recoveryMessage(status: string): string {
  if (status === 'complete') return t('database.actionRecoveryComplete');
  if (status === 'undone') return t('database.actionRecoveryUndone');
  if (status === 'conflict') return t('database.actionRecoveryConflict');
  return t('database.actionRecoveryPending');
}
