import { closestCenter, pointerWithin, rectIntersection, type CollisionDetection } from '@dnd-kit/core';

/**
 * A session lands in the folder under the pointer, and nowhere when the
 * pointer is over no folder; a keyboard drag has no pointer and lands in the
 * folder its row was moved onto. A header that sorts (a project, a section)
 * lands on the nearest header of its own sort group: projects among the
 * projects of their caption, sections among sections.
 */
export const sessionFolderCollision: CollisionDetection = (args) => {
  const active = args.active.data.current;
  if (active?.type !== 'session') {
    const sortGroup = active?.sortGroup;
    return closestCenter(sortGroup === undefined ? args : {
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => container.data.current?.sortGroup === sortGroup),
    });
  }
  const folderArgs = {
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => container.data.current?.type === 'folder'),
  };
  return args.pointerCoordinates ? pointerWithin(folderArgs) : rectIntersection(folderArgs);
};
