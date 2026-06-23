import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getProjectDraftStarters, saveProjectDraftStarters } from '@/lib/openchamberConfig';
import type { IconName } from '@/components/icon/icons';
import {
    BUILTIN_STARTERS,
    DEFAULT_GLOBAL_STARTERS,
    COMMAND_FALLBACK_ICON,
    SKILL_FALLBACK_ICON,
    getBuiltInStarter,
    normalizeStarterLabel,
    sameStarter,
    starterKey,
    type DraftStarterRef,
    type DraftStarterType,
} from '@/lib/draftStarters';

export type StarterGroup = 'global' | 'project';

export type ResolvedStarter = {
    id: string;
    ref: DraftStarterRef;
    group: StarterGroup;
    label: string;
    icon: IconName;
    submitText: string;
};

export type PinnableSection = 'built-in' | 'command' | 'skill';

export type PinnableItem = {
    type: DraftStarterType;
    name: string;
    label: string;
    icon: IconName;
    section: PinnableSection;
    scope: 'user' | 'project';
};

const chipId = (group: StarterGroup, ref: DraftStarterRef): string => `${group}:${starterKey(ref)}`;

export type UseDraftStartersResult = {
    global: ResolvedStarter[];
    project: ResolvedStarter[];
    pinnable: PinnableItem[];
    hasProject: boolean;
    ensureLoaded: () => void;
    addStarter: (item: PinnableItem) => void;
    removeStarter: (group: StarterGroup, ref: DraftStarterRef) => void;
    reorder: (group: StarterGroup, fromId: string, toId: string) => void;
};

