export const styles = String.raw`
/* Saved legacy note styles are read-only DOM projections from the host. The plugin owns these rules. */
.page[data-polaris-note-page-id][data-polaris-note-style="saved"] .prose {
  font-size: calc(var(--polaris-note-font-size) * var(--text-scale, 1));
  line-height: var(--polaris-note-line-height);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"] .prose > * + * {
  margin-top: var(--polaris-note-block-spacing);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"] .prose :is(h1, h2, h3, h4, h5, h6) {
  margin-top: calc(var(--polaris-note-block-spacing) * 1.8);
  margin-bottom: calc(var(--polaris-note-block-spacing) * 0.7);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="sans"] .prose :is(h1, h2, h3, h4, h5, h6) {
  font-weight: 700;
  letter-spacing: -0.02em;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="serif"] .prose :is(h1, h2, h3, h4, h5, h6),
.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="mono"] .prose :is(h1, h2, h3, h4, h5, h6) {
  font-weight: 650;
  letter-spacing: -0.012em;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"] {
  padding-left: 56px;
  padding-right: 56px;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="serif"] .prose {
  font-family: var(--font-serif);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="sans"] .prose {
  font-family: var(--font-ui);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="serif"] .page-title {
  font-family: var(--font-serif);
  font-size: calc(40px * var(--text-scale, 1));
  font-weight: 700;
  letter-spacing: -0.022em;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="sans"] .page-title {
  font-family: var(--font-ui);
  font-size: calc(40px * var(--text-scale, 1));
  font-weight: 600;
  letter-spacing: -0.02em;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="mono"] .prose {
  font-family: var(--font-mono);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="mono"] .page-title {
  font-family: var(--font-mono);
  font-size: calc(32px * var(--text-scale, 1));
  font-weight: 600;
  letter-spacing: -0.02em;
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-width="comfortable"] {
  --page-width: 720px;
  max-width: calc(var(--page-width) + 112px);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-width="wide"] {
  --page-width: 980px;
  max-width: calc(var(--page-width) + 112px);
}

.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-width="full"] {
  --page-width: 100%;
  max-width: none;
}

.pane[data-size="narrow"] .page[data-polaris-note-page-id][data-polaris-note-style="saved"] {
  padding-left: 28px;
  padding-right: 28px;
}

.pane[data-size="narrow"] .page[data-polaris-note-page-id][data-polaris-note-style="saved"] .page-title {
  font-size: calc(30px * var(--text-scale, 1));
}

@media (max-width: 800px) {
  .page[data-polaris-note-page-id][data-polaris-note-style="saved"] {
    padding-left: 20px;
    padding-right: 20px;
  }

  .page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font] .page-title {
    font-size: calc(32px * var(--text-scale, 1));
  }
}

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
