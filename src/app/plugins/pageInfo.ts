/** Each plugin page-info result gets its own nested copy of preserved frontmatter metadata. */
export function clonePluginPageProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(properties);
}
