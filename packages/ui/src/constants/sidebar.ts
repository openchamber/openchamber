import { RiBrainAi3Line, RiChatAi3Line, RiCommandLine, RiGitBranchLine, RiSettings3Line, RiStackLine, RiBookLine, RiBarChart2Line, RiPlugLine } from '@remixicon/react';
import type { ComponentType } from 'react';
import {
	sidebarSessions,
	sidebarAgents,
	sidebarCommands,
	sidebarSkills,
	sidebarMcp,
	sidebarProviders,
	sidebarUsage,
	sidebarGitIdentities,
	sidebarSettings,
	sidebarSessionsDesc,
	sidebarAgentsDesc,
	sidebarCommandsDesc,
	sidebarSkillsDesc,
	sidebarMcpDesc,
	sidebarProvidersDesc,
	sidebarUsageDesc,
	sidebarGitIdentitiesDesc,
	sidebarSettingsDesc,
} from '@/lib/i18n/messages';

export type SidebarSection = 'sessions' | 'agents' | 'commands' | 'skills' | 'mcp' | 'providers' | 'usage' | 'git-identities' | 'settings';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IconComponent = ComponentType<any>;

export interface SidebarSectionConfig {
    id: SidebarSection;
    label: () => string;
    description: () => string;
    icon: IconComponent;
}

export const SIDEBAR_SECTIONS: SidebarSectionConfig[] = [
    {
        id: 'sessions',
        label: sidebarSessions,
        description: sidebarSessionsDesc,
        icon: RiChatAi3Line,
    },
    {
        id: 'agents',
        label: sidebarAgents,
        description: sidebarAgentsDesc,
        icon: RiBrainAi3Line,
    },
    {
        id: 'commands',
        label: sidebarCommands,
        description: sidebarCommandsDesc,
        icon: RiCommandLine,
    },
    {
        id: 'skills',
        label: sidebarSkills,
        description: sidebarSkillsDesc,
        icon: RiBookLine,
    },
    {
        id: 'mcp',
        label: sidebarMcp,
        description: sidebarMcpDesc,
        icon: RiPlugLine,
    },
    {
        id: 'providers',
        label: sidebarProviders,
        description: sidebarProvidersDesc,
        icon: RiStackLine,
    },
    {
        id: 'usage',
        label: sidebarUsage,
        description: sidebarUsageDesc,
        icon: RiBarChart2Line,
    },
    {
        id: 'git-identities',
        label: sidebarGitIdentities,
        description: sidebarGitIdentitiesDesc,
        icon: RiGitBranchLine,
    },
    {
        id: 'settings',
        label: sidebarSettings,
        description: sidebarSettingsDesc,
        icon: RiSettings3Line,
    },
];

const sidebarSectionLabels = {} as Record<SidebarSection, () => string>;
const sidebarSectionDescriptions = {} as Record<SidebarSection, () => string>;
const sidebarSectionConfigMap = {} as Record<SidebarSection, SidebarSectionConfig>;

SIDEBAR_SECTIONS.forEach((section) => {
    sidebarSectionLabels[section.id] = section.label;
    sidebarSectionDescriptions[section.id] = section.description;
    sidebarSectionConfigMap[section.id] = section;
});

export const SIDEBAR_SECTION_LABELS = sidebarSectionLabels;
export const SIDEBAR_SECTION_DESCRIPTIONS = sidebarSectionDescriptions;
export const SIDEBAR_SECTION_CONFIG_MAP = sidebarSectionConfigMap;
