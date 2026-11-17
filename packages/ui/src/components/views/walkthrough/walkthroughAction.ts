import { openExternalUrl } from '@/lib/url';


const WALKTHROUGH_GUIDE_URL = 'https://docs.openchamber.dev/walkthrough/';

export const openWalkthroughGuide = () => {
  void openExternalUrl(WALKTHROUGH_GUIDE_URL);
};

export const MENU_GROUP_LABEL_CLASS = 'typography-meta font-normal text-muted-foreground';
