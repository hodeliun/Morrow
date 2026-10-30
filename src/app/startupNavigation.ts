import type { StartPage } from './platform/preferences';

// the launch URL is captured before restoring tabs, so a saved tab cannot impersonate an explicit link
export function startupDestination({
  launchHash,
  firstRun,
  preference,
  dailyEnabled,
}: {
  launchHash: string;
  firstRun: boolean;
  preference: StartPage;
  dailyEnabled: boolean;
}): 'keep' | 'home' | 'today' {
  if (firstRun || (launchHash && launchHash !== '#/')) return 'keep';
  if (preference === 'last') return 'keep';
  return preference === 'today' && dailyEnabled ? 'today' : 'home';
}
