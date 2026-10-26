import type { TrackerDescriptor } from './types';

/** Linear as the server describes it (`server/lib/linear/tracker.js`). */
export const linearLikeTrackerDescriptor = (overrides: Partial<TrackerDescriptor> = {}): TrackerDescriptor => ({
  id: 'linear',
  name: 'Linear',
  authMethods: ['oauth'],
  capabilities: {
    multipleAccounts: true,
    stateUpdate: true,
    children: true,
    labels: true,
    priority: true,
    filters: { people: true, priority: true },
    projectMapping: true,
    sessionComments: true,
    hostAccess: true,
  },
  stateFilters: ['open', 'all', 'backlog', 'todo', 'in-progress', 'inReview', 'done', 'canceled', 'duplicate'],
  urlPatterns: [{ host: 'linear.app', path: '^/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
  ...overrides,
});

/** A tracker the UI has no presentation for: token auth, no extras, its own links. */
export const acmeTrackerDescriptor = (overrides: Partial<TrackerDescriptor> = {}): TrackerDescriptor => ({
  id: 'acme-tickets',
  name: 'Acme Tickets',
  authMethods: ['token'],
  capabilities: {
    multipleAccounts: false,
    stateUpdate: false,
    children: false,
    labels: false,
    priority: false,
    filters: { people: false, priority: false },
    projectMapping: false,
    sessionComments: false,
    hostAccess: false,
  },
  stateFilters: ['open', 'all', 'done'],
  urlPatterns: [{ host: 'tickets.example.com', path: '^/t/([A-Z]+-\\d+)$' }],
  identifierPattern: '^[A-Z]+-\\d+$',
  ...overrides,
});
