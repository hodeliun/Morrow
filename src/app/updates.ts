// The private Polaris build has no update service configured.
export function startUpdateChecks(): () => void {
  return () => undefined;
}
