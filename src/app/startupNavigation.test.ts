import { expect, it } from 'vitest';
import { startupDestination } from './startupNavigation';

it('applies Home and Today preferences to an ordinary launch and keeps an already restored Last route', () => {
  const ordinary = { launchHash: '#/', firstRun: false, dailyEnabled: true };
  expect(startupDestination({ ...ordinary, preference: 'home' })).toBe('home');
  expect(startupDestination({ ...ordinary, preference: 'today' })).toBe('today');
  expect(startupDestination({ ...ordinary, preference: 'last' })).toBe('keep');
  expect(startupDestination({ ...ordinary, preference: 'today', dailyEnabled: false })).toBe('home');
});

it('preserves explicit launch links and the first-run guide for every startup preference', () => {
  for (const preference of ['home', 'today', 'last'] as const) {
    expect(
      startupDestination({ launchHash: '#/page/intent', firstRun: false, dailyEnabled: true, preference }),
    ).toBe('keep');
    expect(startupDestination({ launchHash: '#/', firstRun: true, dailyEnabled: true, preference })).toBe(
      'keep',
    );
  }
});
