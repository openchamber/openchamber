type ProjectActionContext = {
  projectId: string | null;
  mobileVariant: boolean;
  closeMobileSwitcher: boolean;
  setActiveProjectIdOnly: (projectId: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export const prepareSessionProjectAction = ({
  projectId,
  mobileVariant,
  closeMobileSwitcher,
  setActiveProjectIdOnly,
  setSessionSwitcherOpen,
}: ProjectActionContext): void => {
  if (projectId) setActiveProjectIdOnly(projectId);
  if (mobileVariant && closeMobileSwitcher) setSessionSwitcherOpen(false);
};
