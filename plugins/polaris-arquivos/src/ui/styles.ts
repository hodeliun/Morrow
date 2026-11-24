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

.polaris-arquivos-row {
  display: block;
  min-width: 0;
  align-items: center;
  min-height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
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
  padding: 5px 6px 5px 23px;
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
.polaris-arquivos-retry:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
`;
