import type { IconName } from "@/components/icon/icons";
import type { I18nKey } from "@/lib/i18n";

// A draft starter is a reference to an existing command or skill, pinned to the
// onboarding/draft welcome screen as a one-click chip. Scope (global vs project)
// is NOT stored here — it is encoded by which list the ref lives in (global =
// settings.json, project = project config), derived from the command/skill's own
// scope when pinned.
export type DraftStarterType = 'command' | 'skill';

export type DraftStarterRef = {
    type: DraftStarterType;
    name: string;
};

// Our built-in openchamber commands (Session magic prompts). They are always
// available to pin, keep their bespoke icons, and seed the default global set.
export type BuiltInStarter = {
    name: string;
    icon: IconName;
    labelKey: I18nKey;
    command: string;
};

export const BUILTIN_STARTERS: readonly BuiltInStarter[] = [
    { name: 'explore', icon: 'compass-3', labelKey: 'chat.draftPresets.explore.label', command: '/explore' },
    { name: 'catch-up', icon: 'history', labelKey: 'chat.draftPresets.catchup.label', command: '/catch-up' },
    { name: 'weigh', icon: 'scales-3', labelKey: 'chat.draftPresets.weigh.label', command: '/weigh' },
    { name: 'plan-feature', icon: 'survey', labelKey: 'chat.draftPresets.plan.label', command: '/plan-feature' },
    { name: 'debug', icon: 'bug', labelKey: 'chat.draftPresets.debug.label', command: '/debug' },
    { name: 'review', icon: 'search-eye', labelKey: 'chat.draftPresets.review.label', command: '/workspace-review' },
];

const BUILTIN_BY_NAME = new Map<string, BuiltInStarter>(BUILTIN_STARTERS.map((s) => [s.name, s]));

export const getBuiltInStarter = (name: string): BuiltInStarter | undefined => BUILTIN_BY_NAME.get(name);
export const isBuiltInStarter = (ref: DraftStarterRef): boolean =>
    ref.type === 'command' && BUILTIN_BY_NAME.has(ref.name);

// Default global starter set (used until the user customizes the global list).
export const DEFAULT_GLOBAL_STARTERS: readonly DraftStarterRef[] = BUILTIN_STARTERS.map((s) => ({
    type: 'command' as const,
    name: s.name,
}));

// Fallback icons for user-defined starters, matching the Settings sections.
export const COMMAND_FALLBACK_ICON: IconName = 'terminal-box';
export const SKILL_FALLBACK_ICON: IconName = 'book-open';

export const starterKey = (ref: DraftStarterRef): string => `${ref.type}:${ref.name}`;

export const sameStarter = (a: DraftStarterRef, b: DraftStarterRef): boolean =>
    a.type === b.type && a.name === b.name;

// Turn a command/skill name into a human chip label: "/simplify-code" -> "Simplify code".
export const normalizeStarterLabel = (name: string): string => {
    const base = name
        .replace(/^\//, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return name;
    return base.charAt(0).toUpperCase() + base.slice(1);
};

// Parse persisted starter refs (from settings.json or project config) defensively.
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
