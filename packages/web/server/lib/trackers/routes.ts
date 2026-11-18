import express from 'express';

import { renderOauthCallbackPage, requestOrigin } from '../guests/routes.js';
import { isPlainObject, isString } from '../shared/guards.js';
import { TrackerRouteError } from './route-error.js';
import { hasErrorMessage } from '../guests/input-guards.js';

import type { Application, Request, RequestHandler } from '../shared/http-contracts.js';
import type { TrackerRegistry, TrackerDescriptor, TrackerPeopleFilter, TrackerPriorityFilter, TrackerSessionStatusInput, TrackerSessionStatusKind } from './tracker-contract.js';
import type { RegisteredTrackerImplementation } from './registry.js';

type TrackerParams = { provider: string };
type TrackerHandler = RequestHandler<unknown, TrackerParams>;
type RouteContext<Tracker = RegisteredTrackerImplementation> = { req: Request<unknown, TrackerParams>; descriptor: TrackerDescriptor; tracker: Tracker };
type TokenTracker = RegisteredTrackerImplementation & { auth: { connectToken: NonNullable<RegisteredTrackerImplementation['auth']['connectToken']> } };
type OAuthTracker = RegisteredTrackerImplementation & { auth: { setOAuthClient: NonNullable<RegisteredTrackerImplementation['auth']['setOAuthClient']> } };
type MappingTracker = RegisteredTrackerImplementation & { mapping: NonNullable<RegisteredTrackerImplementation['mapping']> };
type PreferencesTracker = RegisteredTrackerImplementation & { preferences: NonNullable<RegisteredTrackerImplementation['preferences']> };
type SessionStatusTracker = RegisteredTrackerImplementation & { sessionStatus: NonNullable<RegisteredTrackerImplementation['sessionStatus']> };

const JSON_LIMIT = '16kb';
const PEOPLE_FILTERS: ReadonlySet<string> = new Set(['any', 'me', 'created']);
const PRIORITY_FILTERS: ReadonlySet<string> = new Set(['all', 'none', 'urgent', 'high', 'medium', 'low']);
const SESSION_STATUS_KINDS: ReadonlySet<string> = new Set(['started', 'completed', 'failure']);
const isPeopleFilter = (value: string): value is TrackerPeopleFilter => PEOPLE_FILTERS.has(value);
const isPriorityFilter = (value: string): value is TrackerPriorityFilter => PRIORITY_FILTERS.has(value);
const isSessionStatusKind = (value: string): value is TrackerSessionStatusKind => SESSION_STATUS_KINDS.has(value);

const invalid = (message: string) => new TrackerRouteError(400, 'INVALID', message);
const BOUNDS = Object.freeze({ token: 4_096, username: 256, instance: 2_048, clientId: 512, clientSecret: 4_096, projectPath: 4_096, containerId: 256 });
const hasStringLength = (value: unknown): value is { length?: unknown } => isString(value);
const bounded = <T>(value: T, max: number, name: string) => {
  if (hasStringLength(value) && Number(value.length) > max) throw invalid(`${name} is too long`);
  return value;
};
const unsupported = () => new TrackerRouteError(404, 'UNSUPPORTED', 'This tracker does not support this action');

const readString = <T>(value: T) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return isString(raw) ? String(raw).trim() : '';
};

const queryValue = (req: Request, key: string) => readString(req.query?.[key]);

const isUserError = (error: unknown): error is { code?: unknown; userError?: unknown; message?: unknown } => error !== null
  && (typeof error === 'object' || typeof error === 'function')
  && (('code' in error && error.code === 'INVALID') || ('userError' in error && error.userError === true));

function readListOptions(req: Request, descriptor: TrackerDescriptor) {
  const state = queryValue(req, 'state') || 'open';
  if (!descriptor.stateFilters.includes(state)) throw invalid(`Unknown state filter: ${state}`);
  const people = queryValue(req, 'people') || 'any';
  if (!isPeopleFilter(people)) throw invalid(`Unknown people filter: ${people}`);
  if (people !== 'any' && !descriptor.capabilities.filters.people) throw invalid('This tracker has no people filter');
  const priority = queryValue(req, 'priority') || 'all';
  if (!isPriorityFilter(priority)) throw invalid(`Unknown priority filter: ${priority}`);
  if (priority !== 'all' && !descriptor.capabilities.filters.priority) throw invalid('This tracker has no priority filter');
  return {
    query: queryValue(req, 'query') || undefined,
    cursor: queryValue(req, 'cursor') || undefined,
    state,
    people,
    priority,
    containerId: queryValue(req, 'containerId') || null,
  };
}

