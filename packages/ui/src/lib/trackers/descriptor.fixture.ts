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
    create: false,
    edit: false,
  },
  stateFilters: ['open', 'all', 'backlog', 'todo', 'in-progress', 'inReview', 'done', 'canceled', 'duplicate'],
  urlPatterns: [{ host: 'linear.app', path: '^/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
  ...overrides,
});

/** The local tracker as the server describes it (`server/lib/local/tracker.js`): no sign-in, always connected. */
export const localTrackerDescriptor = (overrides: Partial<TrackerDescriptor> = {}): TrackerDescriptor => ({
  id: 'local',
  name: 'Local',
  authMethods: [],
  capabilities: {
    multipleAccounts: false,
    stateUpdate: true,
    children: false,
    labels: true,
    priority: true,
    filters: { people: false, priority: true },
    projectMapping: false,
    sessionComments: true,
    hostAccess: false,
    create: true,
    edit: true,
  },
  stateFilters: ['open', 'all', 'triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled'],
  urlPatterns: [{ host: 'openchamber.local', path: '^/tracker/local/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
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
    create: false,
    edit: false,
  },
  stateFilters: ['open', 'all', 'done'],
  urlPatterns: [{ host: 'tickets.example.com', path: '^/t/([A-Z]+-\\d+)$' }],
  identifierPattern: '^[A-Z]+-\\d+$',
  ...overrides,
});
