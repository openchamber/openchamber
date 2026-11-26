import { useSkillsStore } from '@/stores/useSkillsStore';
import { useUIStore } from '@/stores/useUIStore';

export const openSkillSettings = (name: string): void => {
  useSkillsStore.getState().setSelectedSkill(name);
  const ui = useUIStore.getState();
  ui.setSettingsPage('skills.installed');
  ui.setSettingsDialogOpen(true);
};
