import type { SettingsSearchItem } from './search';

export const SKILLS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'skills.mcp',
    page: 'skills.installed',
    titleKey: 'settings.skills.sidebar.mcpSkills',
    descriptionKey: 'settings.skills.sidebar.mcpSkillsInfo',
    keywords: ['mcp', 'mcp skills', 'server skills', 'experimental'],
  },
  {
    id: 'skills.create',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.title.newSkill',
    keywords: ['create', 'add', 'new skill'],
  },
  {
    id: 'skills.basic-information',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.basicInformation',
    keywords: ['name', 'location', 'description', 'manual', 'invocation', 'autoinvoke'],
  },
  {
    id: 'skills.instructions',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.instructions',
    keywords: ['markdown', 'skill.md', 'content'],
  },
  {
    id: 'skills.supporting-files',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.supportingFiles',
    keywords: ['files', 'resources'],
  },
  {
    id: 'skills.catalog.source',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.page.section.sourceRepository',
    keywords: ['catalog', 'repository', 'source', 'refresh'],
  },
  {
    id: 'skills.catalog.search',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.shared.field.searchSkillsPlaceholder',
    keywords: ['find skills', 'install skills', 'catalog search'],
  },
  {
    id: 'skills.catalog.add-catalog',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.page.actions.addCatalog',
    keywords: ['external repository', 'add source', 'catalog'],
  },
];
