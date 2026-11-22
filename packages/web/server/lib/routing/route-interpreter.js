/**
 * Turns one sentence about the model pools into overrides.
 *
 * Stages run in order: keywords (phrases and names, no model), then a local
 * model, then the classification provider. A certain keyword answer stops
 * there. Only the keyword stage asks a question, so the user is asked at most
 * one thing. Pure: nothing here reads or writes files, so the stages and the
 * learning can be tested directly.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ALIASES = {
  anthropic: ['anthropic'],
  openai: ['openai', 'gpt', 'chatgpt'],
  google: ['google', 'gemini'],
};
const FAMILIES = ['opus', 'sonnet', 'haiku'];
const ACTIONS = ['avoid', 'prefer', 'allow-over-budget'];
const DURATIONS = ['hour', 'rest_of_day', 'week', 'none'];
export const DEFAULT_TOGGLES = { keywords: true, local: true, external: true };

const AVOID =
  /\b(don'?t use|do not use|dont use|stop using|avoid|skip|exclude|no more|never use|is down|are down|not working|isn'?t working|is broken|keep off|turn off|without)\b/;
const PREFER = /\b(prefer|favou?r|use only|only use|switch to|back to|stick to|use|go with)\b/;
const BUDGET = /\b(credits?|budget|spend|burn|unlimited|ignore (?:the )?(?:budget|limit)s?|no limit)\b/;
const POOLS = /\b(include|add)\b.*\bpools?\b/;
const LIGHTER = /\b(less|lighter|fewer|rarely|go easy on|lower priority|deprioritize|deprioritise)\b/;
const NOT_FIXED = /\b(except|excluding|apart from|but not|not on|not)\b[^.]{0,24}\bfixed\b/;

const has = (text, word) => new RegExp(`\\b${word}\\b`).test(text);

const normalize = (input) => input.toLowerCase().replace(/[’`]/g, "'");

const priorityOf = (text, lighter) => {
  const stated = /\b(\d+(?:\.\d+)?)\s*x\b/.exec(text);
  if (stated && Number(stated[1]) > 0) return lighter ? 1 / Number(stated[1]) : Number(stated[1]);
  return lighter ? 1 / 3 : 3;
};

const untilOf = (text, now) => {
  if (/\b(rest of (the )?day|today|tonight)\b/.test(text)) {
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return { until: end.getTime(), assumed: false };
  }
  if (/\bthis week\b/.test(text)) return { until: now + 7 * DAY, assumed: false };
  const stated = /\bfor (\d+)\s*(minutes?|mins?|hours?|hrs?|h|days?|d)\b/.exec(text);
  if (stated) {
    const unit = stated[2].startsWith('m') ? 60_000 : stated[2].startsWith('h') ? HOUR : DAY;
    return { until: now + Number(stated[1]) * unit, assumed: false };
  }
  return { until: now + DAY, assumed: true };
};

const durationOf = (duration, now) => {
  if (duration === 'hour') return { until: now + HOUR, assumed: false };
  if (duration === 'week') return { until: now + 7 * DAY, assumed: false };
  if (duration === 'rest_of_day') {
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return { until: end.getTime(), assumed: false };
  }
  return { until: now + DAY, assumed: true };
};

const versionOf = (id) => (id.match(/\d+/g) ?? []).map(Number).filter((value) => value < 10_000);

const newer = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
};

/** The newest model of a family on each provider that has one, by version number. */
const latestOf = (family, models) => {
  const best = new Map();
  for (const model of models) {
    if (!model.id.toLowerCase().includes(family)) continue;
    const version = versionOf(model.id);
    const current = best.get(model.providerID);
    if (!current || newer(version, current.version)) best.set(model.providerID, { id: model.id, version });
  }
  return [...best.entries()].map(([providerID, value]) => ({ providerID, id: value.id }));
};

// Only configured providers count: "gemini" with no google provider names the
// gemini models other providers serve (github-copilot/gemini-*), found below.
const providersMentioned = (text, providers) =>
  providers.filter((id) => (ALIASES[id] ?? [id]).some((word) => has(text, word)));

