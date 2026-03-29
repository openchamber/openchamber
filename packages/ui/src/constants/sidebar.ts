import { RiBrainAi3Line, RiChatAi3Line, RiCommandLine, RiGitBranchLine, RiSettings3Line, RiStackLine, RiBookLine, RiBarChart2Line, RiPlugLine } from '@remixicon/react';
import type { ComponentType } from 'react';

export type SidebarSection = 'sessions' | 'agents' | 'commands' | 'skills' | 'mcp' | 'providers' | 'usage' | 'git-identities' | 'settings';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IconComponent = ComponentType<any>;

export interface SidebarSectionConfig {
    id: SidebarSection;
    label: string;
    description: string;
    icon: IconComponent;
}

export const SIDEBAR_SECTIONS: SidebarSectionConfig[] = [
    {
        id: 'sessions',
        label: 'sidebar.sections.sessions.label',
        description: 'sidebar.sections.sessions.description',
        icon: RiChatAi3Line,
    },
    {
        id: 'agents',
        label: 'sidebar.sections.agents.label',
        description: 'sidebar.sections.agents.description',
        icon: RiBrainAi3Line,
    },
    {
        id: 'commands',
        label: 'sidebar.sections.commands.label',
        description: 'sidebar.sections.commands.description',
        icon: RiCommandLine,
    },
    {
        id: 'skills',
        label: 'sidebar.sections.skills.label',
        description: 'sidebar.sections.skills.description',
        icon: RiBookLine,
    },
    {
        id: 'mcp',
        label: 'sidebar.sections.mcp.label',
        description: 'sidebar.sections.mcp.description',
        icon: RiPlugLine,
    },
    {
        id: 'providers',
        label: 'sidebar.sections.providers.label',
        description: 'sidebar.sections.providers.description',
        icon: RiStackLine,
    },
    {
        id: 'usage',
        label: 'sidebar.sections.usage.label',
        description: 'sidebar.sections.usage.description',
        icon: RiBarChart2Line,
    },
    {
        id: 'git-identities',
        label: 'sidebar.sections.gitIdentities.label',
        description: 'sidebar.sections.gitIdentities.description',
        icon: RiGitBranchLine,
    },
    {
        id: 'settings',
        label: 'sidebar.sections.settings.label',
        description: 'sidebar.sections.settings.description',
        icon: RiSettings3Line,
    },
];

const sidebarSectionLabels = {} as Record<SidebarSection, string>;
const sidebarSectionDescriptions = {} as Record<SidebarSection, string>;
const sidebarSectionConfigMap = {} as Record<SidebarSection, SidebarSectionConfig>;

SIDEBAR_SECTIONS.forEach((section) => {
    sidebarSectionLabels[section.id] = section.label;
    sidebarSectionDescriptions[section.id] = section.description;
    sidebarSectionConfigMap[section.id] = section;
});

export const SIDEBAR_SECTION_LABELS = sidebarSectionLabels;
export const SIDEBAR_SECTION_DESCRIPTIONS = sidebarSectionDescriptions;
export const SIDEBAR_SECTION_CONFIG_MAP = sidebarSectionConfigMap;
