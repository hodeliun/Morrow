const EDITOR_EVENTS = new Set(['copy', 'cut', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'paste']);
const LINKED_VIEW_CONTROLS =
  '.linked-database-view button, .linked-database-view input, .linked-database-view select, .linked-database-view textarea, .linked-database-view [contenteditable="true"]';

export function shouldStopLinkedDatabaseControlEvent(event: Event): boolean {
  if (EDITOR_EVENTS.has(event.type)) return false;
  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  return typeof target?.closest === 'function' && target.closest(LINKED_VIEW_CONTROLS) !== null;
}
