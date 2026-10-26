// The label of each action on a space, shared by the group's menu, the phone's sheet and the
// status line's repair button.

import type { I18nKey } from '@/lib/i18n';
import type { SpaceAction } from '@/lib/spaces/spaces-store';

export const SPACE_ACTION_TEXT = {
  start: 'spaces.actions.start',
  stop: 'spaces.actions.stop',
  restart_opencode: 'spaces.actions.restartOpenCode',
  restart: 'spaces.actions.restart',
  setup: 'spaces.actions.setup',
  remove: 'spaces.actions.remove',
} satisfies Record<SpaceAction, I18nKey>;
