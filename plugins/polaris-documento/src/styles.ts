export const styles = String.raw`
/* Page links use the host's existing anchors and retain their click behavior. */
.prose a.page-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  background: transparent;
  border-radius: 0;
  padding: 0;
  cursor: pointer;
  font-weight: 500;
}

.prose a.page-link:hover {
  text-decoration-color: var(--accent);
  background: transparent;
}

.prose a.page-link.is-missing {
  color: var(--text-faint);
  background: transparent;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  cursor: default;
}

.prose a.page-link.is-unresolved {
  color: var(--text-muted);
  background: transparent;
  border-bottom: 0;
  text-decoration-style: dashed;
  border-radius: 0;
}

.prose a.page-link.is-unresolved:hover {
  color: var(--accent-strong);
  background: transparent;
  text-decoration-color: var(--accent);
}

.prose a.page-link:focus-visible,
.relation-chip:focus-visible {
  border-radius: 2px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Database renderers own relation meaning and actions; this plugin owns their shared appearance. */
.relation-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0;
  border-radius: 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--text);
  background: transparent;
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.relation-chip:hover {
  color: var(--accent-strong);
  background: transparent;
  text-decoration-color: var(--accent);
}

.relation-chip.is-missing {
  color: var(--text-faint);
  cursor: default;
  text-decoration-style: dotted;
}
`;
