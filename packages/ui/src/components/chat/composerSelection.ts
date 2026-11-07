/** Model, agent and effort a controlled composer sends with. */
export type ComposerSelection = {
    agent: string | undefined;
    model: { providerId: string; modelId: string } | null;
    variant: string | null | undefined;
};
