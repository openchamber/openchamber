interface FilesViewFindState {
  fullscreen: boolean;
  searchOpen: boolean;
}

type FilesViewFindAction =
  | { type: 'set-search-open'; open: boolean }
  | { type: 'toggle-fullscreen' }
  | { type: 'exit-fullscreen' };

export const reduceFilesViewFindState = (
  state: FilesViewFindState,
  action: FilesViewFindAction,
): FilesViewFindState => {
  switch (action.type) {
    case 'set-search-open':
      return { ...state, searchOpen: action.open };
    case 'toggle-fullscreen':
      return { ...state, fullscreen: !state.fullscreen };
    case 'exit-fullscreen':
      return { ...state, fullscreen: false };
  }
};

export const handleFilesViewFind = (
  active: boolean,
  editorMounted: boolean,
  event: Pick<Event, 'preventDefault'>,
  openSearch: () => void,
): boolean => {
  if (!active || !editorMounted) {
    return false;
  }
  event.preventDefault();
  openSearch();
  return true;
};

export const renderFilesViewSurface = <T>(
  state: FilesViewFindState,
  renderInline: () => T,
  renderFullscreen: () => T,
): T => state.fullscreen ? renderFullscreen() : renderInline();
