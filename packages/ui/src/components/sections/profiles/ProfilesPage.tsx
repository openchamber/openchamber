import React from 'react';
import { useModelProfilesStore } from '@/stores/useModelProfilesStore';
import { useAgentsStore, isAgentHidden } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useOhMyOpencodeStore } from '@/stores/useOhMyOpencodeStore';
import type { AgentModelMapping, CategoryModelMapping } from '@/types/profiles';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { ButtonSmall } from '@/components/ui/button-small';
import { cn } from '@/lib/utils';
import { RiAlertLine } from '@remixicon/react';

function splitModel(s: string): { providerId: string; modelId: string } {
  const idx = s.indexOf('/');
  if (idx < 0) return { providerId: '', modelId: '' };
  return { providerId: s.slice(0, idx), modelId: s.slice(idx + 1) };
}

export const ProfilesPage: React.FC = () => {
  const { selectedProfileId, profiles, updateProfile, deleteProfile, createProfile, applyProfile } = useModelProfilesStore();
  const { agents } = useAgentsStore();
  const { providers } = useConfigStore();
  
  const visibleAgents = React.useMemo(() => agents.filter(a => !isAgentHidden(a)), [agents]);
  
  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null;
  const isCreateMode = selectedProfileId === null;

  const omoState = useOhMyOpencodeStore();
  const showCategories = omoState.installed;
  const categoryNames = React.useMemo(() => {
    if (!omoState.installed || !omoState.categories) return [];
    return Object.keys(omoState.categories).sort();
  }, [omoState.installed, omoState.categories]);

  const omoAgentNames = React.useMemo(() => {
    if (!omoState.installed || !omoState.agents) return [];
    return Object.keys(omoState.agents).sort();
  }, [omoState.installed, omoState.agents]);

  // Split visible agents: regular agents vs oh-my-opencode agents
  const omoAgentNamesSet = React.useMemo(() => new Set(omoAgentNames), [omoAgentNames]);
  const regularAgents = React.useMemo(() => visibleAgents.filter(a => !omoAgentNamesSet.has(a.name)), [visibleAgents, omoAgentNamesSet]);

  React.useEffect(() => {
    if (!omoState.isLoaded && !omoState.isLoading) {
      omoState.load();
    }
  }, [omoState]);

  const [localName, setLocalName] = React.useState('');
  const [agentModels, setAgentModels] = React.useState<AgentModelMapping>({});
  const [categoryModels, setCategoryModels] = React.useState<CategoryModelMapping>({});
  const [omoAgentModels, setOmoAgentModels] = React.useState<AgentModelMapping>({});
  const [isSaving, setIsSaving] = React.useState(false);
  const [isApplying, setIsApplying] = React.useState(false);

  React.useEffect(() => {
    if (isCreateMode) {
      setLocalName('');
      setAgentModels({});
      setCategoryModels({});
      setOmoAgentModels({});
    } else if (selectedProfile) {
      setLocalName(selectedProfile.name);
      setAgentModels(selectedProfile.agentModels || {});
      setCategoryModels(selectedProfile.categoryModels || {});
      setOmoAgentModels(selectedProfile.omoAgentModels || {});
    }
  }, [selectedProfileId, selectedProfile, isCreateMode]);

  const isCategoryModelsDirty = React.useMemo(() => {
    if (!showCategories) return false;
    if (isCreateMode) {
      return Object.values(categoryModels).some(m => m !== '');
    }
    if (!selectedProfile) return false;
    const currentModels = selectedProfile.categoryModels || {};
    const allKeys = new Set([...Object.keys(categoryModels), ...Object.keys(currentModels)]);
    for (const key of allKeys) {
      const localVal = categoryModels[key] || '';
      const currentVal = currentModels[key] || '';
      if (localVal !== currentVal) return true;
    }
    return false;
  }, [showCategories, isCreateMode, categoryModels, selectedProfile]);

  const isOmoAgentModelsDirty = React.useMemo(() => {
    if (!omoState.installed || omoAgentNames.length === 0) return false;
    if (isCreateMode) {
      return Object.values(omoAgentModels).some(m => m !== '');
    }
    if (!selectedProfile) return false;
    const currentModels = selectedProfile.omoAgentModels || {};
    const allKeys = new Set([...Object.keys(omoAgentModels), ...Object.keys(currentModels)]);
    for (const key of allKeys) {
      const localVal = omoAgentModels[key] || '';
      const currentVal = currentModels[key] || '';
      if (localVal !== currentVal) return true;
    }
    return false;
  }, [omoState.installed, omoAgentNames, isCreateMode, omoAgentModels, selectedProfile]);

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

  const isDirty = isCreateMode ? (isNameDirty || isModelsDirty || isCategoryModelsDirty || isOmoAgentModelsDirty) : (isModelsDirty || isCategoryModelsDirty || isOmoAgentModelsDirty);

  const handleSave = async () => {
    const trimmedName = localName.trim();
    if (isCreateMode && !trimmedName) {
      toast.error('Profile name is required');
      return;
    }
    if (isCreateMode && profiles.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      toast.error('A profile with this name already exists');
      return;
    }

    const filteredModels: AgentModelMapping = {};
    for (const [agent, model] of Object.entries(agentModels)) {
      if (model) {
        filteredModels[agent] = model;
      }
    }

    const filteredCategoryModels: CategoryModelMapping = {};
    if (showCategories) {
      for (const [cat, model] of Object.entries(categoryModels)) {
        if (model) {
          filteredCategoryModels[cat] = model;
        }
      }
    }

    const filteredOmoAgentModels: AgentModelMapping = {};
    if (omoState.installed && omoAgentNames.length > 0) {
      for (const [agent, model] of Object.entries(omoAgentModels)) {
        if (model) {
          filteredOmoAgentModels[agent] = model;
        }
      }
    }

    setIsSaving(true);
    try {
      if (isCreateMode) {
        const catModels = Object.keys(filteredCategoryModels).length > 0 ? filteredCategoryModels : undefined;
        const omoAgents = Object.keys(filteredOmoAgentModels).length > 0 ? filteredOmoAgentModels : undefined;
        const created = await createProfile(trimmedName, filteredModels, catModels, omoAgents);
        if (created) {
          toast.success('Profile created');
        } else {
          const stateError = useModelProfilesStore.getState().error;
          if (stateError) toast.error(stateError);
        }
      } else if (selectedProfileId) {
        const updates: { agentModels: AgentModelMapping; categoryModels?: CategoryModelMapping; omoAgentModels?: AgentModelMapping } = { agentModels: filteredModels };
        if (showCategories) {
          updates.categoryModels = Object.keys(filteredCategoryModels).length > 0 ? filteredCategoryModels : undefined;
        }
        if (omoState.installed && omoAgentNames.length > 0) {
          updates.omoAgentModels = Object.keys(filteredOmoAgentModels).length > 0 ? filteredOmoAgentModels : undefined;
        }
        await updateProfile(selectedProfileId, updates);
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
      if (profiles.some(p => p.id !== selectedProfileId && p.name.toLowerCase() === trimmedName.toLowerCase())) {
        toast.error('A profile with this name already exists');
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
            {regularAgents.map((agent, index) => {
              const modelString = agentModels[agent.name] || '';
              const { providerId, modelId } = splitModel(modelString);
              const isModelUnavailable = !!(providerId && modelId &&
                !providers.some(p => p.id === providerId && p.models.some(m => m.id === modelId)));

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
                    {isModelUnavailable && (
                      <span title="Model not available" className="flex shrink-0 items-center text-[var(--status-warning)]">
                        <RiAlertLine size={14} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        {/* Agent Models (oh-my-opencode) */}
        {omoState.installed && omoAgentNames.length > 0 && (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">Agent Models (oh-my-opencode)</h3>
              <p className="typography-meta text-muted-foreground">Override model per oh-my-opencode agent for this profile</p>
            </div>
            <section className="px-2 pb-2 pt-0 space-y-0">
              {omoAgentNames.map((agentName, index) => {
                const modelString = omoAgentModels[agentName] || '';
                const { providerId, modelId } = splitModel(modelString);
                const isModelUnavailable = !!(providerId && modelId &&
                  !providers.some(p => p.id === providerId && p.models.some(m => m.id === modelId)));

                return (
                  <div key={agentName} className={cn("flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
                    <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                      <span className="typography-ui-label text-foreground">{agentName}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                      <ModelSelector
                        providerId={providerId}
                        modelId={modelId}
                        onChange={(newProviderId: string, newModelId: string) => {
                          setOmoAgentModels(prev => ({
                            ...prev,
                            [agentName]: newProviderId && newModelId ? `${newProviderId}/${newModelId}` : ''
                          }));
                        }}
                      />
                      {isModelUnavailable && (
                        <span title="Model not available" className="flex shrink-0 items-center text-[var(--status-warning)]">
                          <RiAlertLine size={14} />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        )}

        {/* Category Models (oh-my-opencode) */}
        {showCategories && categoryNames.length > 0 && (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">Categories (oh-my-opencode)</h3>
              <p className="typography-meta text-muted-foreground">Override model per category for this profile</p>
            </div>
            <section className="px-2 pb-2 pt-0 space-y-0">
              {categoryNames.map((catName, index) => {
                const modelString = categoryModels[catName] || '';
                const { providerId, modelId } = splitModel(modelString);
                const isModelUnavailable = !!(providerId && modelId &&
                  !providers.some(p => p.id === providerId && p.models.some(m => m.id === modelId)));

                return (
                  <div key={catName} className={cn("flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
                    <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                      <span className="typography-ui-label text-foreground">{catName}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                      <ModelSelector
                        providerId={providerId}
                        modelId={modelId}
                        onChange={(newProviderId: string, newModelId: string) => {
                          setCategoryModels(prev => ({
                            ...prev,
                            [catName]: newProviderId && newModelId ? `${newProviderId}/${newModelId}` : ''
                          }));
                        }}
                      />
                      {isModelUnavailable && (
                        <span title="Model not available" className="flex shrink-0 items-center text-[var(--status-warning)]">
                          <RiAlertLine size={14} />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        )}

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
