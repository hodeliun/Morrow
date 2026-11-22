export const inlineColorStyles = String.raw`
/* Keep legacy colorful-mode heading accents out of authored title text. The H2 marker remains independent. */
:root[data-colorful='true'] .prose h1,
:root[data-colorful='true'] .prose h2,
:root[data-colorful='true'] .prose h3,
:root[data-colorful='true'] .prose h4,
:root[data-colorful='true'] .prose h5,
:root[data-colorful='true'] .prose h6 {
  color: inherit;
}

/* The native editor dims H6; legacy titles inherited the page text color in either mode. */
.prose h6 {
  color: inherit;
}

.color-custom-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}

.color-custom-picker {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.color-custom-picker:hover,
.color-hex-input:hover {
  border-color: var(--border-strong);
}

.color-custom-picker:focus-within,
.color-hex-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.color-custom-picker input[type='color'] {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: inherit;
}

.color-hex-input {
  width: 72px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font: 11px var(--font-mono);
}

.color-custom-control.is-invalid .color-hex-input {
  border-color: var(--accent-strong);
}

.color-custom-control :disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
`;
