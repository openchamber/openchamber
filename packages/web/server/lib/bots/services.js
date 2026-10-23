import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertBotWriteAllowed } from '../enterprise-mode.js';
import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';
import { createMutationStore } from '../source-control/mutation-storage.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import { createBotIdentityStore } from './identities.js';
import { BotServiceError, effectSchema, githubTarget, jiraTarget, discordTarget, opaqueId,
  operations, parse, requestSchema, questionAuthoritySchema, revision, branch, sha } from './services/contracts.js';
import { createProviderHttp } from './services/http.js';
import { createCredentialResolver } from './services/credentials.js';
import { createGitHubAdapter } from './services/github.js';
import { createJiraAdapter, searchJiraIssues } from './services/jira.js';
import { createDiscordAdapter } from './services/discord.js';
import { publishBotGit } from './services/git.js';

export { BotServiceError } from './services/contracts.js';

const githubKinds = { 'git.push': 'bot-git-push', 'pr.open': 'change-request-create',
  'pr.comment': 'change-request-comment', 'pr.auto-merge': 'change-request-merge',
  'pr.disable-auto-merge': 'change-request-merge', 'pr.dequeue': 'change-request-merge' };
const payloadDigest = (effect, input) => digestMutationInput({ key: effect.key, operation: effect.operation,
  botId: effect.botId, itemId: effect.itemId, authority: effect.authority, target: effect.target, input });
const sourceKey = (effect) => `bot:${effect.botId}:${effect.itemId}:${effect.key}`;
const unknown = () => ({ state: 'outcome-unknown' });
const convertError = (error) => {
  if (error?.state === 'refused') return error;
  if (error instanceof BotServiceError) return error;
  if (error?.code === 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN') return new BotServiceError(error.code,
    'The bot operation outcome is unknown. Reconcile the original effect without submitting a new key.', 'outcome-unknown');
  return new BotServiceError(error?.code?.startsWith('SOURCE_CONTROL_') ? error.code : 'BOT_SERVICE_FAILED',
    'The bot service operation could not complete.', 'needs-you', error?.status ?? 500);
};

