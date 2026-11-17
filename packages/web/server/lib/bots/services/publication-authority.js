import { BotServiceError } from './contracts.js';

const refuse = () => { throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The operation differs from the privately reserved bot branch.'); };

/** The private checkout owner grants publication authority; model/tool input cannot. */
export function createBotPublicationAuthority({ resolvePublication }) {
  const validate = (effect, input) => {
    if (effect.authority.service !== 'github') return;
    const local = `bot/${effect.itemId}`;
    const remote = effect.publicationBranch ?? local;
    if (input.branch !== undefined && input.branch !== remote) refuse();
    if (effect.operation === 'git.push' && (input.localBranch ?? input.branch) !== local) refuse();
  };
  const assertOwned = (effect, input, owned) => {
    if (effect.publicationBranch !== undefined && (!owned || owned.publicationBranch !== effect.publicationBranch
      || owned.localBranch !== `bot/${effect.itemId}` || owned.identityId !== effect.authority.identityId
      || owned.identityRevision !== effect.authority.identityRevision
      || effect.operation === 'git.push' && owned.directory !== input.directory)) refuse();
  };
  return {
    validate,
    async prepare(effect, input) {
      if (effect.authority.service !== 'github') return effect;
      const owned = await resolvePublication({ repositoryId: effect.target.repositoryId, botId: effect.botId, itemId: effect.itemId });
      const captured = owned ? { ...effect, publicationBranch: owned.publicationBranch } : effect;
      validate(captured, input);
      assertOwned(captured, input, owned);
      return captured;
    },
    async assertCurrent(effect, input) {
      if (effect.publicationBranch !== undefined) assertOwned(effect, input,
        await resolvePublication({ repositoryId: effect.target.repositoryId, botId: effect.botId, itemId: effect.itemId }));
    },
  };
}
