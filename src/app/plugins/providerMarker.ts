export function selectedProviderMarker(value: unknown): { provider: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as { version?: unknown; provider?: unknown } & Record<string, unknown>;
  if (Object.keys(marker).some((key) => key !== 'version' && key !== 'provider')) return null;
  return marker.version === 1 && typeof marker.provider === 'string' ? { provider: marker.provider } : null;
}
