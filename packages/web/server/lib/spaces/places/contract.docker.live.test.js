import { runPlaceContractSuite } from './contract-suite.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

runPlaceContractSuite('docker (live)', {
  enabled: LIVE_DOCKER_ENABLED,
  setup: async () => createLiveDockerPlace(),
});
