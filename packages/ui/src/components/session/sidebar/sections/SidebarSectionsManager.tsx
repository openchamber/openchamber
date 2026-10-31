import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  createSidebarSectionFromTemplate,
  DEFAULT_PIN_LIST,
  hasSidebarSectionConditions,
  SIDEBAR_SECTION_ACTIVITY,
  SIDEBAR_SECTION_KINDS,
  SIDEBAR_SECTION_LINKS,
  SIDEBAR_SECTION_NAME_MAX,
  SIDEBAR_SECTION_TEXT_MAX,
  SIDEBAR_SECTION_STATES,
  SIDEBAR_SECTION_TEMPLATES,
  SIDEBAR_SECTION_WORK_STATES,
  type BuiltinSidebarSectionId,
  type CustomSidebarSection,
  type SidebarSectionActivity,
  type SidebarSectionEntry,
  type SidebarSectionFilter,
  type SidebarSectionTemplate,
} from '@/lib/sidebarSections';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsInSidebarOrder } from '../list/useProjectsInSidebarOrder';
import { keepRowInList, ROW_DRAG_AUTO_SCROLL, ROW_SORT_TRANSITION, useRowDragSensors } from '../rowDrag';
import {
  canAddSidebarSection,
  closeSectionsManager,
  commitSectionDraft,
  deleteSidebarPinList,
  deleteSidebarSection,
  discardSectionDraft,
  editSection,
  saveSidebarSections,
  setSidebarSectionHidden,
  updateSectionDraft,
  useSidebarSectionsUiStore,
} from './sectionActions';

const BUILTIN_TITLE_KEY = {
  chats: 'sessions.sidebar.activity.chatsTitle',
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  projects: 'sessions.sidebar.activity.projectsTitle',
} as const satisfies Record<BuiltinSidebarSectionId, I18nKey>;

const TEMPLATE_KEY = {
  waiting: 'sessions.sidebar.sections.template.waiting',
  running: 'sessions.sidebar.sections.template.running',
  prs: 'sessions.sidebar.sections.template.prs',
  stalled: 'sessions.sidebar.sections.template.stalled',
  today: 'sessions.sidebar.sections.template.today',
  projects: 'sessions.sidebar.sections.template.projects',
  blank: 'sessions.sidebar.sections.template.blank',
} as const satisfies Record<SidebarSectionTemplate, I18nKey>;

const STATE_KEY = {
  running: 'sessions.sidebar.sections.state.running',
  'needs-answer': 'sessions.sidebar.sections.state.needsAnswer',
  unread: 'sessions.sidebar.sections.state.unread',
  failed: 'sessions.sidebar.sections.state.failed',
  'looks-done': 'sessions.sidebar.sections.state.looksDone',
} as const satisfies Record<SidebarSectionFilter['states'][number], I18nKey>;
const WORK_KEY = {
  'in-work': 'sessions.sidebar.sections.work.inWork',
  done: 'sessions.sidebar.sections.work.done',
} as const satisfies Record<SidebarSectionFilter['work'][number], I18nKey>;
const KIND_KEY = {
  session: 'sessions.sidebar.sections.kind.session',
  worktree: 'sessions.sidebar.sections.kind.worktree',
  space: 'sessions.sidebar.sections.kind.space',
  run: 'sessions.sidebar.sections.kind.run',
  scheduled: 'sessions.sidebar.sections.kind.scheduled',
} as const satisfies Record<SidebarSectionFilter['kinds'][number], I18nKey>;
const LINK_KEY = {
  pr: 'sessions.sidebar.sections.link.pr',
  issue: 'sessions.sidebar.sections.link.issue',
  tracker: 'sessions.sidebar.sections.link.tracker',
  plan: 'sessions.sidebar.sections.link.plan',
  goal: 'sessions.sidebar.sections.link.goal',
} as const satisfies Record<SidebarSectionFilter['links'][number], I18nKey>;
const ACTIVITY_KEY = {
  any: 'sessions.sidebar.sections.activity.any',
  today: 'sessions.sidebar.sections.activity.today',
  'two-days': 'sessions.sidebar.sections.activity.twoDays',
  week: 'sessions.sidebar.sections.activity.week',
  stalled: 'sessions.sidebar.sections.activity.stalled',
} as const satisfies Record<SidebarSectionActivity, I18nKey>;

