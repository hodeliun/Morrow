export const noteStylePanelStyles = String.raw`
.note-style-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.note-style-batch-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.note-style-batch-preview h4,
.note-style-batch-preview p {
  margin: 0;
}

.note-style-batch-preview h4 {
  color: var(--text);
  font-size: var(--text-sm);
}

.note-style-batch-preview > p,
.note-style-batch-status,
.note-style-batch-diagnostics {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.note-style-batch-mode {
  display: grid;
  gap: 4px;
  color: var(--text);
  font-size: var(--text-sm);
}

.note-style-batch-mode select {
  width: 100%;
}

.note-style-batch-preview :is(select, button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.note-style-batch-result {
  display: grid;
  gap: 5px;
  color: var(--text);
  font-size: var(--text-xs);
}

.note-style-batch-count,
.note-style-batch-sample-title {
  color: var(--text);
  font-weight: 600;
}

.note-style-batch-confirmation {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-sidebar);
}

.note-style-batch-confirmation-prompt {
  color: var(--text);
  font-size: var(--text-sm);
}

.note-style-batch-confirmation-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.note-style-batch-undo-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.note-style-batch-undo-actions:empty {
  display: none;
}

.note-style-batch-result-title {
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
}

.note-style-batch-titles,
.note-style-batch-diagnostics,
.note-style-batch-result-counts,
.note-style-batch-outcomes {
  display: grid;
  gap: 3px;
  margin: 0;
  padding-inline-start: 18px;
}

.note-style-batch-outcomes {
  max-height: 240px;
  overflow: auto;
}

.note-style-batch-preview[data-busy='true'] button {
  cursor: progress;
}

.note-style-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.note-style-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  color: var(--text);
  font-size: var(--text-sm);
}

.note-style-field > span {
  grid-column: 1 / -1;
}

.note-style-field select,
.note-style-field input[type='range'] {
  grid-column: 1 / -1;
  width: 100%;
}

.note-style-field output {
  grid-column: 2;
  color: var(--text-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.note-style-panel :is(select, input, button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.note-style-preview-frame {
  margin-top: 2px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-sidebar);
}

.note-style-preview-label {
  display: block;
  margin: 0 0 6px 2px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.note-style-preview {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--note-block-spacing);
  min-height: 76px;
  margin: 0 auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: var(--note-font-size);
  line-height: var(--note-line-height);
  transition: width 180ms var(--ease);
}

.note-style-preview.font-serif {
  font-family: var(--font-serif);
}

.note-style-preview.font-sans {
  font-family: var(--font-ui);
}

.note-style-preview.font-mono {
  font-family: var(--font-mono);
}

.note-style-status {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.note-style-status.is-error {
  color: var(--accent-strong);
}

.note-style-panel[data-busy='true'] :is(select, input, button) {
  cursor: progress;
}

.note-style-panel [aria-disabled='true'] {
  opacity: 0.6;
}
`;