export function useDraftStarters(): UseDraftStartersResult {
    const { t } = useI18n();
    const globalRaw = useUIStore((s) => s.globalDraftStarters);
    const commands = useCommandsStore((s) => s.commands);
    const skills = useSkillsStore((s) => s.skills);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const projects = useProjectsStore((s) => s.projects);

    const projectRef = React.useMemo(() => {
        if (!activeProjectId) return null;
        const found = projects.find((p) => p.id === activeProjectId);
        if (!found?.path) return null;
        return { id: found.id, path: found.path };
    }, [activeProjectId, projects]);

    const [projectStarters, setProjectStarters] = React.useState<DraftStarterRef[]>([]);

    React.useEffect(() => {
        let cancelled = false;
        if (!projectRef) {
            setProjectStarters([]);
            return;
        }
        getProjectDraftStarters(projectRef)
            .then((refs) => { if (!cancelled) setProjectStarters(refs); })
            .catch(() => { if (!cancelled) setProjectStarters([]); });
        return () => { cancelled = true; };
        // Keyed on project id to avoid reloading when the memoized ref object
        // changes identity but still points at the same project.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectRef?.id]);

    const ensureLoaded = React.useCallback(() => {
        void useCommandsStore.getState().loadCommands?.();
        void useSkillsStore.getState().loadSkills?.();
    }, []);

    // Preload commands and skills on mount so that pinned command/skill starters
    // resolve immediately without requiring the user to open the add dialog first.
    // Both loaders are TTL-cached and in-flight-deduped, so this is a cheap no-op
    // if they were already loaded.
    React.useEffect(() => {
        ensureLoaded();
    }, [ensureLoaded]);

    const commandNames = React.useMemo(() => new Set(commands.map((c) => c.name)), [commands]);
    const skillNames = React.useMemo(() => new Set(skills.map((s) => s.name)), [skills]);

    const resolve = React.useCallback((ref: DraftStarterRef, group: StarterGroup): ResolvedStarter | null => {
        if (ref.type === 'command') {
            const builtin = getBuiltInStarter(ref.name);
            if (builtin) {
                return { id: chipId(group, ref), ref, group, label: t(builtin.labelKey), icon: builtin.icon, submitText: builtin.command };
            }
            if (!commandNames.has(ref.name)) return null;
            return { id: chipId(group, ref), ref, group, label: normalizeStarterLabel(ref.name), icon: COMMAND_FALLBACK_ICON, submitText: `/${ref.name}` };
        }
        if (!skillNames.has(ref.name)) return null;
        return { id: chipId(group, ref), ref, group, label: normalizeStarterLabel(ref.name), icon: SKILL_FALLBACK_ICON, submitText: `/${ref.name}` };
    }, [t, commandNames, skillNames]);

    const globalRefs = React.useMemo<readonly DraftStarterRef[]>(
        () => globalRaw ?? DEFAULT_GLOBAL_STARTERS,
        [globalRaw],
    );

    const global = React.useMemo(
        () => globalRefs.map((r) => resolve(r, 'global')).filter((x): x is ResolvedStarter => x !== null),
        [globalRefs, resolve],
    );
    const project = React.useMemo(
        () => projectStarters.map((r) => resolve(r, 'project')).filter((x): x is ResolvedStarter => x !== null),
        [projectStarters, resolve],
    );

    const pinnedKeys = React.useMemo(() => {
        const set = new Set<string>();
        for (const r of globalRefs) set.add(starterKey(r));
        for (const r of projectStarters) set.add(starterKey(r));
        return set;
    }, [globalRefs, projectStarters]);

    const pinnable = React.useMemo<PinnableItem[]>(() => {
        const items: PinnableItem[] = [];
        for (const b of BUILTIN_STARTERS) {
            items.push({ type: 'command', name: b.name, label: t(b.labelKey), icon: b.icon, section: 'built-in', scope: 'user' });
        }
        for (const c of commands) {
            if (c.isBuiltIn || c.source === 'skill' || getBuiltInStarter(c.name)) continue;
            items.push({ type: 'command', name: c.name, label: normalizeStarterLabel(c.name), icon: COMMAND_FALLBACK_ICON, section: 'command', scope: c.scope === 'project' ? 'project' : 'user' });
        }
        for (const sk of skills) {
            items.push({ type: 'skill', name: sk.name, label: normalizeStarterLabel(sk.name), icon: SKILL_FALLBACK_ICON, section: 'skill', scope: sk.scope === 'project' ? 'project' : 'user' });
        }
        // Only offer items that are not already pinned (removed built-ins reappear here).
        return items.filter((item) => !pinnedKeys.has(`${item.type}:${item.name}`));
    }, [t, commands, skills, pinnedKeys]);

    const persistGlobal = React.useCallback((next: DraftStarterRef[]) => {
        useUIStore.getState().setGlobalDraftStarters(next);
        void updateDesktopSettings({ draftStarters: next });
    }, []);

    const persistProject = React.useCallback((next: DraftStarterRef[]) => {
        setProjectStarters(next);
        if (projectRef) void saveProjectDraftStarters(projectRef, next);
    }, [projectRef]);

    const addStarter = React.useCallback((item: PinnableItem) => {
        const ref: DraftStarterRef = { type: item.type, name: item.name };
        if (item.scope === 'project') {
            if (!projectRef || projectStarters.some((r) => sameStarter(r, ref))) return;
            persistProject([...projectStarters, ref]);
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            if (base.some((r) => sameStarter(r, ref))) return;
            persistGlobal([...base, ref]);
        }
    }, [projectRef, projectStarters, globalRaw, persistProject, persistGlobal]);

    const removeStarter = React.useCallback((group: StarterGroup, ref: DraftStarterRef) => {
        if (group === 'project') {
            persistProject(projectStarters.filter((r) => !sameStarter(r, ref)));
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            persistGlobal(base.filter((r) => !sameStarter(r, ref)));
        }
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    const reorder = React.useCallback((group: StarterGroup, fromId: string, toId: string) => {
        const base = group === 'project' ? projectStarters : (globalRaw ?? DEFAULT_GLOBAL_STARTERS);
        const from = base.findIndex((r) => chipId(group, r) === fromId);
        const to = base.findIndex((r) => chipId(group, r) === toId);
        if (from < 0 || to < 0 || from === to) return;
        const next = arrayMove([...base], from, to);
        if (group === 'project') persistProject(next); else persistGlobal(next);
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    return { global, project, pinnable, hasProject: !!projectRef, ensureLoaded, addStarter, removeStarter, reorder };
}
