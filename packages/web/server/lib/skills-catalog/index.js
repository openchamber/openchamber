/**
 * Skills catalog module
 *
 * Provides skill scanning, installation, and caching from GitHub repositories and ClawdHub.
 */

export {
  CURATED_SKILLS_SOURCES,
  getCuratedSkillsSources,
} from './curated-sources.js';

export {
  getCacheKey,
  getCachedScan,
  setCachedScan,
  clearCache,
} from './cache.js';

export {
  parseSkillRepoSource,
} from './source.js';

export {
  scanSkillsRepository,
} from './scan.js';

export {
  installSkillsFromRepository,
} from './install.js';

export {
  scanClawdHub,
  scanClawdHubPage,
  installSkillsFromClawdHub,
  fetchClawdHubSkills,
  fetchClawdHubSkillVersion,
  fetchClawdHubSkillInfo,
  downloadClawdHubSkill,
  isClawdHubSource,
  CLAWDHUB_SOURCE_ID,
  CLAWDHUB_SOURCE_STRING,
} from './clawdhub/index.js';
