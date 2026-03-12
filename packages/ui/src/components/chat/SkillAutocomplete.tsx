import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface SkillInfo {
  name: string;
  scope: string;
  description?: string;
}

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
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [filteredSkills, setFilteredSkills] = React.useState<SkillInfo[]>([]);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const { skills, loadSkills } = useSkillsStore();

  React.useEffect(() => {
    // Always trigger loadSkills when autocomplete opens to ensure project context is fresh
    void loadSkills();
  }, [loadSkills]);

  React.useEffect(() => {
    const normalizedQuery = searchQuery.trim();
    const matches = normalizedQuery.length
      ? skills.filter((skill) => fuzzyMatch(skill.name, normalizedQuery))
      : skills;

    const sorted = [...matches].sort((a, b) => {
      // Sort by project scope first, then name
      if (a.scope === 'project' && b.scope !== 'project') return -1;
      if (a.scope !== 'project' && b.scope === 'project') return 1;
      return a.name.localeCompare(b.name);
    });

    setFilteredSkills(sorted);
    setSelectedIndex(0);
  }, [skills, searchQuery]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
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
        setSelectedIndex((prev) => (prev + 1) % filteredSkills.length);
        return;
      }

      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const skill = filteredSkills[selectedIndex];
        if (skill) {
          onSkillSelect(skill.name);
        }
      }
    },
  }), [filteredSkills, onSkillSelect, onClose, selectedIndex]);

  const renderSkill = (skill: SkillInfo, index: number) => {
    const isProject = skill.scope === 'project';
    return (
      <div
        key={`${skill.name}-${skill.scope}`}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
          className={cn(
            'flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label',
          index === selectedIndex && 'bg-interactive-selection'
          )}
        onClick={() => onSkillSelect(skill.name)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{skill.name}</span>
            <span className={cn(
              "text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 transition-colors",
              isProject 
                ? "bg-[var(--status-info-background)] text-[var(--status-info)] border-[var(--status-info-border)]"
                : "bg-[var(--status-success-background)] text-[var(--status-success)] border-[var(--status-success-border)]"
            )}>
              {skill.scope}
            </span>
          </div>
          {skill.description && (
            <div className="typography-meta text-muted-foreground mt-0.5 truncate">
              {skill.description}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[360px] max-h-60 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={style}
    >
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-0 pb-2" fillContainer={false}>
        {filteredSkills.length ? (
          <div>
            {filteredSkills.map((skill, index) => renderSkill(skill, index))}
          </div>
        ) : (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            No skills found
          </div>
        )}
      </ScrollableOverlay>
      <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
        ↑↓ navigate • Enter select • Esc close
      </div>
    </div>
  );
});

SkillAutocomplete.displayName = 'SkillAutocomplete';
