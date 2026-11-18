import type { IconName } from "@/components/icon/icons";
import type { I18nKey } from "@/lib/i18n";

export type DraftStarterType = 'command' | 'skill';

export type DraftStarterRef = {
    type: DraftStarterType;
    name: string;
};

type BuiltInStarter = {
    name: string;
    icon: IconName;
    labelKey: I18nKey;
    command: string;
};

export const BUILTIN_STARTERS: readonly BuiltInStarter[] = [
    { name: 'explore', icon: 'compass-3', labelKey: 'chat.draftPresets.explore.label', command: '/explore' },
    { name: 'debug', icon: 'bug', labelKey: 'chat.draftPresets.debug.label', command: '/debug' },
    { name: 'review', icon: 'search-eye', labelKey: 'chat.draftPresets.review.label', command: '/workspace-review' },
    { name: 'plan-feature', icon: 'survey', labelKey: 'chat.draftPresets.plan.label', command: '/plan-feature' },
    { name: 'catch-up', icon: 'history', labelKey: 'chat.draftPresets.catchup.label', command: '/catch-up' },
    { name: 'weigh', icon: 'scales-3', labelKey: 'chat.draftPresets.weigh.label', command: '/weigh' },
    { name: 'craft-goal', icon: 'target', labelKey: 'chat.draftPresets.craftGoal.label', command: '/craft-goal' },
    { name: 'schedule-task', icon: 'calendar-schedule', labelKey: 'chat.draftPresets.scheduleTask.label', command: '/schedule-task' },
    { name: 'new-extension', icon: 'puzzle', labelKey: 'chat.draftPresets.newExtension.label', command: '/new-extension' },
];

const BUILTIN_BY_NAME = new Map<string, BuiltInStarter>(BUILTIN_STARTERS.map((s) => [s.name, s]));

export const getBuiltInStarter = (name: string): BuiltInStarter | undefined => BUILTIN_BY_NAME.get(name);

export const DEFAULT_GLOBAL_STARTERS: readonly DraftStarterRef[] = BUILTIN_STARTERS.map((s) => ({
    type: 'command' as const,
    name: s.name,
}));

export const COMMAND_FALLBACK_ICON: IconName = 'terminal-box';
export const SKILL_FALLBACK_ICON: IconName = 'book-open';

export const starterKey = (ref: DraftStarterRef): string => `${ref.type}:${ref.name}`;

export const sameStarter = (a: DraftStarterRef, b: DraftStarterRef): boolean =>
    a.type === b.type && a.name === b.name;

export const normalizeStarterLabel = (name: string): string => {
    const base = name
        .replace(/^\//, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return name;
    return base.charAt(0).toUpperCase() + base.slice(1);
};

export const sanitizeStarterRefs = (value: unknown): DraftStarterRef[] => {
    if (!Array.isArray(value)) return [];
    const out: DraftStarterRef[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const type = record.type === 'command' || record.type === 'skill' ? record.type : null;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!type || !name) continue;
        const key = `${type}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type, name });
    }
    return out;
};