const SECTIONS_PANEL_CLASS = 'oc-surface-floating oc-glass-floating oc-popup-motion app-region-no-drag rounded-xl origin-[var(--transform-origin)] data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95';

const toggleIn = <T extends string>(list: readonly T[], value: T): T[] => (
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
);

/**
 * The sidebar's sections in the order the user arranges them, with their
 * visibility on this surface, and the editor of one section. It opens beside
 * the sidebar, so the section being edited shows in the list as it stands.
 */
export const SidebarSectionsManager: React.FC<{ anchor: React.RefObject<HTMLElement | null> }> = ({ anchor }) => {
  const { t } = useI18n();
  const open = useSidebarSectionsUiStore((state) => state.managerOpen);
  const draft = useSidebarSectionsUiStore((state) => state.draft);
  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!next) closeSectionsManager(); }}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="inline-end" align="start" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup
            aria-label={t('sessions.sidebar.sections.title')}
            // Opaque, with the floating light: the menus it opens are glass, and a
            // glass surface under them would keep them from blurring what is behind.
            className={cn(SECTIONS_PANEL_CLASS, 'flex max-h-[min(40rem,calc(100vh-4rem))] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden')}
            initialFocus={false}
          >
            {draft ? <SectionEditor key={draft.id} draft={draft} /> : <SectionList />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const SectionList: React.FC = () => {
  const { t } = useI18n();
  const sections = useSessionDisplayStore((state) => state.sections);
  const pinLists = useSessionDisplayStore((state) => state.pinLists);
  const sensors = useRowDragSensors();
  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((entry) => entry.id === active.id);
    const to = sections.findIndex((entry) => entry.id === over.id);
    if (from < 0 || to < 0) return;
    saveSidebarSections(arrayMove(sections, from, to));
  };
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="typography-ui-label font-medium text-foreground">{t('sessions.sidebar.sections.title')}</span>
        <Button variant="outline" size="xs" disabled={!canAddSidebarSection(sections)} onClick={() => editSection(createSidebarSectionFromTemplate('waiting', t(TEMPLATE_KEY.waiting)), true)}>
          <Icon name="add" className="size-3.5" />
          {t('sessions.sidebar.sections.new')}
        </Button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={SECTION_LIST_MODIFIERS} autoScroll={ROW_DRAG_AUTO_SCROLL} onDragEnd={onDragEnd}>
        <SortableContext items={sections.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5">
            {sections.map((entry) => <SectionRow key={entry.id} entry={entry} />)}
          </div>
        </SortableContext>
      </DndContext>
      <p className="typography-micro text-muted-foreground">{t('sessions.sidebar.sections.orderHint')}</p>
      {pinLists.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="typography-micro text-muted-foreground">{t('sessions.sidebar.sections.pinLists')}</span>
          {pinLists.map((list) => (
            <div key={list.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <Icon name="pushpin" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-ui-label" dir="auto">{list.name}</span>
              <Button variant="ghost" size="icon" className="size-6" aria-label={t('sessions.sidebar.sections.deletePinList', { name: list.name })} onClick={() => deleteSidebarPinList(list.id)}>
                <Icon name="delete-bin" className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const SECTION_LIST_MODIFIERS = [keepRowInList];

/** One section in the list: its name and what can be done with it here; the row drags anywhere but its controls. */
const SectionRow: React.FC<{ entry: SidebarSectionEntry }> = ({ entry }) => {
  const { t } = useI18n();
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id, transition: ROW_SORT_TRANSITION });
  const hiddenSections = useSessionDisplayStore((state) => state.hiddenSections);
  const showChats = useSessionDisplayStore((state) => state.showChatsSection);
  const showPinned = useSessionDisplayStore((state) => state.showPinnedSection);
  const showWork = useSessionDisplayStore((state) => state.showWorkSection);
  const keepWorkInPlace = useSessionDisplayStore((state) => state.keepWorkInPlace);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const name = entry.kind === 'builtin' ? t(BUILTIN_TITLE_KEY[entry.id]) : entry.name;
  // Built-in sections keep the show toggles they always had; Projects is always shown.
  let visibility: { shown: boolean; set: (shown: boolean) => void } | null = null;
  if (entry.kind === 'custom') {
    visibility = { shown: !hiddenSections.includes(entry.id), set: (shown) => setSidebarSectionHidden(entry.id, !shown) };
  } else if (entry.id === 'chats') {
    visibility = { shown: showChats, set: (shown) => { useSessionDisplayStore.getState().setShowChatsSection(shown); void updateDesktopSettings({ sidebarShowChatsSection: shown }); } };
  } else if (entry.id === 'pinned') {
    visibility = { shown: showPinned, set: (shown) => { useSessionDisplayStore.getState().setShowPinnedSection(shown); void updateDesktopSettings({ sidebarShowPinnedSection: shown }); } };
  } else if (entry.id === 'work' && sessionWorkEnabled) {
    visibility = { shown: showWork, set: (shown) => { useSessionDisplayStore.getState().setShowWorkSection(shown); void updateDesktopSettings({ sidebarShowWorkSection: shown }); } };
  }
  if (entry.kind === 'builtin' && entry.id === 'work' && !sessionWorkEnabled) return null;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex cursor-grab touch-pan-y select-none flex-col rounded-md active:cursor-grabbing', isDragging && 'oc-tile relative z-10 cursor-grabbing')}
      {...listeners}
    >
      <div className="flex items-center gap-1.5 py-1 ps-2 pe-1">
        <span className={cn('min-w-0 flex-1 truncate typography-ui-label', visibility?.shown === false ? 'text-muted-foreground' : 'text-foreground')} dir="auto">{name}</span>
        {entry.kind === 'custom' ? (
          <>
            <Button variant="ghost" size="icon" className="size-6" aria-label={t('sessions.sidebar.sections.edit', { name })} onClick={() => editSection(entry, false)}>
              <Icon name="edit" className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-6" aria-label={t('sessions.sidebar.sections.delete', { name })} onClick={() => deleteSidebarSection(entry.id)}>
              <Icon name="delete-bin" className="size-3.5" />
            </Button>
          </>
        ) : null}
        {visibility ? (
          <Switch checked={visibility.shown} onCheckedChange={visibility.set} aria-label={t('sessions.sidebar.sections.show', { name })} />
        ) : null}
      </div>
      {entry.kind === 'builtin' && entry.id === 'work' && showWork ? (
        <label className="flex items-center gap-2 ps-2 pe-1 pb-1 typography-micro text-muted-foreground">
          <span className="flex-1">{t('sessions.sidebar.header.displayMode.keepWorkInPlace')}</span>
          <Switch
            checked={keepWorkInPlace}
            onCheckedChange={(keep) => { useSessionDisplayStore.getState().setKeepWorkInPlace(keep); void updateDesktopSettings({ sidebarKeepWorkInPlace: keep }); }}
          />
        </label>
      ) : null}
    </div>
  );
};

type ConditionCategory = 'text' | 'states' | 'work' | 'pins' | 'kinds' | 'links' | 'projectIds' | 'activity';
type ConditionOption = { value: string; label: string };

const CATEGORY_KEY = {
  text: 'sessions.sidebar.sections.category.text',
  states: 'sessions.sidebar.sections.category.state',
  work: 'sessions.sidebar.sections.category.work',
  pins: 'sessions.sidebar.sections.category.pins',
  kinds: 'sessions.sidebar.sections.category.kind',
  links: 'sessions.sidebar.sections.category.links',
  projectIds: 'sessions.sidebar.sections.category.projects',
  activity: 'sessions.sidebar.sections.category.activity',
} as const satisfies Record<ConditionCategory, I18nKey>;

const TIME_CATEGORIES: readonly ConditionCategory[] = ['text', 'states', 'work', 'pins', 'kinds', 'links', 'projectIds', 'activity'];

/** The values a condition holds; activity is one choice, "any time" being no condition. */
const conditionValues = (filter: SidebarSectionFilter, category: ConditionCategory): readonly string[] => {
  if (category === 'activity') return filter.activity === 'any' ? [] : [filter.activity];
  if (category === 'text') return filter.text.trim() === '' ? [] : [filter.text];
  return filter[category];
};

/** The filter with one value of a category turned on or off; activity takes one value or none. */
const toggleCondition = (filter: SidebarSectionFilter, category: Exclude<ConditionCategory, 'text'>, value: string): SidebarSectionFilter => {
  if (category === 'activity') {
    const activity = SIDEBAR_SECTION_ACTIVITY.find((entry) => entry === value) ?? 'any';
    return { ...filter, activity: filter.activity === activity ? 'any' : activity };
  }
  if (category === 'states') {
    const state = SIDEBAR_SECTION_STATES.find((entry) => entry === value);
    return state ? { ...filter, states: toggleIn(filter.states, state) } : filter;
  }
  if (category === 'work') {
    const work = SIDEBAR_SECTION_WORK_STATES.find((entry) => entry === value);
    return work ? { ...filter, work: toggleIn(filter.work, work) } : filter;
  }
  if (category === 'kinds') {
    const kind = SIDEBAR_SECTION_KINDS.find((entry) => entry === value);
    return kind ? { ...filter, kinds: toggleIn(filter.kinds, kind) } : filter;
  }
  if (category === 'links') {
    const link = SIDEBAR_SECTION_LINKS.find((entry) => entry === value);
    return link ? { ...filter, links: toggleIn(filter.links, link) } : filter;
  }
  return { ...filter, [category]: toggleIn(filter[category], value) };
};

const clearCondition = (filter: SidebarSectionFilter, category: ConditionCategory): SidebarSectionFilter => {
  if (category === 'activity') return { ...filter, activity: 'any' };
  if (category === 'text') return { ...filter, text: '' };
  return { ...filter, [category]: [] };
};

const SectionEditor: React.FC<{ draft: CustomSidebarSection }> = ({ draft }) => {
  const { t } = useI18n();
  const isNew = useSidebarSectionsUiStore((state) => state.draftIsNew);
  const matchCount = useSidebarSectionsUiStore((state) => state.draftMatchCount);
  const pinLists = useSessionDisplayStore((state) => state.pinLists);
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects));
  const [template, setTemplate] = React.useState<SidebarSectionTemplate | null>(isNew && draft.filter.text === '' ? 'waiting' : null);
  // The words row stays while the user clears it to type again; Add condition
  // opens it empty, and only its close button removes it.
  const [textRowOpen, setTextRowOpen] = React.useState(draft.filter.text.trim() !== '');
  const [focusText, setFocusText] = React.useState(false);
  const nameId = React.useId();
  const applyTemplate = (next: SidebarSectionTemplate): void => {
    // A name the user typed stays; a template's name follows the template.
    const keepName = template === null || draft.name !== t(TEMPLATE_KEY[template]);
    const section = createSidebarSectionFromTemplate(next, keepName ? draft.name : t(TEMPLATE_KEY[next]));
    setTemplate(next);
    setTextRowOpen(false);
    updateSectionDraft({ ...section, id: draft.id });
  };
  const byProjects = draft.grouping === 'project';
  const optionsOf = (category: ConditionCategory): readonly ConditionOption[] => {
    switch (category) {
      case 'states': return SIDEBAR_SECTION_STATES.map((value) => ({ value, label: t(STATE_KEY[value]) }));
      case 'work': return SIDEBAR_SECTION_WORK_STATES.map((value) => ({ value, label: t(WORK_KEY[value]) }));
      case 'pins': return [{ value: DEFAULT_PIN_LIST, label: t('sessions.sidebar.activity.pinnedTitle') }, ...pinLists.map((list) => ({ value: list.id, label: list.name }))];
      case 'kinds': return SIDEBAR_SECTION_KINDS.map((value) => ({ value, label: t(KIND_KEY[value]) }));
      case 'links': return SIDEBAR_SECTION_LINKS.map((value) => ({ value, label: t(LINK_KEY[value]) }));
      case 'projectIds': return projects.map((project) => ({ value: project.id, label: project.label?.trim() || formatDirectoryName(project.path, null) || project.path }));
      case 'activity': return SIDEBAR_SECTION_ACTIVITY.filter((value) => value !== 'any').map((value) => ({ value, label: t(ACTIVITY_KEY[value]) }));
      case 'text': return [];
    }
  };
  const toggle = (category: Exclude<ConditionCategory, 'text'>, value: string): void => updateSectionDraft({ ...draft, filter: toggleCondition(draft.filter, category, value) });
  // Only the conditions the section asks for are on screen; a group of
  // projects asks for its projects alone, so that row is always there.
  const categories: readonly ConditionCategory[] = byProjects ? ['projectIds'] : TIME_CATEGORIES;
  const isShown = (category: ConditionCategory): boolean => (
    byProjects || conditionValues(draft.filter, category).length > 0 || (category === 'text' && textRowOpen)
  );
  const shown = categories.filter(isShown);
  const addable = byProjects ? [] : categories.filter((category) => !isShown(category));
  const name = draft.name.trim();
  // A section with nothing to ask lists nothing, so it is not saved until it asks something.
  const hasConditions = byProjects ? draft.filter.projectIds.length > 0 : hasSidebarSectionConditions(draft.filter);
  let countLabel: string | null = null;
  if (!hasConditions) countLabel = byProjects ? t('sessions.sidebar.sections.needsProjects') : t('sessions.sidebar.sections.needsCondition');
  else if (matchCount !== null) {
    if (byProjects) countLabel = matchCount === 1 ? t('sessions.sidebar.sections.matchProjectsSingle', { count: matchCount }) : t('sessions.sidebar.sections.matchProjectsPlural', { count: matchCount });
    else countLabel = matchCount === 1 ? t('sessions.sidebar.sections.matchWorksSingle', { count: matchCount }) : t('sessions.sidebar.sections.matchWorksPlural', { count: matchCount });
  }
  const optionItems = (category: Exclude<ConditionCategory, 'text'>) => {
    const values = conditionValues(draft.filter, category);
    // Several values of a category can be picked, so the menu stays open; activity is one choice.
    return optionsOf(category).map((option) => (
      <DropdownMenuItem key={option.value} closeOnClick={category === 'activity'} onClick={() => toggle(category, option.value)} className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate" dir="auto">{option.label}</span>
        {values.includes(option.value) ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
      </DropdownMenuItem>
    ));
  };
  return (
    <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); if (name && hasConditions) commitSectionDraft(); }}>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('sessions.sidebar.sections.back')} onClick={discardSectionDraft}>
            <Icon name="arrow-left-s" className="size-4" />
          </Button>
          <span className="typography-ui-label font-medium text-foreground">
            {isNew ? t('sessions.sidebar.sections.newTitle') : t('sessions.sidebar.sections.editTitle')}
          </span>
        </div>
        <Input
          id={nameId}
          aria-label={t('sessions.sidebar.sections.name')}
          inputSize="compact"
          value={draft.name}
          maxLength={SIDEBAR_SECTION_NAME_MAX}
          onChange={(event) => updateSectionDraft({ ...draft, name: event.target.value })}
          dir="auto"
        />
        {isNew ? (
          <div className="flex items-center justify-between gap-2">
            <span className="typography-ui-label text-muted-foreground">{t('sessions.sidebar.sections.startFrom')}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(dropdownTriggerVariants(), 'max-w-[12rem] px-2.5 typography-ui-label')}>
                  <span className="min-w-0 truncate">{template ? t(TEMPLATE_KEY[template]) : t(TEMPLATE_KEY.blank)}</span>
                  <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {SIDEBAR_SECTION_TEMPLATES.map((entry) => (
                  <DropdownMenuItem key={entry} onClick={() => applyTemplate(entry)} className="flex items-center justify-between gap-3">
                    <span>{t(TEMPLATE_KEY[entry])}</span>
                    {template === entry ? <Icon name="check" className="size-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        <SettingsChipGroup
          className="self-start"
          aria-label={t('sessions.sidebar.sections.lists')}
          value={draft.grouping}
          options={[
            { value: 'time', label: t('sessions.sidebar.sections.grouping.time') },
            { value: 'project', label: t('sessions.sidebar.sections.grouping.project') },
          ]}
          // Switching keeps every condition and the claims choice: a group of
          // projects reads only its projects, and saving one drops the rest.
          onChange={(grouping) => updateSectionDraft({ ...draft, grouping })}
        />
        <div className="flex flex-col gap-1">
          {shown.map((category) => {
            if (category === 'text') {
              const textLabel = t(CATEGORY_KEY.text);
              return (
                <div key={category} className="oc-tile flex items-center gap-1 rounded-md pe-1">
                  <label className="flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-1.5 typography-ui-label">
                    <span className="shrink-0 text-muted-foreground">{textLabel}</span>
                    <input
                      ref={(node) => { if (node && focusText) { node.focus(); setFocusText(false); } }}
                      value={draft.filter.text}
                      maxLength={SIDEBAR_SECTION_TEXT_MAX}
                      placeholder={t('sessions.sidebar.sections.textPlaceholder')}
                      onChange={(event) => updateSectionDraft({ ...draft, filter: { ...draft.filter, text: event.target.value } })}
                      className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                      dir="auto"
                    />
                  </label>
                  <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('sessions.sidebar.sections.removeCondition', { name: textLabel })} onClick={() => { setTextRowOpen(false); updateSectionDraft({ ...draft, filter: clearCondition(draft.filter, 'text') }); }}>
                    <Icon name="close" className="size-3.5" />
                  </Button>
                </div>
              );
            }
            const values = conditionValues(draft.filter, category);
            const labels = optionsOf(category).filter((option) => values.includes(option.value)).map((option) => option.label);
            const categoryLabel = t(CATEGORY_KEY[category]);
            return (
              <div key={category} className="oc-tile flex items-center gap-1 rounded-md pe-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-1.5 text-start typography-ui-label focus-visible:outline-none">
                      <span className="shrink-0 text-muted-foreground">{categoryLabel}</span>
                      <span className={cn('min-w-0 truncate', labels.length === 0 && 'text-muted-foreground')} dir="auto">
                        {labels.length > 0 ? labels.join(', ') : t('sessions.sidebar.sections.chooseProjects')}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="start" className="max-h-[min(20rem,var(--available-height))] min-w-[200px] overflow-y-auto">
                    {optionItems(category)}
                  </DropdownMenuContent>
                </DropdownMenu>
                {!byProjects ? (
                  <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('sessions.sidebar.sections.removeCondition', { name: categoryLabel })} onClick={() => updateSectionDraft({ ...draft, filter: clearCondition(draft.filter, category) })}>
                    <Icon name="close" className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {addable.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex items-center gap-1.5 self-start rounded-md px-1 py-1 typography-ui-label text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                  <Icon name="add" className="size-4" />
                  {t('sessions.sidebar.sections.addCondition')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="max-h-[min(20rem,var(--available-height))] min-w-[180px] overflow-y-auto">
                {addable.map((category) => category === 'text' ? (
                  <DropdownMenuItem key={category} onClick={() => { setTextRowOpen(true); setFocusText(true); }}>{t(CATEGORY_KEY.text)}</DropdownMenuItem>
                ) : (
                  <DropdownMenuSub key={category}>
                    <DropdownMenuSubTrigger>{t(CATEGORY_KEY[category])}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-[min(20rem,var(--available-height))] min-w-[200px] overflow-y-auto">
                      {optionItems(category)}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          {/* A group of projects always takes its projects; only a list of works chooses. */}
          {!byProjects ? (
            <label className="flex items-center gap-2 typography-ui-label">
              <span className="flex-1">{t('sessions.sidebar.sections.alsoInProjects')}</span>
              <Switch checked={!draft.claims} onCheckedChange={(alsoInProjects) => updateSectionDraft({ ...draft, claims: !alsoInProjects })} />
            </label>
          ) : null}
          <label className="flex items-center gap-2 typography-ui-label">
            <span className="flex-1">{t('sessions.sidebar.sections.hideWhenEmpty')}</span>
            <Switch checked={draft.hideWhenEmpty} onCheckedChange={(hideWhenEmpty) => updateSectionDraft({ ...draft, hideWhenEmpty })} />
          </label>
        </div>
      </div>
      {/* The count and the actions stay in reach while the conditions scroll. */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-2">
        <span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground">{countLabel}</span>
        <Button type="button" variant="outline" size="sm" onClick={discardSectionDraft}>{t('sessions.sidebar.sections.cancel')}</Button>
        <Button type="submit" size="sm" disabled={!name || !hasConditions}>{isNew ? t('sessions.sidebar.sections.create') : t('sessions.sidebar.sections.save')}</Button>
      </div>
    </form>
  );
};
