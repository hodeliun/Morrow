export const fileCatalogStyles = `
.polaris-arquivos-tree,
.polaris-arquivos-tree ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.polaris-arquivos-tree ul {
  margin-left: 12px;
}

.polaris-arquivos-header,
.polaris-arquivos-settings-heading,
.polaris-arquivos-mode,
.polaris-arquivos-add-controls,
.polaris-arquivos-settings-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.polaris-arquivos-header {
  justify-content: space-between;
}

.polaris-arquivos-header .sidebar-heading {
  flex: 1;
  min-width: 0;
}

.polaris-arquivos-settings-toggle,
.polaris-arquivos-settings-close,
.polaris-arquivos-mode-button,
.polaris-arquivos-add-button,
.polaris-arquivos-reset,
.polaris-arquivos-retry-discovery {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
  font-size: var(--text-xs);
  padding: 3px 6px;
}

.polaris-arquivos-settings-toggle:hover,
.polaris-arquivos-settings-close:hover,
.polaris-arquivos-mode-button:hover,
.polaris-arquivos-add-button:hover,
.polaris-arquivos-reset:hover,
.polaris-arquivos-retry-discovery:hover {
  background: var(--hover);
  color: var(--text);
}

.polaris-arquivos-settings-toggle:focus-visible,
.polaris-arquivos-settings-close:focus-visible,
.polaris-arquivos-mode-button:focus-visible,
.polaris-arquivos-add-button:focus-visible,
.polaris-arquivos-reset:focus-visible,
.polaris-arquivos-retry-discovery:focus-visible,
.polaris-arquivos-search:focus-visible,
.polaris-arquivos-type input:focus-visible,
.polaris-arquivos-switch input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.polaris-arquivos-mode-button.is-selected {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.polaris-arquivos-settings {
  display: grid;
  gap: 8px;
  margin: 2px 4px 8px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.polaris-arquivos-settings-heading {
  justify-content: space-between;
}

.polaris-arquivos-settings-heading h3 {
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
}

.polaris-arquivos-mode {
  flex-wrap: wrap;
}

.polaris-arquivos-switch,
.polaris-arquivos-type {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.polaris-arquivos-settings-label {
  display: grid;
  gap: 4px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.polaris-arquivos-search {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--text-sm);
  padding: 5px 7px;
}

.polaris-arquivos-add-controls {
  align-items: stretch;
}

.polaris-arquivos-add-controls .polaris-arquivos-search {
  flex: 1;
}

.polaris-arquivos-types {
  min-width: 0;
  margin: 0;
  padding: 5px 7px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.polaris-arquivos-types legend {
  padding: 0 3px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.polaris-arquivos-type-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 8px;
  max-height: 180px;
  overflow: auto;
}

.polaris-arquivos-discovery-status {
  display: grid;
  gap: 4px;
}

.polaris-arquivos-settings-actions {
  justify-content: flex-end;
}

.polaris-arquivos-row {
  display: block;
  min-width: 0;
  align-items: center;
  min-height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.polaris-arquivos-file-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 2px;
}

.polaris-arquivos-row:hover {
  background: var(--hover);
  color: var(--text);
}

.polaris-arquivos-folder-button,
.polaris-arquivos-more,
.polaris-arquivos-retry {
  min-width: 0;
  color: inherit;
  text-align: left;
}

.polaris-arquivos-folder-button {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 26px;
  padding: 2px 6px;
}

.polaris-arquivos-chevron {
  flex: 0 0 12px;
  color: var(--text-faint);
  text-align: center;
}

.polaris-arquivos-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.polaris-arquivos-file-name {
  display: block;
  flex: 1 1 auto;
  width: 0;
  padding: 5px 6px 5px 23px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.polaris-arquivos-file-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding-right: 3px;
}

.polaris-arquivos-file-action {
  color: var(--accent-strong);
  font-size: var(--text-xs);
  text-decoration: underline;
  text-decoration-color: var(--accent-line);
  text-underline-offset: 2px;
}

.polaris-arquivos-file-open {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  text-decoration-color: transparent;
}

.polaris-arquivos-file-open:hover {
  text-decoration-color: var(--accent-line);
}

.polaris-arquivos-file-reveal {
  width: 24px;
  min-height: 22px;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  line-height: 1;
  text-decoration: none;
}

.polaris-arquivos-file-reveal:hover {
  background: var(--hover);
}

.polaris-arquivos-file-action[aria-disabled='true'] {
  color: var(--text-faint);
  cursor: wait;
}

.polaris-arquivos-action-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 2px 4px 8px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.polaris-arquivos-message {
  margin: 2px 0;
  padding: 4px 6px;
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.polaris-arquivos-actions {
  display: flex;
  gap: 8px;
  padding: 2px 6px;
}

.polaris-arquivos-more,
.polaris-arquivos-retry {
  padding: 3px 0;
  color: var(--accent-strong);
  font-size: var(--text-xs);
  text-decoration: underline;
  text-decoration-color: var(--accent-line);
  text-underline-offset: 2px;
}

.polaris-arquivos-folder-button:focus-visible,
.polaris-arquivos-more:focus-visible,
.polaris-arquivos-retry:focus-visible,
.polaris-arquivos-file-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
`;
