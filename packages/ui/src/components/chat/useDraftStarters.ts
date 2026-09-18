import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getProjectDraftStarters, saveProjectDraftStarters, updateSharedProjectSetup, type ProjectDraftStarter } from '@/lib/openchamberConfig';
import { isVSCodeRuntime } from '@/lib/desktop';
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

type StarterGroup = 'global' | 'project';

export type ResolvedStarter = {
    id: string;
    ref: DraftStarterRef;
    group: StarterGroup;
    label: string;
    icon: IconName;
    submitText: string;
    /** Pinned by the team in the repo's shared config; not removable here. */
    shared: boolean;
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
    /** Move one of the user's project starters into the repo's shared file. */
    shareStarter: (ref: DraftStarterRef) => void;
    /** Move a shared project starter back into the user's own list. */
    unshareStarter: (ref: DraftStarterRef) => void;
};

export function useDraftStarters(): UseDraftStartersResult {
    const { t } = useI18n();
    const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
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

    // Merged: the team's shared starters first, then the user's own. Only the
    // personal ones are ever written back.
    const [projectStarters, setProjectStarters] = React.useState<ProjectDraftStarter[]>([]);
    const personalProjectStarters = React.useMemo<DraftStarterRef[]>(
        () => projectStarters.filter((r) => r.source === 'personal').map(({ type, name }) => ({ type, name })),
        [projectStarters],
    );

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

    const resolve = React.useCallback((ref: DraftStarterRef, group: StarterGroup, shared = false): ResolvedStarter | null => {
        if (isVSCode && ref.type === 'command' && (ref.name === 'craft-goal' || ref.name === 'schedule-task')) return null;
        const plain: DraftStarterRef = { type: ref.type, name: ref.name };
        if (ref.type === 'command') {
            const builtin = getBuiltInStarter(ref.name);
            if (builtin) {
                return { id: chipId(group, plain), ref: plain, group, label: t(builtin.labelKey), icon: builtin.icon, submitText: builtin.command, shared };
            }
            if (!commandNames.has(ref.name)) return null;
            return { id: chipId(group, plain), ref: plain, group, label: normalizeStarterLabel(ref.name), icon: COMMAND_FALLBACK_ICON, submitText: `/${ref.name}`, shared };
        }
        if (!skillNames.has(ref.name)) return null;
        return { id: chipId(group, plain), ref: plain, group, label: normalizeStarterLabel(ref.name), icon: SKILL_FALLBACK_ICON, submitText: `/${ref.name}`, shared };
    }, [t, commandNames, skillNames, isVSCode]);

    const globalRefs = React.useMemo<readonly DraftStarterRef[]>(
        () => globalRaw ?? DEFAULT_GLOBAL_STARTERS,
        [globalRaw],
    );

    const global = React.useMemo(
        () => globalRefs.map((r) => resolve(r, 'global')).filter((x): x is ResolvedStarter => x !== null),
        [globalRefs, resolve],
    );
    const project = React.useMemo(
        () => projectStarters.map((r) => resolve(r, 'project', r.source === 'shared')).filter((x): x is ResolvedStarter => x !== null),
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
            if (isVSCode && (b.name === 'craft-goal' || b.name === 'schedule-task')) continue;
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
    }, [t, commands, skills, pinnedKeys, isVSCode]);

    const persistGlobal = React.useCallback((next: DraftStarterRef[]) => {
        useUIStore.getState().setGlobalDraftStarters(next);
        // The markers make a deliberate removal of a built-in starter durable:
        // without them the load path re-inserts Craft a Goal / Schedule a Task.
        // They travel with the user's edit, never with a bootstrap.
        void updateDesktopSettings({
            draftStarters: next,
            draftStartersCraftGoalAdded: true,
            draftStartersScheduleTaskAdded: true,
        });
    }, []);

    // `next` is the user's own list; the shared ones stay in front, untouched.
    const persistProject = React.useCallback((next: DraftStarterRef[]) => {
        setProjectStarters((current) => [
            ...current.filter((r) => r.source === 'shared'),
            ...next.map((r) => ({ ...r, source: 'personal' as const })),
        ]);
        if (projectRef) void saveProjectDraftStarters(projectRef, next);
    }, [projectRef]);

    const addStarter = React.useCallback((item: PinnableItem) => {
        const ref: DraftStarterRef = { type: item.type, name: item.name };
        if (item.scope === 'project') {
            if (!projectRef || projectStarters.some((r) => sameStarter(r, ref))) return;
            persistProject([...personalProjectStarters, ref]);
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            if (base.some((r) => sameStarter(r, ref))) return;
            persistGlobal([...base, ref]);
        }
    }, [projectRef, projectStarters, personalProjectStarters, globalRaw, persistProject, persistGlobal]);

    const removeStarter = React.useCallback((group: StarterGroup, ref: DraftStarterRef) => {
        if (group === 'project') {
            // A shared starter is the team's; it leaves only through the repo file.
            if (!personalProjectStarters.some((r) => sameStarter(r, ref))) return;
            persistProject(personalProjectStarters.filter((r) => !sameStarter(r, ref)));
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            persistGlobal(base.filter((r) => !sameStarter(r, ref)));
        }
    }, [personalProjectStarters, globalRaw, persistProject, persistGlobal]);

    // Sharing moves a starter between the two files: into the repo file first,
    // then out of the personal list; the merged list is reloaded from the server.
    const reloadProjectStarters = React.useCallback(() => {
        if (!projectRef) return;
        void getProjectDraftStarters(projectRef).then(setProjectStarters).catch(() => undefined);
    }, [projectRef]);

    const shareStarter = React.useCallback((ref: DraftStarterRef) => {
        if (!projectRef) return;
        const shared = projectStarters.filter((r) => r.source === 'shared').map(({ type, name }) => ({ type, name }));
        if (shared.some((r) => sameStarter(r, ref))) return;
        void (async () => {
            if (!(await updateSharedProjectSetup(projectRef, { draftStarters: [...shared, ref] }))) return;
            await saveProjectDraftStarters(projectRef, personalProjectStarters.filter((r) => !sameStarter(r, ref)));
            reloadProjectStarters();
        })();
    }, [personalProjectStarters, projectRef, projectStarters, reloadProjectStarters]);

    const unshareStarter = React.useCallback((ref: DraftStarterRef) => {
        if (!projectRef) return;
        const shared = projectStarters.filter((r) => r.source === 'shared').map(({ type, name }) => ({ type, name }));
        if (!shared.some((r) => sameStarter(r, ref))) return;
        void (async () => {
            if (!(await updateSharedProjectSetup(projectRef, { draftStarters: shared.filter((r) => !sameStarter(r, ref)) }))) return;
            await saveProjectDraftStarters(projectRef, [...personalProjectStarters.filter((r) => !sameStarter(r, ref)), ref]);
            reloadProjectStarters();
        })();
    }, [personalProjectStarters, projectRef, projectStarters, reloadProjectStarters]);

    const reorder = React.useCallback((group: StarterGroup, fromId: string, toId: string) => {
        // Project chips reorder among the user's own; shared ones keep their place in front.
        const base = group === 'project' ? personalProjectStarters : (globalRaw ?? DEFAULT_GLOBAL_STARTERS);
        const from = base.findIndex((r) => chipId(group, r) === fromId);
        const to = base.findIndex((r) => chipId(group, r) === toId);
        if (from < 0 || to < 0 || from === to) return;
        const next = arrayMove([...base], from, to);
        if (group === 'project') persistProject(next); else persistGlobal(next);
    }, [personalProjectStarters, globalRaw, persistProject, persistGlobal]);

    return { global, project, pinnable, hasProject: !!projectRef, ensureLoaded, addStarter, removeStarter, reorder, shareStarter, unshareStarter };
}
