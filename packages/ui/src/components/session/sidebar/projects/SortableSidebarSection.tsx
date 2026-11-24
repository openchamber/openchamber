import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { ROW_SORT_TRANSITION } from '../rowDrag';
import { SECTION_SORT_GROUP, sectionDragId } from './sectionDrag';

export const SortableSidebarSection: React.FC<{
  sectionId: string;
  rowKey: string;
  disabled: boolean;
  children: React.ReactNode;
}> = ({ sectionId, rowKey, disabled, children }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, node, transform, transition, isDragging } = useSortable({
    id: sectionDragId(sectionId),
    disabled,
    data: { type: 'section', sortGroup: SECTION_SORT_GROUP, sectionId, rowKey, element: () => node.current },
    transition: ROW_SORT_TRANSITION,
  });
  const setRef = React.useCallback((node: HTMLElement | null) => {
    setNodeRef(node);
    setActivatorNodeRef(node);
  }, [setActivatorNodeRef, setNodeRef]);
  return <div
    ref={setRef}
    style={{ transform: CSS.Translate.toString(transform), transition }}
    className={cn('focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', !disabled && 'cursor-grab active:cursor-grabbing', isDragging && 'opacity-0')}
    {...attributes}
    {...listeners}
  >
    {children}
  </div>;
};
