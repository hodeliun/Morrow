const LINKED_DATABASE_NODE_VIEW = '.linked-database-block';
const GRID_INTERACTION_TARGETS =
  '.linked-database-view td[data-row-id], .linked-database-view button, .linked-database-view input, .linked-database-view select, .linked-database-view textarea, .linked-database-view [contenteditable="true"]';
const GRID_DRAG_SOURCES = '.linked-database-view .db-row-drag, .linked-database-view [draggable="true"]';
const ROW_DRAG_TYPE = 'application/x-morrow-row-ids';

const GRID_POINTER_EVENTS = new Set(['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']);
const GRID_KEY_EVENTS = new Set(['keydown', 'keypress', 'keyup']);
const GRID_CLIPBOARD_EVENTS = new Set(['copy', 'cut', 'paste']);
const GRID_INPUT_EVENTS = new Set(['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']);
const ROW_DRAG_SOURCE_EVENTS = new Set(['dragstart', 'dragend']);
const ROW_DRAG_TARGET_EVENTS = new Set(['dragover', 'drop']);

function hasRowDragPayload(event: Event): boolean {
  const types = (event as DragEvent).dataTransfer?.types;
  return types ? Array.from(types).includes(ROW_DRAG_TYPE) : false;
}

export function shouldStopLinkedDatabaseNodeViewEvent(event: Event): boolean {
  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  if (!target?.closest || !target.closest(LINKED_DATABASE_NODE_VIEW)) return false;

  if (GRID_POINTER_EVENTS.has(event.type)) return true;

  if (
    (GRID_KEY_EVENTS.has(event.type) || GRID_CLIPBOARD_EVENTS.has(event.type) || GRID_INPUT_EVENTS.has(event.type)) &&
    target.closest(GRID_INTERACTION_TARGETS)
  ) {
    return true;
  }

  if (ROW_DRAG_SOURCE_EVENTS.has(event.type) && target.closest(GRID_DRAG_SOURCES)) return true;
  if (ROW_DRAG_TARGET_EVENTS.has(event.type) && hasRowDragPayload(event)) return true;

  return false;
}
