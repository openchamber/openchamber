import React from 'react';
import { RiAddLine, RiEditLine, RiSettings3Line } from '@remixicon/react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { KanbanCard } from './KanbanCard';
import type { BoardColumn, BoardCard } from '@/types/kanban';

const SortableKanbanCard: React.FC<{
  card: BoardCard;
  onCardClick?: (card: BoardCard) => void;
}> = ({ card, onCardClick }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: card.id,
    disabled: card.status === 'running'
  });

  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(card.status !== 'running' ? listeners : undefined)}
      className={cn(isDragging && 'opacity-50')}
    >
      <KanbanCard card={card} onCardClick={onCardClick} />
    </div>
  );
};

export interface KanbanColumnProps extends React.HTMLAttributes<HTMLDivElement> {
  column: BoardColumn;
  cards: BoardCard[];
  onRenameClick?: (columnId: string, currentName: string) => void;
  onAddCardClick?: (columnId: string) => void;
  onSettingsClick?: (column: BoardColumn) => void;
  onCardClick?: (card: BoardCard) => void;
  isDraggingOver?: boolean;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  cards,
  onRenameClick,
  onAddCardClick,
  onSettingsClick,
  onCardClick,
  isDraggingOver,
  className,
  ...props
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { column },
  });

  const sortedCards = React.useMemo(() => {
    return [...cards].sort((a, b) => a.order - b.order);
  }, [cards]);

  const cardIds = sortedCards.map((card) => card.id);

  return (
    <div
      {...props}
      className={cn(
        'flex flex-col gap-3 min-w-[280px] max-w-[340px] flex-shrink-0 transition-colors',
        (isOver || isDraggingOver) && 'bg-[var(--interactive-hover)]/30',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="typography-ui-label font-medium text-foreground truncate">
          {column.name}
        </h2>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onSettingsClick && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:bg-[var(--interactive-hover)]/50"
              onClick={() => onSettingsClick(column)}
            >
              <RiSettings3Line className="h-4 w-4" />
            </Button>
          )}
          {onRenameClick && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:bg-[var(--interactive-hover)]/50"
              onClick={() => onRenameClick(column.id, column.name)}
            >
              <RiEditLine className="h-4 w-4" />
            </Button>
          )}
          {onAddCardClick && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:bg-[var(--interactive-hover)]/50"
              onClick={() => onAddCardClick(column.id)}
            >
              <RiAddLine className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 min-h-[80px] rounded-lg border border-dashed border-border/50',
            'transition-colors',
            isOver && 'border-[var(--interactive-selection)] bg-[var(--interactive-selection)]/10'
          )}
        >
          {sortedCards.length === 0 ? (
            <div className="flex h-[80px] items-center justify-center text-muted-foreground typography-micro">
              No cards
            </div>
          ) : (
            sortedCards.map((card) => (
              <SortableKanbanCard
                key={card.id}
                card={card}
                onCardClick={onCardClick}
              />
            ))
          )}
        </div>
      </SortableContext>

      <div className="typography-micro text-muted-foreground">
        {sortedCards.length} {sortedCards.length === 1 ? 'card' : 'cards'}
      </div>
    </div>
  );
};
