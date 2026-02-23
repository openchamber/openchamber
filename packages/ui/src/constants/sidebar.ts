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
        label: 'Sessions',
        description: 'Browse and manage chat sessions scoped to the current directory.',
        icon: RiChatAi3Line,
    },
    {
        id: 'agents',
        label: 'Agents',
        description: 'Configure OpenCode agents, prompts, and permissions.',
        icon: RiBrainAi3Line,
    },
    {
        id: 'commands',
        label: 'Commands',
        description: 'Create and maintain custom slash commands for OpenCode.',
        icon: RiCommandLine,
    },
    {
        id: 'skills',
        label: 'Skills',
        description: 'Create reusable instruction files for agents to load on-demand.',
        icon: RiBookLine,
    },
    {
        id: 'mcp',
        label: 'MCP',
        description: 'Manage Model Context Protocol servers and their configurations.',
        icon: RiPlugLine,
    },
    {
        id: 'providers',
        label: 'Providers',
        description: 'Configure AI model providers and API credentials.',
        icon: RiStackLine,
    },
    {
        id: 'usage',
        label: 'Usage',
        description: 'Monitor API quota and usage across providers.',
        icon: RiBarChart2Line,
    },
    {
        id: 'git-identities',
        label: 'Git Identities',
        description: 'Manage Git profiles with different credentials and SSH keys.',
        icon: RiGitBranchLine,
    },
    {
        id: 'settings',
        label: 'OpenChamber',
        description: 'OpenChamber app settings: themes, fonts, and preferences.',
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
