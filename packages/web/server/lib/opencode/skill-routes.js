import { OpenCode } from '@opencode/client';
import { buildAppliedResponse } from './config-mutation-response.js';
import { OPENCODE_CONFIG_DIR, readConfigFile, readConfigLayers, writeConfig } from './shared.js';
import {
  createSkillPolicyService,
  handleSkillPolicyWrite,
  renameSkillKeepingSwitches,
  isValidSkillPolicyId,
  skillIdFromPath,
} from './skill-policy.js';
import { isSkillFolderName, readSkillIdSelector, selectSkillById } from './skill-identity.js';
import { asNonEmptyString, isString } from '../shared/guards.js';
import { appendInstalledSources, isInstalledFromSource, readInstalledSources, removeInstalledSources } from '../skills-catalog/installed-sources.js';

/**
 * Matches how OpenCode reads its own boolean env flags: any value other than
 * unset, empty, "0" or "false" enables the flag.
 */
const isEnvFlagEnabled = (value) => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '0' && normalized !== 'false';
};

// Directories whose last known skill policy is kept for queued deliveries.
const MAX_KNOWN_POLICY_DIRECTORIES = 50;

export const registerSkillRoutes = (app, dependencies) => {
  const {
    fs,
    path,
    os,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    readSettingsFromDisk,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,

    getOpenCodeAuthHeaders,
    getOpenCodePort,
    getSkillSources,
    discoverSkills,
    mergeDiscoveredSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    deleteSkillAt,
    isDeletableSkillPath,
    renameSkill,
    isManagedSkillPath,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources,
    getCacheKey,
    scanWithCache,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    fetchGitHubRepoMetas,
    getProfiles,
    getProfile,
    createHttpsCredentialReference,
    resolveSourceControlAccount,
    credentialResolver,
    // The global switch writes the user's OpenCode config, the project
    // switch the project config file OpenChamber writes for the directory.
    skillPolicyService = createSkillPolicyService({
      resolveTargets: (directory) => {
        const { paths } = readConfigLayers(directory);
        return { global: paths.userPath, project: directory ? paths.projectPath : null };
      },
      readConfigFile,
      writeConfig,
    }),
  } = dependencies;

  const resolveCatalogGitIdentity = async (identityId, source) => {
    if (!identityId || identityId === 'global') return { ok: true, identity: null };

    const profile = getProfile(identityId);
    if (!profile) {
      return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
    }

    const transport = profile.transport ?? 'system';
    if (transport === 'system') return { ok: true, identity: null };
    if (transport === 'anonymous') return { ok: true, identity: { anonymous: true, transport } };

    const parsed = parseSkillRepoSource(source);
    if (!parsed.ok) return { ok: true, identity: null };

    if (transport === 'ssh') {
      return {
        ok: true,
        identity: {
          transport,
          credentialId: profile.sshCredentialId,
          endpoint: parsed.cloneUrlSsh,
        },
      };
    }

    if (transport === 'account' && profile.account && resolveSourceControlAccount && createHttpsCredentialReference) {
      const account = await resolveSourceControlAccount(profile.account);
      if (account?.credentialId !== profile.account.accountId
        || account.status !== 'valid'
        || !Number.isSafeInteger(account.credentialRevision)
        || account.credentialRevision < 1) {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }

      let credentialId;
      try {
        credentialId = createHttpsCredentialReference({
          provider: profile.account.provider,
          instance: profile.account.instance,
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
        });
      } catch {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }

      return {
        ok: true,
        identity: {
          transport: 'https',
          credentialId,
          endpoint: parsed.cloneUrlHttps,
        },
      };
    }

    return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
  };

  const findWorktreeRootForSkills = (workingDirectory) => {
    if (!workingDirectory) return null;
    let current = path.resolve(workingDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  };

  const getSkillProjectAncestors = (workingDirectory) => {
    if (!workingDirectory) return [];
    const result = [];
    let current = path.resolve(workingDirectory);
    const stop = findWorktreeRootForSkills(workingDirectory) || current;
    while (true) {
      result.push(current);
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  };

  const isPathInside = (candidatePath, parentPath) => {
    if (!candidatePath || !parentPath) return false;
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  };

  // `projectAncestors` is `getSkillProjectAncestors(workingDirectory)`, worked
  // out once per list: it probes the disk up to the repository root, and a
  // list has hundreds of skills.
  const inferSkillScopeAndSourceFromPath = (skillPath, projectAncestors) => {
    const resolvedPath = typeof skillPath === 'string' ? path.resolve(skillPath) : '';
    const home = os.homedir();
    const source = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
      ? 'agents'
      : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
        ? 'claude'
        : 'opencode';

    const isProjectScoped = projectAncestors.some((ancestor) => {
      const candidates = [
        path.join(ancestor, '.opencode'),
        path.join(ancestor, '.claude', 'skills'),
        path.join(ancestor, '.agents', 'skills'),
      ];
      return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
    });

    if (isProjectScoped) {
      return { scope: SKILL_SCOPE.PROJECT, source };
    }

    const userRoots = [
      OPENCODE_CONFIG_DIR,
      path.join(home, '.opencode'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills'),
      process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
    ].filter(Boolean);

    if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
      return { scope: SKILL_SCOPE.USER, source };
    }

    return { scope: SKILL_SCOPE.USER, source };
  };

  const makeOpenCodeClient = (workingDirectory) => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: {
      ...getOpenCodeAuthHeaders(),
      // v2 scopes a request with a header, not a `directory` option, and
      // rejects non-ASCII header values, so the path is percent-encoded.
      ...(workingDirectory ? { 'x-opencode-directory': encodeURIComponent(workingDirectory) } : {}),
    },
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
  });

  // What the skill policy service reads from the running OpenCode. Both
  // reject when OpenCode is not running, so a failed read never looks like
  // a server without policies.
  const openCodePolicyReader = {
    readVersion: async () => {
      if (!getOpenCodePort()) throw new Error('OpenCode is not running');
      const info = await makeOpenCodeClient(null).server.info();
      return isString(info?.version) ? info.version : null;
    },
    readConfigEntries: async (workingDirectory) => {
      if (!getOpenCodePort()) throw new Error('OpenCode is not running');
      const entries = await makeOpenCodeClient(workingDirectory).config.get();
      if (!Array.isArray(entries)) throw new Error('OpenCode returned a malformed config list');
      return entries;
    },
  };

  // Returns null when OpenCode's list could not be read (not running, error,
  // timeout, malformed payload) so callers can tell a failed fetch from a
  // genuinely empty list.
  const fetchOpenCodeDiscoveredSkills = async (workingDirectory) => {
    if (!getOpenCodePort()) {
      return null;
    }

    try {
      const client = makeOpenCodeClient(workingDirectory);
      const response = await client.skill.list();
      const payload = response?.data;
      if (!Array.isArray(payload)) {
        return null;
      }

      const projectAncestors = getSkillProjectAncestors(workingDirectory);
      return payload
        .map((item) => {
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          // OpenCode v1's skill payload used `location`; v2 renamed the field
          // to `path`. Accept both, or the whole authoritative list is dropped
          // and the panel falls back to the (smaller) local disk scan.
          const rawLocation = typeof item?.path === 'string' ? item.path : (typeof item?.location === 'string' ? item.location : '');
          // v1 marked built-in skills with `<built-in>`; v2 gives them a synthetic
          // `/builtin/<id>.md` path. Normalize so they stay read-only in the panel.
          const location = rawLocation.startsWith('/builtin/') ? '<built-in>' : rawLocation;
          const description = typeof item?.description === 'string' ? item.description : '';
          const content = typeof item?.content === 'string' ? item.content : '';
          // v2 reports the id; derive it from the path for a payload without.
          const id = isValidSkillPolicyId(item?.id) ? item.id : skillIdFromPath(rawLocation);
          if (!name || !location) {
            return null;
          }
          if (location === '<built-in>') {
            return {
              id,
              name,
              path: location,
              scope: SKILL_SCOPE.USER,
              source: 'opencode',
              description,
              content,
            };
          }
          const inferred = inferSkillScopeAndSourceFromPath(location, projectAncestors);
          const skill = {
            id,
            name,
            path: location,
            scope: inferred.scope,
            source: inferred.source,
            description,
          };
          if (content) {
            skill.content = content;
          }
          return skill;
        })
        .filter(Boolean);
    } catch (error) {
      console.error('Failed to list OpenCode skills:', error);
      return null;
    }
  };

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };

  // Prefer an explicit request directory, then soft-fallback to the active
  // project / lastDirectory so repository-local skills stay visible when the
  // client omits `directory` (create already used resolveProjectDirectory).
  const resolveSkillsDirectory = async (req) => {
    const optional = await resolveOptionalProjectDirectory(req);
    if (optional.error) {
      return optional;
    }
    if (optional.directory) {
      return optional;
    }

    try {
      const fallback = await resolveProjectDirectory(req);
      if (fallback.directory) {
        return { directory: fallback.directory, error: null };
      }
    } catch {
      // ignore — listing user-scoped skills without a project is valid
    }

    return { directory: null, error: null };
  };

  // The last effective state OpenCode reported per directory and skill id,
  // from the list, the switch and queued deliveries. A queued delivery that
  // cannot read the policy uses it, so a skill last seen switched off stays
  // out. A failed read never replaces it.
  const knownEffective = new Map(); // directory key → Map(id → 'enabled' | 'disabled')
  const effectiveKey = (directory) => (directory ? path.resolve(directory) : '');
  const rememberEffective = (directory, skills) => {
    const key = effectiveKey(directory);
    const known = knownEffective.get(key) ?? new Map();
    for (const { id, effective } of skills) {
      if (effective === 'enabled' || effective === 'disabled') known.set(id, effective);
    }
    // Most recently read last, so the bound drops the directory read longest ago.
    knownEffective.delete(key);
    knownEffective.set(key, known);
    if (knownEffective.size > MAX_KNOWN_POLICY_DIRECTORIES) knownEffective.delete(knownEffective.keys().next().value);
  };

  // Policy state for the listed skills, keyed by OpenCode skill id. A failure
  // here answers `{ error }` and leaves the skill list intact.
  const readSkillPolicyForList = async (directory, skills) => {
    try {
      const ids = skills.map((skill) => skill.id).filter(isString);
      const state = await skillPolicyService.readState({ directory, ids, openCode: openCodePolicyReader });
      rememberEffective(directory, state.skills);
      return state;
    } catch (error) {
      console.error('Failed to read skill policies:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  // The skills the list shows for a directory: OpenCode's list, then the disk
  // scan, one entry per OpenCode id.
  const listSkillInventory = async (directory) => mergeDiscoveredSkills(
    (await fetchOpenCodeDiscoveredSkills(directory)) ?? [],
    await discoverSkills(directory),
  );

  const listInstalledSkillIds = async (directory) => new Set(
    (await listSkillInventory(directory)).map((skill) => skill.id).filter(isString),
  );

  /**
   * For the message queue's delivery: the effective state of the skills a
   * queued instruction names in the item's `directory`, by id (`ids`) and,
   * for instructions queued without ids, by display name or id (`names`).
   *
   * Answers `{ states, inventory }`. `states` maps an id to `enabled` or
   * `disabled`: what OpenCode's config says now, else the last state it
   * reported for that directory; an id it cannot answer is left out
   * (unknown). `inventory` lists `{ id, name }` of the installed skills when
   * `names` asked for it, and is null when OpenCode's own skill list could not
   * be read: the disk scan alone misses built-in skills, so a name cannot be
   * resolved completely. Never throws for a failed read.
   */
  const readQueuedSkillPolicy = async ({ directory, ids, names }) => {
    const candidateIds = new Set(ids);
    let inventory = null;
    if (names.length > 0) {
      try {
        const openCodeSkills = await fetchOpenCodeDiscoveredSkills(directory);
        if (openCodeSkills) {
          inventory = mergeDiscoveredSkills(openCodeSkills, await discoverSkills(directory))
            .filter((skill) => isString(skill.id))
            .map((skill) => ({ id: skill.id, name: skill.name }));
        }
      } catch (error) {
        console.error('Failed to list skills for a queued message:', error);
      }
      for (const skill of inventory ?? []) {
        if (names.includes(skill.name) || names.includes(skill.id)) candidateIds.add(skill.id);
      }
    }

    const current = new Map();
    try {
      const { skills } = await skillPolicyService.readState({ directory, ids: [...candidateIds], openCode: openCodePolicyReader });
      rememberEffective(directory, skills);
      for (const skill of skills) current.set(skill.id, skill.effective);
    } catch (error) {
      console.error('Failed to read skill policies for a queued message:', error);
    }
    const known = knownEffective.get(effectiveKey(directory));
    const states = new Map();
    for (const id of candidateIds) {
      const effective = current.get(id);
      const decided = effective === 'enabled' || effective === 'disabled' ? effective : known?.get(id);
      if (decided) states.set(id, decided);
    }
    return { states, inventory };
  };

  // The name-keyed routes take an optional `?id=` (OpenCode skill id). With it
  // they act on that exact listed skill or answer 404, never on another skill
  // with the same display name; without it they keep the display-name lookup.
  // Answers `{ skill, id }` (`skill` null without `?id=`) or `{ status, error }`.
  const resolveSelectedSkill = async (req, skillName, directory) => {
    const { id, error } = readSkillIdSelector(req.query?.id);
    if (error) return { status: 400, error };
    if (!id) return { skill: null, id: null };
    const skill = selectSkillById(await listSkillInventory(directory), id, skillName);
    return skill ? { skill, id } : { status: 404, error: 'Skill not found' };
  };

  // The selected skill's sources: the exact `?id=` skill, else the legacy
  // display-name lookup. Answers `{ sources, skill, id }` or `{ status, error }`.
  const resolveSkillSources = async (req, skillName, directory) => {
    const selected = await resolveSelectedSkill(req, skillName, directory);
    if (selected.error) return selected;
    const skill = selected.skill ?? (((await fetchOpenCodeDiscoveredSkills(directory)) ?? [])
      .find((entry) => entry.name === skillName) || null);
    const sources = await getSkillSources(skillName, directory, skill, { id: selected.id });
    return { sources, skill, id: selected.id ?? skill?.id ?? skillIdFromPath(sources.md.path) };
  };

  // A `targetPath` without `?id=` must be a listed skill file or a `SKILL.md`
  // under a managed skill root; it never names an arbitrary file.
  const isKnownSkillFile = async (directory, targetPath) => {
    const resolved = path.resolve(targetPath);
    if (path.basename(resolved) !== 'SKILL.md') return false;
    const listed = (await listSkillInventory(directory)).some((skill) => isString(skill.path) && path.resolve(skill.path) === resolved);
    return listed || isManagedSkillPath(resolved, directory);
  };

  // Switch one skill on or off in one scope: body `{ id, scope, enabled }`,
  // `id` being OpenCode's skill id. See skill-policy.js for what is written.
  app.put('/api/config/skill-policy', async (req, res) => {
    const scope = req.body?.scope;
    const { directory, error } = scope === 'project'
      ? await resolveOptionalProjectDirectory(req)
      : await resolveSkillsDirectory(req);
    if (error) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_directory', message: error } });
    }
    const result = await handleSkillPolicyWrite({
      service: skillPolicyService,
      body: req.body,
      directory,
      openCode: openCodePolicyReader,
      listInstalledSkillIds,
    });
    if (result.body.ok && isString(result.body.id)) rememberEffective(directory, [{ id: result.body.id, ...result.body.policy }]);
    return res.status(result.status).json(result.body);
  });

  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const openCodeSkills = await fetchOpenCodeDiscoveredSkills(directory);
      const localSkills = await discoverSkills(directory);
      const skills = mergeDiscoveredSkills(openCodeSkills ?? [], localSkills);

      // One skill at a time: each await hands the event loop back, so other
      // requests are served while hundreds of skills are read.
      const enrichedSkills = [];
      for (const skill of skills) {
        // The list carries no supporting files; the skill page reads them
        // from GET /api/config/skills/:name.
        const sources = await getSkillSources(skill.name, directory, skill, { includeSupportingFiles: false });
        const skillPath = typeof skill.path === 'string' ? skill.path : null;
        enrichedSkills.push({
          ...skill,
          sources,
          renamable: Boolean(
            skillPath
            && skillPath !== '<built-in>'
            && isManagedSkillPath(skillPath, directory)
          ),
        });
      }

      // OpenCode decides which external skill roots it loads from process
      // env, and the browser cannot read that. Report the flags alongside the
      // scan so the client can narrow its list to what the agent can actually
      // invoke.
      //
      // OpenCode's own skill-list endpoint is not usable for this: on 1.18.14
      // it returns only global and builtin skills, omitting the project
      // `.agents`/`.claude` skills the agent demonstrably has.
      const body = {
        skills: enrichedSkills,
        externalSkills: {
          // `OPENCODE_DISABLE_CLAUDE_CODE` is the broad switch; the specific
          // one wins independently — OpenCode ORs them.
          claudeDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE)
            || isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
          allDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS),
        },
      };
      // The list is only the disk scan when OpenCode's own list failed:
      // built-in skills and anything OpenCode finds only through its config
      // are missing, so the client must not treat this as complete.
      if (openCodeSkills === null) {
        body.openCodeSkillsUnavailable = true;
      }
      body.skillPolicy = await readSkillPolicyForList(directory, enrichedSkills);
      res.json(body);
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];

      const githubRepos = sources
        .map((src) => parseSkillRepoSource(src.source))
        .filter((parsed) => parsed.ok && parsed.host === 'github.com')
        .map((parsed) => parsed.normalizedRepo);
      const repoMetas = await fetchGitHubRepoMetas(githubRepos);

      const sourcesForUi = sources.map(({ gitIdentityId, excludedSkills, ...rest }) => {
        const parsed = parseSkillRepoSource(rest.source);
        const meta = parsed.ok && parsed.host === 'github.com'
          ? repoMetas[parsed.normalizedRepo] || {}
          : {};
        return {
          ...rest,
          stars: typeof meta.stars === 'number' ? meta.stars : null,
          repoUpdatedAt: typeof meta.repoUpdatedAt === 'string' ? meta.repoUpdatedAt : null,
        };
      });

      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
      }

      const resolvedDiscovered = mergeDiscoveredSkills(
        (await fetchOpenCodeDiscoveredSkills(directory)) ?? [],
        await discoverSkills(directory),
      );
      const installedByName = new Map(resolvedDiscovered.map((s) => [s.name, s]));

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        ref: parsed.ref,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });
      const resolvedIdentity = await resolveCatalogGitIdentity(src.gitIdentityId, src.source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const scanResult = await scanWithCache(
        cacheKey,
        () => scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolvedIdentity.identity,
          credentialResolver,
        }),
        { refresh },
      );

      if (!scanResult.ok) {
        if (scanResult.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: { ...scanResult.error, identities: listGitIdentitiesForResponse() },
          });
        }
        return res.status(500).json({ ok: false, error: scanResult.error });
      }

      const excludedSkills = new Set(src.excludedSkills || []);
      // Provenance recorded at install time makes the badge source-aware; a
      // name the registry has never heard of keeps the old name match, so
      // skills installed before the registry existed look unchanged (#4756).
      const provenanceByName = readInstalledSources();
      const items = (scanResult.items || []).filter((item) => !excludedSkills.has(item.skillName)).map((item) => {
        const installed = installedByName.get(item.skillName);
        const isInstalled = Boolean(installed)
          && isInstalledFromSource(provenanceByName, item.skillName, src.id, item.skillDir);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: isInstalled
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({
        ok: false,
        error: { kind: 'unknown', message: error.message || 'Failed to load catalog source' },
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const result = await scanSkillsRepository({
        source,
        subpath,
        identity: resolvedIdentity.identity,
        credentialResolver,
      });

      if (!result.ok) {
        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        sourceId,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = req.body || {};

      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          });
        }
        workingDirectory = resolved.directory;
      }

      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity: resolvedIdentity.identity,
        credentialResolver,
        scope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections,
        conflictPolicy,
        conflictDecisions,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') {
          return res.status(409).json({ ok: false, error: result.error });
        }

        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const installedAny = installed.length > 0;
      const provenanceSourceId = asNonEmptyString(sourceId);

      if (installedAny && provenanceSourceId) {
        try {
          appendInstalledSources(installed.map((entry) => ({
            skillName: entry.skillName,
            skillDir: entry.skillDir,
            scope: entry.scope,
            source: entry.source,
            sourceId: provenanceSourceId,
            sourceRef: source,
          })));
        } catch (error) {
          // Provenance only refines the Installed badge; a failed write must
          // not fail an install that already succeeded.
          console.error('Failed to record skill install provenance:', error);
        }
      }

      res.json({
        ok: true,
        installed,
        skipped,
        ...(installedAny
          ? buildAppliedResponse('Skills installed successfully.')
          : {
            requiresReload: false,
            message: 'No skills were installed',
          }),
      });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to install skills' } });
    }
  });

  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const resolved = await resolveSkillSources(req, skillName, directory);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { sources } = resolved;

      res.json({
        name: skillName,
        id: resolved.id,
        path: sources.md.path ?? resolved.skill?.path ?? null,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const resolved = await resolveSkillSources(req, skillName, directory);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { sources } = resolved;
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = scope === SKILL_SCOPE.PROJECT
        ? await resolveProjectDirectory(req)
        : await resolveSkillsDirectory(req);
      if (error || (scope === SKILL_SCOPE.PROJECT && !directory)) {
        return res.status(400).json({ error: error || 'Project skill creation requires a directory' });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      await createSkill(skillName, { ...config, source: skillSource }, directory, scope);
      res.json(buildAppliedResponse(
        `Skill ${skillName} created successfully.`,
      ));
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const selected = await resolveSelectedSkill(req, skillName, directory);
      if (selected.error) {
        return res.status(selected.status).json({ error: selected.error });
      }
      if (selected.skill && !(isString(selected.skill.path) && path.basename(selected.skill.path) === 'SKILL.md' && fs.existsSync(selected.skill.path))) {
        return res.status(409).json({ error: `Skill "${skillName}" has no SKILL.md file to edit` });
      }

      if (isString(updates?.renameTo)) {
        const newName = updates.renameTo.trim();
        console.log(`[Server] Renaming skill: ${skillName} -> ${newName}`);
        console.log('[Server] Working directory:', directory);
        // A skill a switch turned off stays off under its new id: the
        // switch's own deny is carried before the folder moves.
        const { newPath, switches } = await renameSkillKeepingSwitches({
          service: skillPolicyService,
          directory,
          listSkillFiles: (dir) => discoverSkills(dir, { allCopies: true }),
          rename: (beforeMove) => renameSkill(skillName, newName, directory, { skillPath: selected.skill?.path ?? null, beforeMove }),
        });
        // OpenCode 2 watches the skills directories: the renamed folder is
        // picked up like any other write, no restart and no client reload.
        // The folder took the new name, so the OpenCode id is `newName` now.
        return res.json({
          ...buildAppliedResponse(`Skill renamed to ${newName} successfully.`),
          name: newName,
          id: skillIdFromPath(newPath),
          path: newPath ?? null,
          switches,
        });
      }

      const requestedTarget = isString(updates?.targetPath) && updates.targetPath.trim()
        ? path.resolve(updates.targetPath.trim())
        : null;
      let targetPath = requestedTarget;
      if (selected.skill) {
        if (requestedTarget && requestedTarget !== path.resolve(selected.skill.path)) {
          return res.status(409).json({ error: 'targetPath does not match the selected skill' });
        }
        targetPath = selected.skill.path;
      } else if (requestedTarget && !(await isKnownSkillFile(directory, requestedTarget))) {
        return res.status(400).json({ error: 'targetPath is not a known skill file' });
      }

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      const updatedPath = await updateSkill(skillName, updates, directory, targetPath);
      res.json({
        ...buildAppliedResponse(`Skill ${skillName} updated successfully.`),
        id: skillIdFromPath(updatedPath),
        path: updatedPath ?? null,
      });
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      // A rename stopped to keep a switch (unreadable or unwritable config) carries its status.
      const status = Number.isInteger(error?.status) ? error.status : 500;
      res.status(status).json({ error: error.message || 'Failed to update skill' });
    }
  });

  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { content } = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const resolved = await resolveSkillSources(req, skillName, directory);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { sources } = resolved;
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const resolved = await resolveSkillSources(req, skillName, directory);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { sources } = resolved;
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      // `scope` and `source` together narrow the delete to the copy in that
      // one folder, named by the id or, without one, by the display name.
      const scope = asNonEmptyString(req.query.scope);
      const source = asNonEmptyString(req.query.source);
      let location;
      if (scope || source) {
        if (!['user', 'project'].includes(scope) || !['opencode', 'claude', 'agents'].includes(source)) {
          return res.status(400).json({ error: 'scope must be user or project and source opencode, claude or agents' });
        }
        location = { scope, source };
      }

      // Install provenance is keyed by the install folder name, the id. It
      // stays while the disk scan for this directory, the user skill roots
      // and this project, still finds a copy of the id. Other projects are
      // not scanned; the record has no project field.
      const forgetProvenanceOnceGone = async (id) => {
        if ((await discoverSkills(directory)).some((skill) => skill.id === id)) return;
        try {
          removeInstalledSources(id);
        } catch (error) {
          console.error('Failed to forget skill install provenance:', error);
        }
      };

      if (location) {
        const { id, error: idError } = readSkillIdSelector(req.query?.id);
        if (idError) {
          return res.status(400).json({ error: idError });
        }
        // The located folder itself, never the copy OpenCode lists first
        // under this id: that one may be a same-named skill kept elsewhere.
        const folderName = id ?? skillName;
        if (!isSkillFolderName(folderName)) {
          return res.status(400).json({ error: 'Invalid skill name' });
        }
        deleteSkill(folderName, directory, location);
        await forgetProvenanceOnceGone(folderName);
        return res.json({
          ...buildAppliedResponse(`Skill ${skillName} deleted successfully.`),
          ...(id ? { id } : {}),
        });
      }

      const selected = await resolveSelectedSkill(req, skillName, directory);
      if (selected.error) {
        return res.status(selected.status).json({ error: selected.error });
      }

      if (selected.skill) {
        // Exactly the selected skill's folder, nested groups included; other
        // copies or skills sharing the display name stay. Refused when the
        // folder sits outside a managed root, symlinks followed.
        if (!isString(selected.skill.path) || !isDeletableSkillPath(selected.skill.path, directory)) {
          return res.status(409).json({ error: `Skill "${skillName}" is outside managed skill directories and cannot be deleted` });
        }
        await deleteSkillAt(selected.skill.path, directory);
        await forgetProvenanceOnceGone(selected.id);
        return res.json({
          ...buildAppliedResponse(`Skill ${skillName} deleted successfully.`),
          id: selected.id,
          path: selected.skill.path,
        });
      }

      if (!isSkillFolderName(skillName)) {
        return res.status(400).json({ error: 'Invalid skill name' });
      }
      deleteSkill(skillName, directory);
      try {
        removeInstalledSources(skillName);
      } catch (error) {
        // Provenance only refines the Installed badge; the skill is gone either way.
        console.error('Failed to forget skill install provenance:', error);
      }
      res.json(buildAppliedResponse(
        `Skill ${skillName} deleted successfully.`,
      ));
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill' });
    }
  });

  return { readQueuedSkillPolicy };
};
