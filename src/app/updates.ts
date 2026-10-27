// This fork build has no remote update service configured.
export function startUpdateChecks(): () => void {
  return () => undefined;
}
