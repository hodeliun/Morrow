import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../../core/migrations';
import type { DatabaseDef, ViewDef } from '../../../core/model';
import { moveColumnInView } from './columnActions';
import type { ColumnInsertPosition } from './columnActions';

export function createColumnResizeGesture(
  width: number,
  startClientX: number,
  onPreview: (width: number) => void,
  onDone: (width: number) => void,
): { move: (clientX: number) => void; finish: () => void } {
  let next = width;
  let finished = false;
  return {
    move(clientX) {
      if (finished) return;
      next = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + clientX - startClientX));
      onPreview(next);
    },
    finish() {
      if (finished) return;
      finished = true;
      onDone(next);
    },
  };
}

export function commitColumnDrop(
  database: DatabaseDef,
  view: ViewDef,
  sourceId: string,
  targetId: string,
  position: ColumnInsertPosition,
  onCommit: (view: ViewDef) => void,
): boolean {
  const next = moveColumnInView(database, view, sourceId, targetId, position);
  if (!next) return false;
  onCommit(next);
  return true;
}
