import { describe, expect, test } from 'bun:test';
import { routingTabForSearchTarget } from './routingTabs';

describe('routingTabForSearchTarget', () => {
  test('opens the tab that holds a pool or category result, and Auto for the rest of the page', () => {
    expect(routingTabForSearchTarget('pools.add-pool')).toBe('pools');
    expect(routingTabForSearchTarget('routing.pools-tuning')).toBe('pools');
    expect(routingTabForSearchTarget('routing.pools-schedules')).toBe('pools');
    expect(routingTabForSearchTarget('routing.add-category')).toBe('categories');
    expect(routingTabForSearchTarget('routing.enabled')).toBe('auto');
    expect(routingTabForSearchTarget('routing.fallback-model')).toBe('auto');
  });

  test('leaves results outside the Routing page alone', () => {
    expect(routingTabForSearchTarget('providers.connect')).toBeNull();
    expect(routingTabForSearchTarget('projects.default-agent')).toBeNull();
  });

  test('routing.token lives on Providers > Classification, not the Routing page (#1762)', () => {
    expect(routingTabForSearchTarget('routing.token')).toBeNull();
  });
});
