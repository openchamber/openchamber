import { runPlaceContractSuite } from './contract-suite.js';
import { createMemoryPlace } from './memory-place.js';

runPlaceContractSuite('memory', {
  setup: async () => ({ place: createMemoryPlace(), dispose: async () => {} }),
});