/** Models the sentence names exactly, as `provider/model` or a bare model id; a `#variant` is ignored. */
const namedModels = (text, models) => {
  const found = new Map();
  for (const raw of text.split(/[\s,;!?()"']+/)) {
    const token = raw.replace(/[.:]+$/, '').split('#')[0];
    if (!token) continue;
    for (const model of models) {
      const id = model.id.toLowerCase();
      if (token === id || token === `${model.providerID.toLowerCase()}/${id}`) {
        found.set(`${model.providerID}/${model.id}`, model);
      }
    }
  }
  return [...found.values()];
};

// A missing exact reference must not fall through to a whole-provider or
// family preference. Historical models can disappear from the catalog.
const unavailableReference = (text, models) => text.split(/[\s,;!?()"']+/)
  .map((token) => token.replace(/[.:]+$/, '').split('#')[0])
  .find((token) => token.includes('/') && !models.some((model) =>
    token === `${model.providerID}/${model.id}`.toLowerCase()));

const nameWordsOf = (id) => id.toLowerCase().split(/[^a-z0-9]+/).filter((word) => /^[a-z]{3,}$/.test(word));

/**
 * A kind of model is a word the sentence shares with model names: "gemini"
 * names gemini-4-carbon and gemini-2.5-pro, "flash" every flash model. Words
 * of a named provider id do not count, so "github-copilot" alone stays a
 * provider. Matches only models that are available now.
 */
const modelsOfKind = (text, models, providers) => {
  const providerWords = new Set(providers.flatMap((id) => [...nameWordsOf(id), ...(ALIASES[id] ?? [])]));
  const words = new Set((text.match(/[a-z]{3,}/g) ?? []).filter((word) => !providerWords.has(word)));
  const scoped = providers.length ? models.filter((model) => providers.includes(model.providerID)) : models;
  return scoped.filter((model) => nameWordsOf(model.id).some((word) => words.has(word)));
};

const scopesByProvider = (models) => {
  const groups = new Map();
  for (const model of models) groups.set(model.providerID, [...(groups.get(model.providerID) ?? []), model.id]);
  return [...groups].map(([providerID, ids]) => ({ providers: [providerID], models: ids }));
};

const actionOf = (text) => {
  const actions = [];
  if (AVOID.test(text)) actions.push('avoid');
  else if (PREFER.test(text)) actions.push('prefer');
  if (BUDGET.test(text) && !actions.includes('avoid')) actions.push('allow-over-budget');
  return actions;
};

const summarize = (drafts, until, assumed) => {
  const scope = drafts
    .map((draft) =>
      [
        draft.providers.length ? draft.providers.join(', ') : 'any provider',
        draft.models.length ? draft.models.join(', ') : 'all models',
      ].join(' / '),
    )
    .join('; ');
  const actions = [...new Set(drafts.map((draft) => draft.action))].join(' + ');
  const when = new Date(until).toLocaleString();
  return `${actions}: ${scope}, until ${when}${assumed ? ' (assumed a day; say otherwise to change it)' : ''}`;
};

const draftFor = ({ action, providers = [], models = [], factor, fixed, until, text }) => ({
  action,
  providers,
  models,
  ...(action === 'prefer' ? { factor } : {}),
  fixed,
  until,
  text,
});

const decided = (stage, confidence, drafts, until, assumed) => ({
  status: 'decided',
  stage,
  confidence,
  drafts,
  summary: summarize(drafts, until, assumed),
});

const unknown = (stage, reason) => ({ status: 'unknown', stage, reason });

/**
 * The keyword stage. `learned` maps a question key to the option the user chose
 * last time often enough to trust, which then answers the question without asking.
 */
export const keywords = (input, context, learned = {}) => {
  const text = normalize(input);
  const stage = 'keywords';
  if (POOLS.test(text)) return unknown(stage, 'Adding models to pools is not supported by a sentence yet.');

  const actions = actionOf(text);
  if (actions.length === 0) return unknown(stage, 'No action (avoid, prefer, or spend past budget) was recognised.');

  const { until, assumed } = untilOf(text, context.now);
  const providers = providersMentioned(text, context.providers);
  const families = FAMILIES.filter((family) => has(text, family));
  const claude = has(text, 'claude');
  const action = actions[0];
  const lighter = LIGHTER.test(text);
  const fixed = !NOT_FIXED.test(text);
  const factor = priorityOf(text, lighter);
  const drafts = (scope) => actions.map((item) => draftFor({ action: item, ...scope, factor, fixed, until, text: input }));
  const modelDrafts = (models) => scopesByProvider(models).flatMap(drafts);

  const missingReference = unavailableReference(text, context.models);
  if (missingReference) return unknown(stage, `The model ${missingReference} is not in the available catalog.`);
  const named = namedModels(text, context.models);
  if (named.length > 0) return decided(stage, assumed ? 'tentative' : 'certain', modelDrafts(named), until, assumed);

  if (families.length === 0 && !claude) {
    const kind = modelsOfKind(text, context.models, providers);
    if (kind.length > 0) return decided(stage, 'tentative', modelDrafts(kind), until, assumed);
  }

  if (families.length === 0 && providers.length === 0 && !claude) {
    return unknown(stage, 'No provider or model was named.');
  }

  if (claude && providers.length === 0 && families.length === 0) {
    return withLearned(
      {
        status: 'clarify',
        stage,
        key: 'claude',
        timing: { until, assumed },
        question: 'Do you mean the Anthropic provider, or every Claude model from any provider?',
        options: [
          { label: 'Anthropic provider only', drafts: drafts({ providers: ['anthropic'] }) },
          { label: 'Every Claude model, any provider', drafts: drafts({ models: ['*claude*'] }) },
        ],
      },
      learned,
      { until, assumed },
    );
  }

  if (families.length > 0 && providers.length === 0) {
    const family = families[0];
    if (action === 'avoid') {
      return withLearned(
        {
          status: 'clarify',
          stage,
          key: `avoid-${family}`,
          timing: { until, assumed },
          question: `Avoid ${family} from every provider, or only Anthropic's ${family}?`,
          options: [
            { label: `Every ${family}, any provider`, drafts: drafts({ models: [`*${family}*`] }) },
            { label: `Only Anthropic's ${family}`, drafts: drafts({ providers: ['anthropic'], models: [`*${family}*`] }) },
          ],
        },
        learned,
        { until, assumed },
      );
    }
    const latest = latestOf(family, context.models);
    const scopes = latest.length
      ? latest.map((model) => ({ providers: [model.providerID], models: [model.id] }))
      : [{ models: [`*${family}*`] }];
    const all = scopes.flatMap((scope) => actions.map((item) => draftFor({ action: item, ...scope, factor, fixed, until, text: input })));
    return decided(stage, latest.length && !assumed ? 'certain' : 'tentative', all, until, assumed);
  }

  const models = families.map((family) => `*${family}*`);
  const all = actions.map((item) => draftFor({ action: item, providers, models, factor, fixed, until, text: input }));
  return decided(stage, assumed ? 'tentative' : 'certain', all, until, assumed);
};

/** Replaces a question with its learned answer when the user has settled it before. */
const withLearned = (question, learned, timing) => {
  const option = question.options.find((item) => item.label === learned[question.key]);
  if (!option) return question;
  const result = decided(question.stage, 'tentative', option.drafts, timing.until, timing.assumed);
  return { ...result, summary: `${result.summary} (your earlier choice)`, origin: { key: question.key, option: option.label } };
};

/** The decision for an option the user picked from a clarifying question, or null for an unknown label. */
export const answerQuestion = (question, label) => {
  const option = question.options.find((item) => item.label === label);
  if (!option) return null;
  const { until, assumed } = question.timing;
  return {
    ...decided(question.stage, 'certain', option.drafts, until, assumed),
    origin: { key: question.key, option: label },
  };
};

/** The choice questions the smart stages answer. Each has a fixed set of answers, so a model only picks. */
export const choiceQuestions = (context) => ({
  action: {
    type: 'choice',
    instructions: 'What should happen to the models the user names? Pick none if the sentence is not about routing.',
    criteria: {
      avoid: 'Stop using the named models, or a provider that is down or unwanted.',
      prefer: 'Use the named models more, or first.',
      'allow-over-budget': 'Keep using the named models even past a budget or credit limit.',
      none: 'Not about the routing of models.',
    },
  },
  provider: {
    type: 'choice',
    instructions: 'Which provider does the user name? Pick none if no provider is named.',
    criteria: {
      ...Object.fromEntries(context.providers.map((id) => [id, `The ${id} provider.`])),
      none: 'No provider is named.',
    },
  },
  family: {
    type: 'choice',
    instructions: 'Which model family does the user name? Pick none if no family is named.',
    criteria: {
      opus: 'The Opus family.',
      sonnet: 'The Sonnet family.',
      haiku: 'The Haiku family.',
      none: 'No model family is named.',
    },
  },
  duration: {
    type: 'choice',
    instructions: 'How long should this last?',
    criteria: {
      hour: 'About an hour.',
      rest_of_day: 'Until the end of today.',
      week: 'About a week.',
      none: 'No duration is given.',
    },
  },
});

/** Turns the answers from a smart stage into a decision. Anything it cannot scope safely is unknown. */
export const fromChoices = ({ action, provider, family, duration }, { text, context, confidence = 'tentative' }) => {
  const stage = 'smart';
  if (!ACTIONS.includes(action)) return unknown(stage, 'The text is not about routing.');
  const providers = context.providers.includes(provider) ? [provider] : [];
  const models = FAMILIES.includes(family) ? [`*${family}*`] : [];
  if (providers.length === 0 && models.length === 0) return unknown(stage, 'No provider or model was named.');
  if (action === 'avoid' && providers.length === 0) return unknown(stage, 'Avoiding a family needs a provider to scope it.');
  const { until, assumed } = durationOf(DURATIONS.includes(duration) ? duration : 'none', context.now);
  const fixed = !NOT_FIXED.test(normalize(text));
  const lighter = LIGHTER.test(normalize(text));
  const drafts = [
    draftFor({ action, providers, models, factor: priorityOf(normalize(text), lighter), fixed, until, text }),
  ];
  return decided(stage, confidence, drafts, until, assumed);
};

/**
 * A small model invents names, so provider and family come from the sentence
 * itself (only when exactly one is named); the model chooses the action and duration.
 */
export const groundChoices = (answers, text, context) => {
  const lower = normalize(text);
  const providers = providersMentioned(lower, context.providers).filter((id) => context.providers.includes(id));
  const families = FAMILIES.filter((family) => has(lower, family));
  return {
    action: answers.action,
    duration: answers.duration,
    provider: providers.length === 1 ? providers[0] : undefined,
    family: families.length === 1 ? families[0] : undefined,
  };
};

/**
 * The keyword stage decides or asks whenever it can read the sentence; the smart
 * stages only get sentences it cannot read, so a model never overrides a question
 * the user should answer. Local, then external: the first one that decides wins.
 */
export const interpret = async ({ text, context, learned = {}, toggles = DEFAULT_TOGGLES, stages = {} }) => {
  const missingReference = unavailableReference(normalize(text), context.models);
  if (missingReference) return unknown('keywords', `The model ${missingReference} is not in the available catalog.`);
  let fallback;
  if (toggles.keywords) {
    const result = keywords(text, context, learned);
    if (result.status !== 'unknown') return result;
    fallback = result;
  }
  for (const name of ['local', 'external']) {
    const stage = stages[name];
    if (!toggles[name] || !stage) continue;
    const result = await Promise.resolve()
      .then(() => stage(text, context))
      .catch(() => undefined);
    if (result && result.status !== 'unknown') return result;
  }
  return fallback ?? unknown('none', 'Could not tell what to change from that.');
};

export const toOverrides = (drafts, { source = 'user', now, summary = '', origin }) =>
  drafts.map((draft, index) => ({
    id: `${source}:${now}:${index}:${draft.action}`,
    action: draft.action,
    providers: draft.providers,
    models: draft.models,
    routes: [],
    fixed: draft.fixed !== false,
    ...(draft.factor !== undefined ? { factor: draft.factor } : {}),
    until: draft.until,
    text: draft.text,
    summary,
    source,
    createdAt: now,
    ...(origin ? { origin } : {}),
  }));
