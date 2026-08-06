import { createJiraSessionStarter } from './session-start.js';
import { createJiraStatusUpdates } from './status-updates.js';
import { createJiraIssueListener } from './issue-listener.js';
import { registerJiraRoutes } from './routes.js';

/**
 * Composes the Jira integration: issue-to-session starter, lifecycle status
 * updates, the polling issue listener, and the `/api/jira/*` routes.
 */
export function createJiraIntegrationRuntime({ sessionService, globalEventHub, ensureEventStream }) {
  const statusUpdates = createJiraStatusUpdates({ globalEventHub, ensureEventStream });
  const sessionStarter = createJiraSessionStarter({ sessionService, statusUpdates });
  const listener = createJiraIssueListener({ sessionStarter });

  return {
    registerRoutes: (app) => registerJiraRoutes(app, { sessionStarter }),
    start: () => listener.start(),
    stop: () => {
      listener.stop();
      statusUpdates.stop();
    },
    sessionStarter,
    statusUpdates,
    listener,
  };
}
