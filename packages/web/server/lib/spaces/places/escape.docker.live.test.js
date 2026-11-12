import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';
import { runEscapeSuite } from './escape-suite.js';

runEscapeSuite('docker (live)', {
  enabled: LIVE_DOCKER_ENABLED,
  setup: async () => createLiveDockerPlace(),
});
