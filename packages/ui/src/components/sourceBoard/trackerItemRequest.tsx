import { useDesktopTrackerItemClicks } from '@/hooks/useDesktopTrackerItemClicks';
import { useTrackerItemRequestAnswers } from '@/hooks/useTrackerItemRequestAnswers';

export function TrackerItemRequests(): null {
  useTrackerItemRequestAnswers();
  useDesktopTrackerItemClicks();
  return null;
}