export function registerTrackerRoutes(app: Application, { registry }: { registry: TrackerRegistry }) {
  const parseJsonBody = express.json({ limit: JSON_LIMIT });

  function handle<Tracker extends RegisteredTrackerImplementation, Result>(action: string, run: (context: RouteContext<Tracker>) => Result, supports: (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation) => tracker is Tracker): TrackerHandler;
  function handle<Result>(action: string, run: (context: RouteContext) => Result, supports?: (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation) => boolean): TrackerHandler;
  function handle<Result>(action: string, run: (context: RouteContext) => Result, supports: (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation) => boolean = () => true): TrackerHandler {
    return async (req, res) => {
      try {
        const descriptor = registry.descriptor(req.params.provider);
        if (!descriptor) {
          return res.status(404).json({ error: 'Unknown tracker', code: 'UNKNOWN_TRACKER' });
        }
        const tracker = await registry.implementation(descriptor.id);
        if (!tracker) throw new TypeError('Tracker implementation is missing');
        if (!supports(descriptor, tracker)) throw unsupported();
        return res.json(await run({ req, descriptor, tracker }));
      } catch (error) {
        if (error instanceof TrackerRouteError) {
          return res.status(error.status).json({ error: error.message, code: error.code });
        }
        if (isUserError(error)) {
          return res.status(400).json({ error: error.message, code: 'INVALID' });
        }
        console.error(`Failed to ${action} (tracker ${req.params.provider}):`, error);
        return res.status(500).json({ error: (hasErrorMessage(error) ? error.message : undefined) || `Failed to ${action}` });
      }
    };
  }

  const readBody = (req: Request) => (isPlainObject(req.body) ? req.body : {});

  app.get('/api/tracker/providers', (_req, res) => {
    res.json({ providers: registry.descriptors() });
  });

  app.get('/api/tracker/:provider/auth/status', handle('read auth status', ({ req, tracker }) => tracker.auth.status({ origin: requestOrigin(req) || null })));

  app.post('/api/tracker/:provider/auth/start', parseJsonBody, handle('start authorization', ({ req, tracker }) => {
    const body = readBody(req);
    return tracker.auth.start({
      origin: body.origin === 'desktop' ? 'desktop' : 'web',
      callbackOrigin: requestOrigin(req) || null,
      instance: bounded(readString(body.instance), BOUNDS.instance, 'instance') || undefined,
    });
  }));

  const takesToken = (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation): tracker is TokenTracker => descriptor.authMethods.includes('token') && tracker.auth.connectToken instanceof Function;
  app.post('/api/tracker/:provider/auth/token', parseJsonBody, handle('connect a token', ({ req, tracker }) => {
    const body = readBody(req);
    return tracker.auth.connectToken({
      instance: bounded(readString(body.instance), BOUNDS.instance, 'instance') || undefined,
      token: bounded(isString(body.token) ? body.token : '', BOUNDS.token, 'token'),
      username: bounded(readString(body.username), BOUNDS.username, 'username') || undefined,
    });
  }, takesToken));

  const takesOauth = (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation): tracker is OAuthTracker => descriptor.authMethods.includes('oauth') && tracker.auth.setOAuthClient instanceof Function;
  app.put('/api/tracker/:provider/auth/oauth-client', parseJsonBody, handle('save the OAuth client', ({ req, tracker }) => {
    const body = readBody(req);
    return tracker.auth.setOAuthClient({
      instance: bounded(readString(body.instance), BOUNDS.instance, 'instance') || undefined,
      clientId: bounded(isString(body.clientId) ? body.clientId : '', BOUNDS.clientId, 'clientId'),
      clientSecret: bounded(isString(body.clientSecret) ? body.clientSecret : '', BOUNDS.clientSecret, 'clientSecret'),
    });
  }, takesOauth));

  app.get<unknown, TrackerParams>('/api/tracker/:provider/oauth/callback', async (req, res) => {
    const finish = <Message>(status: number, title: string, message: Message) => {
      res.status(status).type('html').send(renderOauthCallbackPage({ title, message }));
    };
    try {
      const descriptor = registry.descriptor(req.params.provider);
      const tracker = descriptor ? await registry.implementation(descriptor.id) : null;
      if (!tracker || !(tracker.auth.completeAuthorization instanceof Function)) {
        return finish(404, 'Unknown tracker', 'That tracker is not installed.');
      }
      await tracker.auth.completeAuthorization({
        code: queryValue(req, 'code'),
        state: queryValue(req, 'state'),
        error: queryValue(req, 'error'),
        errorDescription: queryValue(req, 'error_description'),
      });
      return finish(200, 'Connected', 'You can close this tab and return to OpenChamber.');
    } catch (error) {
      if (error instanceof TrackerRouteError || isUserError(error)) {
        return finish(400, 'Could not connect', error.message);
      }
      console.error(`Failed to finish the sign-in (tracker ${req.params.provider}):`, error);
      return finish(500, 'Could not connect', 'The authorization callback failed.');
    }
  });

  app.post('/api/tracker/:provider/auth/activate', parseJsonBody, handle('switch account', async ({ req, tracker }) => {
    const accountId = readString(readBody(req).accountId);
    if (!accountId) throw invalid('accountId is required');
    const status = await tracker.auth.activate(accountId);
    if (!status) throw new TrackerRouteError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return status;
  }, (descriptor) => descriptor.capabilities.multipleAccounts));

  app.delete('/api/tracker/:provider/auth', handle('disconnect', ({ tracker }) => tracker.auth.disconnect()));

  app.get('/api/tracker/:provider/items/list', handle('list items', ({ req, descriptor, tracker }) => (
    tracker.list(readListOptions(req, descriptor))
  )));

  app.get('/api/tracker/:provider/items/get', handle('load item', ({ req, tracker }) => {
    const id = queryValue(req, 'id');
    if (!id) throw invalid('id is required');
    return tracker.get(id);
  }));

  app.post('/api/tracker/:provider/items/update', parseJsonBody, handle('update item', ({ req, tracker }) => {
    const body = readBody(req);
    const id = readString(body.id);
    const stateId = readString(body.stateId);
    if (!id || !stateId) throw invalid('id and stateId are required');
    return tracker.updateState({ id, stateId });
  }, (descriptor) => descriptor.capabilities.stateUpdate));

  app.get('/api/tracker/:provider/states', handle('load workflow states', ({ req, tracker }) => {
    const containerId = queryValue(req, 'containerId');
    if (!containerId) throw invalid('containerId is required');
    return tracker.states(containerId);
  }, (descriptor) => descriptor.capabilities.stateUpdate));

  const hasMapping = (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation): tracker is MappingTracker => descriptor.capabilities.projectMapping && Boolean(tracker.mapping);
  app.get('/api/tracker/:provider/mapping', handle('load project mapping', ({ tracker }) => tracker.mapping.get(), hasMapping));
  app.put('/api/tracker/:provider/mapping', parseJsonBody, handle('save project mapping', ({ req, tracker }) => {
    if (!isPlainObject(req.body)) throw invalid('Mapping body must be an object');
    const containerProjectPaths = req.body.containerProjectPaths ?? {};
    if (!isPlainObject(containerProjectPaths)) throw invalid('containerProjectPaths must be an object');
    for (const [containerId, projectPath] of Object.entries(containerProjectPaths)) {
      bounded(containerId, BOUNDS.containerId, 'container id');
      bounded(projectPath, BOUNDS.projectPath, 'project path');
    }
    return tracker.mapping.set({
      defaultProjectPath: bounded(req.body.defaultProjectPath ?? null, BOUNDS.projectPath, 'defaultProjectPath'),
      containerProjectPaths,
    });
  }, hasMapping));

  const hasPreferences = (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation): tracker is PreferencesTracker => descriptor.capabilities.sessionComments && Boolean(tracker.preferences);
  app.get('/api/tracker/:provider/preferences', handle('load preferences', ({ tracker }) => tracker.preferences.get(), hasPreferences));
  app.put('/api/tracker/:provider/preferences', parseJsonBody, handle('save preferences', ({ req, tracker }) => {
    const sessionComments = readBody(req).sessionComments;
    if (sessionComments !== true && sessionComments !== false) throw invalid('sessionComments must be a boolean');
    return tracker.preferences.set({ sessionComments });
  }, hasPreferences));

  const hasSessionStatus = (descriptor: TrackerDescriptor, tracker: RegisteredTrackerImplementation): tracker is SessionStatusTracker => descriptor.capabilities.sessionComments && Boolean(tracker.sessionStatus);
  app.post('/api/tracker/:provider/session-status', parseJsonBody, handle('post session status', ({ req, tracker }) => {
    const body = readBody(req);
    const kind = readString(body.kind);
    const sessionId = readString(body.sessionId);
    if (!isSessionStatusKind(kind)) throw invalid('kind must be started, completed or failure');
    if (!sessionId) throw invalid('sessionId is required');
    const identifier = readString(body.identifier);
    if (identifier.length > 128) throw invalid('identifier is too long');
    const sessionOrigin = readString(body.sessionOrigin);
    const input: TrackerSessionStatusInput = { kind, sessionId };
    if (identifier) input.identifier = identifier;
    if (sessionOrigin) input.sessionOrigin = sessionOrigin;
    return tracker.sessionStatus.post(input);
  }, hasSessionStatus));


  app.use('/api/tracker', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });
}