/** Server-only. The engine journals prepare's descriptor before calling execute. */
export function createBotServices({
  dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber'),
  identities = createBotIdentityStore({ dataDir }),
  runtimeIdentity = { id: `bot-runtime-${randomUUID()}`, platform: process.platform },
  policyOptions, fetchImpl, mutationStore = createMutationStore({ filePath: path.join(dataDir, 'source-control-mutations.json') }),
  auditStore = createSourceControlAuditStore({ filePath: path.join(dataDir, 'source-control-audit.json') }),
  git = {}, approvedDiscordPeople = async () => [], resolveQuestionAuthority = async () => null,
} = {}) {
  const resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }) });
  const mutations = createMutationExecutor({ store: mutationStore, auditStore, runtimeIdentity });
  const adapter = (credential, target, beforeAdmission, beforeQuestionWrite) => {
    if (credential.authority.service === 'github') return createGitHubAdapter(credential, target, {
      beforeAdmission,
      publishGit: (input) => publishBotGit({ ...input, policyOptions, ...git }),
    });
    if (credential.authority.service === 'jira') return createJiraAdapter(credential, target, { beforeQuestionWrite });
    return createDiscordAdapter(credential, target, { beforeQuestionWrite });
  };
  const validateQuestion = async (effect, input) => {
    if (!['jira.question', 'discord.question'].includes(effect.operation)) return;
    const result = questionAuthoritySchema.safeParse(await resolveQuestionAuthority({ botId: effect.botId, itemId: effect.itemId, key: effect.key }));
    if (!result.success) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'The question needs its current approved policy and selected recipients.');
    const { policy, question } = result.data;
    const { route } = question;
    const service = operations[effect.operation].service;
    const identity = effect.authority ?? effect;
    const captured = { operation: route.operation, target: route.binding.target, identityId: route.binding.identityId,
      identityRevision: route.binding.identityRevision, input: route.input };
    const requested = { operation: effect.operation, target: effect.target, identityId: identity.identityId,
      identityRevision: identity.identityRevision, input };
    if (question.key !== effect.key || route.service !== service || policy.fingerprint !== input.policyFingerprint
      || route.policyFingerprint !== input.policyFingerprint || digestMutationInput(captured) !== digestMutationInput(requested)
      || digestMutationInput(route.recipients) !== digestMutationInput(input.recipients)
      || input.recipients.some((recipient) => !policy.people.people.some((person) => person.id === recipient.personId && person[service] === recipient.serviceId))
      || service === 'discord' && effect.target.guildId === 'dm'
        && (input.recipients.length !== 1 || input.recipients[0].serviceId !== effect.target.recipientId)) {
      throw new BotServiceError('BOT_QUESTION_RECIPIENT_DENIED', 'The question differs from its approved recipient selection or policy.');
    }
  };
  const validateRevocationOwner = (effect, input) => {
    if (['pr.disable-auto-merge', 'pr.dequeue'].includes(effect.operation) && input.branch !== `bot/${effect.itemId}`) {
      throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'Revocation requires the exact owned bot branch.');
    }
  };
  const validateEffect = (value, rawInput) => {
    const effect = parse(effectSchema, value);
    const operation = operations[effect.operation];
    effect.target = parse(operation.target, effect.target);
    const input = parse(operation.input, rawInput);
    validateRevocationOwner(effect, input);
    if (operation.service !== effect.authority.service || payloadDigest(effect, input) !== effect.inputDigest) {
      throw new BotServiceError('BOT_EFFECT_CHANGED', 'The bot effect differs from its durable authority or input.');
    }
    return { effect, input };
  };
  const resolveEffect = async (effect) => {
    if (effect.authority.service === 'discord' && effect.target.guildId === 'dm'
      && !(await approvedDiscordPeople(effect)).includes(effect.target.recipientId)) {
      throw new BotServiceError('BOT_DISCORD_PERSON_DENIED', 'The Discord recipient is absent from the approved people directory.');
    }
    const credential = await resolve({ identityId: effect.authority.identityId, identityRevision: effect.authority.identityRevision,
      service: effect.authority.service, target: effect.target });
    if (digestMutationInput(credential.authority) !== digestMutationInput(effect.authority)) {
      throw new BotServiceError('BOT_AUTHORITY_CHANGED', 'The selected bot identity changed after the effect was prepared.');
    }
    return credential;
  };
  const mutationRecord = (effect, input) => {
    const { target, authority } = effect;
    const record = { key: sourceKey(effect), inputDigest: effect.inputDigest, kind: githubKinds[effect.operation],
      actor: { provider: 'github', instance: 'github.com', accountId: authority.credentialId },
      target: { repositoryId: target.repositoryId,
        botAuthority: { botId: effect.botId, itemId: effect.itemId, identityId: authority.identityId,
          identityRevision: authority.identityRevision, credentialRevision: authority.credentialRevision },
        project: { id: `${target.owner}/${target.repo}`, owner: target.owner, name: target.repo },
      },
    };
    if (input.number) record.target.number = input.number;
    if (input.branch) record.target.head = input.branch;
    if (input.base) record.target.base = input.base;
    if (input.headSha) record.target.headSha = input.headSha;
    return record;
  };
  const sourceExecute = (effect, input, credential, provider) => mutations.execute({
    record: mutationRecord(effect, input), providerAccountId: credential.authority.providerAccountId,
    perform: () => provider.perform(effect.operation, input),
    reconcile: () => provider.reconcile(effect.operation, input),
    classifyError: (error) => error?.state === 'outcome-unknown' ? 'outcome-unknown' : 'failed',
  });
  return Object.freeze({
    async prepare(value) {
      const request = parse(requestSchema, value);
      const operation = operations[request.operation];
      const target = parse(operation.target, request.target);
      const input = parse(operation.input, request.input);
      validateRevocationOwner(request, input);
      await validateQuestion({ ...request, target }, input);
      const credential = await resolve({ ...request, target, service: operation.service });
      const effect = { key: request.key, operation: request.operation, botId: request.botId, itemId: request.itemId,
        authority: credential.authority, target };
      return { ...effect, inputDigest: payloadDigest(effect, input) };
    },
    async execute(value, rawInput, { beforeAdmission, beforeDispatch } = {}) {
      const { effect, input } = validateEffect(value, rawInput);
      try {
        await validateQuestion(effect, input);
        const credential = await resolveEffect(effect);
        const provider = adapter(credential, effect.target, beforeAdmission, () => validateQuestion(effect, input));
        if (beforeDispatch) {
          const service = effect.authority.service;
          let origin = effect.authority.origin;
          if (effect.operation === 'git.push') {
            const rules = await provider.read('github.rules', { branch: input.base });
            origin = rules.requiredSignatures ? 'https://api.github.com' : 'https://github.com';
          }
          const resource = service === 'github' ? `${effect.target.owner}/${effect.target.repo}`
            : service === 'jira' ? effect.target.projectKey : `${effect.target.guildId}/${effect.target.channelId}`;
          try { assertBotWriteAllowed({ service, origin, resource }, policyOptions); }
          catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot destination.', 'needs-you', 403); }
          // No content owner has been entered yet. A failed preflight leaves the
          // engine prepared; after this durable callback all failures reconcile.
          await beforeDispatch();
        }
        const completed = effect.authority.service === 'github'
          ? await sourceExecute(effect, input, credential, provider)
          : { record: { result: await provider.perform(effect.operation, input) }, replayed: false };
        return { status: 'succeeded', operation: effect.operation, authority: effect.authority, target: effect.target,
          result: completed.record.result, replayed: completed.replayed };
      } catch (error) { throw convertError(error); }
    },
    async reconcile(value, rawInput) {
      const { effect, input } = validateEffect(value, rawInput);
      try {
        const credential = await resolveEffect(effect);
        const provider = adapter(credential, effect.target);
        if (effect.authority.service === 'github') {
          const existing = await mutations.read(sourceKey(effect));
          if (existing) {
            if (existing.inputDigest !== effect.inputDigest) throw new BotServiceError('BOT_EFFECT_CHANGED', 'The source-control journal has different effect authority.');
            if (existing.state === 'failed') throw new BotServiceError(existing.result?.failureCode ?? 'BOT_SERVICE_REJECTED',
              'The original bot operation was refused. It cannot be dispatched again.', 'needs-you', existing.result?.failureStatus ?? 409);
            const result = await mutations.reconcile({ record: mutationRecord(effect, input),
              providerAccountId: credential.authority.providerAccountId,
              reconcile: () => provider.reconcile(effect.operation, input) });
            return { state: 'succeeded', result: result.record.result };
          }
        }
        return await provider.reconcile(effect.operation, input);
      } catch (error) {
        if (error.state === 'outcome-unknown' || error.code === 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN') return unknown();
        throw convertError(error);
      }
    },
    async read({ identityId, identityRevision, operation, target: rawTarget, input: rawInput = {} }) {
      parse(opaqueId, identityId); parse(revision, identityRevision);
      const service = operation.startsWith('github.') ? 'github' : operation.startsWith('jira.') ? 'jira'
        : operation.startsWith('discord.') ? 'discord' : null;
      if (!service) throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider read is unsupported.', 'failed', 400);
      if (operation === 'jira.search') {
        const target = parse(z.object({}).strict(), rawTarget);
        const credential = await resolve({ identityId, identityRevision, service, target });
        return searchJiraIssues(credential, rawInput);
      }
      const target = parse(service === 'github' ? githubTarget : service === 'jira' ? jiraTarget : discordTarget, rawTarget);
      let input = rawInput;
      if (['github.rules', 'github.branch'].includes(operation)) input = parse(z.object({ branch }).strict(), rawInput);
      if (operation === 'github.pull') input = parse(z.object({ number: revision, headSha: sha.optional() }).strict(), rawInput);
      if (operation === 'github.authorization') input = parse(z.object({ number: revision, branch }).strict(), rawInput);
      const credential = await resolve({ identityId, identityRevision, service, target });
      return adapter(credential, target).read(operation, input);
    },
  });
}
