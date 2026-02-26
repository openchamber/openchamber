import React from 'react';
import { useModelProfilesStore } from '@/stores/useModelProfilesStore';
import { useAgentsStore, isAgentHidden } from '@/stores/useAgentsStore';
import type { AgentModelMapping } from '@/types/profiles';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { ButtonSmall } from '@/components/ui/button-small';
import { cn } from '@/lib/utils';

function splitModel(s: string): { providerId: string; modelId: string } {
  const idx = s.indexOf('/');
  if (idx < 0) return { providerId: '', modelId: '' };
  return { providerId: s.slice(0, idx), modelId: s.slice(idx + 1) };
}

export const ProfilesPage: React.FC = () => {
  const { selectedProfileId, profiles, updateProfile, deleteProfile, createProfile, applyProfile } = useModelProfilesStore();
  const { agents } = useAgentsStore();
  
  const visibleAgents = React.useMemo(() => agents.filter(a => !isAgentHidden(a)), [agents]);
  
  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null;
  const isCreateMode = selectedProfileId === null;

  const [localName, setLocalName] = React.useState('');
  const [agentModels, setAgentModels] = React.useState<AgentModelMapping>({});
  const [isSaving, setIsSaving] = React.useState(false);
  const [isApplying, setIsApplying] = React.useState(false);

  React.useEffect(() => {
    if (isCreateMode) {
      setLocalName('');
      setAgentModels({});
    } else if (selectedProfile) {
      setLocalName(selectedProfile.name);
      setAgentModels(selectedProfile.agentModels || {});
    }
  }, [selectedProfileId, selectedProfile, isCreateMode]);

  const isModelsDirty = React.useMemo(() => {
    if (isCreateMode) {
      return Object.values(agentModels).some(m => m !== '');
    }
    if (!selectedProfile) return false;
    const currentModels = selectedProfile.agentModels || {};
    const allKeys = new Set([...Object.keys(agentModels), ...Object.keys(currentModels)]);
    for (const key of allKeys) {
      const localVal = agentModels[key] || '';
      const currentVal = currentModels[key] || '';
      if (localVal !== currentVal) return true;
    }
    return false;
  }, [isCreateMode, agentModels, selectedProfile]);

  const isNameDirty = React.useMemo(() => {
    if (isCreateMode) return localName.trim().length > 0;
    if (!selectedProfile) return false;
    return localName.trim() !== selectedProfile.name;
  }, [isCreateMode, localName, selectedProfile]);

  const isDirty = isCreateMode ? (isNameDirty || isModelsDirty) : isModelsDirty;

  const handleSave = async () => {
    const trimmedName = localName.trim();
    if (isCreateMode && !trimmedName) {
      toast.error('Profile name is required');
      return;
    }

    const filteredModels: AgentModelMapping = {};
    for (const [agent, model] of Object.entries(agentModels)) {
      if (model) {
        filteredModels[agent] = model;
      }
    }

    setIsSaving(true);
    try {
      if (isCreateMode) {
        const created = await createProfile(trimmedName, filteredModels);
        if (created) {
          toast.success('Profile created');
        } else {
          const stateError = useModelProfilesStore.getState().error;
          if (stateError) toast.error(stateError);
        }
      } else if (selectedProfileId) {
        await updateProfile(selectedProfileId, { agentModels: filteredModels });
        const stateError = useModelProfilesStore.getState().error;
        if (stateError) {
          toast.error(stateError);
        } else {
          toast.success('Profile updated');
        }
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleApply = async () => {
    if (!selectedProfileId) return;
    setIsApplying(true);
    try {
      await applyProfile(selectedProfileId);
      const stateError = useModelProfilesStore.getState().error;
      if (stateError) {
        toast.error(stateError);
      } else {
        toast.success('Profile applied');
      }
    } finally {
      setIsApplying(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProfileId || !selectedProfile) return;
    if (window.confirm(`Delete profile "${selectedProfile.name}"?`)) {
      await deleteProfile(selectedProfileId);
      const stateError = useModelProfilesStore.getState().error;
      if (stateError) {
        toast.error(stateError);
      } else {
        toast.success('Profile deleted');
      }
    }
  };

  const handleNameBlurOrEnter = () => {
    if (!isCreateMode && selectedProfileId && localName.trim() !== selectedProfile?.name) {
      const trimmedName = localName.trim();
      if (!trimmedName) {
        setLocalName(selectedProfile?.name || '');
        return;
      }
      updateProfile(selectedProfileId, { name: trimmedName }).then(() => {
        const stateError = useModelProfilesStore.getState().error;
        if (stateError) {
          toast.error(stateError);
          setLocalName(selectedProfile?.name || '');
        }
      });
    }
  };

  const title = isCreateMode ? 'New Profile' : selectedProfile?.name || 'Profile';
  const subtitle = isCreateMode ? 'Configure agent model overrides for this profile' : 'Edit profile settings';

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">{title}</h2>
            <p className="typography-meta text-muted-foreground">{subtitle}</p>
          </div>
          {!isCreateMode && (
            <div className="flex items-center gap-2">
              <ButtonSmall
                variant="outline"
                onClick={handleApply}
                disabled={isApplying}
                className="!font-normal"
              >
                {isApplying ? 'Applying...' : 'Apply Profile'}
              </ButtonSmall>
              <ButtonSmall
                variant="ghost"
                onClick={handleDelete}
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)] hover:bg-[var(--status-error)]/10"
              >
                Delete
              </ButtonSmall>
            </div>
          )}
        </div>

        {/* Profile Name */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">Profile Name</h3>
          </div>
          <section className="px-2 pb-2 pt-0">
            <Input
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={handleNameBlurOrEnter}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              placeholder="Profile name..."
              className="max-w-md"
            />
          </section>
        </div>

        {/* Agent Models */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">Agent Models</h3>
            <p className="typography-meta text-muted-foreground">Override model per agent for this profile</p>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-0">
            {visibleAgents.map((agent, index) => {
              const modelString = agentModels[agent.name] || '';
              const { providerId, modelId } = splitModel(modelString);

              return (
                <div key={agent.name} className={cn("flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
                  <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                    <span className="typography-ui-label text-foreground">{agent.name}</span>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                    <ModelSelector
                      providerId={providerId}
                      modelId={modelId}
                      onChange={(newProviderId: string, newModelId: string) => {
                        setAgentModels(prev => ({
                          ...prev,
                          [agent.name]: newProviderId && newModelId ? `${newProviderId}/${newModelId}` : ''
                        }));
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        {/* Save Action */}
        <div className="px-2 py-1">
          <ButtonSmall
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            className="!font-normal"
          >
            {isSaving ? 'Saving...' : (isCreateMode ? 'Create Profile' : 'Save Changes')}
          </ButtonSmall>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
