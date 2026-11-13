import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { selectAvailableSkillsForDirectory, selectSkillsLoadedForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerConfigDirectory } from '@/hooks/useComposerConfigDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { AutocompleteLoadingRow, AutocompleteRowDetail } from './composer/ui/AutocompleteRowParts';
import { useAutocompleteSelectionScroll } from './composer/ui/useAutocompleteSelectionScroll';
import { rankSkillAutocompleteItems } from './skillAutocompleteItems';
import { useHeightMorph } from '@/lib/motion/useSizeMorph';

interface SkillInfo {
  name: string;
  scope: string;
  source?: string;
  description?: string;
}

const EMPTY_SKILLS: SkillInfo[] = [];

export interface SkillAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface SkillAutocompleteProps {
  searchQuery: string;
  onSkillSelect: (skillName: string) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

export const SkillAutocomplete = React.forwardRef<SkillAutocompleteHandle, SkillAutocompleteProps>(({
  searchQuery,
  onSkillSelect,
  onClose,
  style,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // Narrowing as the user types, the box eases into its new height; its
  // bottom edge stays on the composer (`bottom-full`), so it moves upward.
  useHeightMorph(containerRef);
  const isMobile = useUIStore((state) => state.isMobile);
  // A caret placement brings its own max-height.
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, style?.maxHeight === undefined, 240);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const { listRef, onKeyboardNavigate } = useAutocompleteSelectionScroll(selectedIndex, itemRefs);
  // Skills of the directory the composer sends to (session directory, or the
  // Chats root for a chat draft), not of the project the app was on last.
  const effectiveDirectory = useEffectiveDirectory();
  const target = useComposerConfigDirectory(effectiveDirectory);
  const directory = target.status === 'resolved' ? target.directory : null;
  const skills = useSkillsStore((s) => target.status === 'pending'
    ? EMPTY_SKILLS
    : selectAvailableSkillsForDirectory(s, target.directory));
  // An empty list before the first read is not "no skills".
  const skillsLoading = useSkillsStore((s) => target.status === 'pending'
    || (Boolean(directory) && !selectSkillsLoadedForDirectory(s, target.directory)));
  const loadSkills = useSkillsStore((s) => s.loadSkills);

  React.useEffect(() => {
    if (directory) void loadSkills(directory);
  }, [directory, loadSkills]);

  // Ranked in the render that shows them: an effect painted the last query's
  // rows first, so the box moved twice per keystroke.
  const filteredSkills = React.useMemo(() => rankSkillAutocompleteItems(skills, searchQuery), [skills, searchQuery]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [filteredSkills]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }

      if (!filteredSkills.length) {
        return;
      }

      if (key === 'ArrowDown') {
        onKeyboardNavigate();
        setSelectedIndex((prev) => (prev + 1) % filteredSkills.length);
        return;
      }

      if (key === 'ArrowUp') {
        onKeyboardNavigate();
        setSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % filteredSkills.length) + filteredSkills.length) % filteredSkills.length;
        const skill = filteredSkills[safeIndex];
        if (skill) {
          onSkillSelect(skill.name);
        }
      }
    },
  }), [filteredSkills, onSkillSelect, onClose, onKeyboardNavigate]);

  const renderSkill = (skill: SkillInfo, index: number) => {
    return (
      <div
        key={`${skill.name}-${skill.scope}`}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label',
          index === selectedIndex && 'bg-interactive-selection'
        )}
        onClick={() => onSkillSelect(skill.name)}
        onMouseMove={() => {
          setSelectedIndex(index);
        }}
      >
        <span className="max-w-[60%] shrink-0 truncate font-semibold">{skill.name}</span>
        <AutocompleteRowDetail scope={skill.scope === 'project' ? 'project' : 'user'} description={skill.description} />
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[420px] max-h-64 oc-glass-popover oc-glass-floating rounded-xl bottom-full mb-2 inset-s-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay ref={listRef} preventOverscroll outerClassName="flex-1 min-h-0" className="p-1">
        {filteredSkills.length ? (
          <div>
            {filteredSkills.map((skill, index) => renderSkill(skill, index))}
          </div>
        ) : skillsLoading ? (
          <AutocompleteLoadingRow />
        ) : (
          <div className="px-2 py-1.5 typography-ui-label text-muted-foreground">
            {t('chat.autocomplete.skillsEmpty')}
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 py-1.5 border-t typography-meta text-muted-foreground">
          {t('chat.autocomplete.keyboardHint')}
        </div>
      )}
    </div>
  );
});

SkillAutocomplete.displayName = 'SkillAutocomplete';
