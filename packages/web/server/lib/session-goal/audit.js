/**
 * The goal progress check: three yes/no questions about the agent's latest
 * turn, asked either of Jev (the classification model) or of the small model,
 * and one decision taken from the answers in code.
 *
 * Jev answers each question with a probability; the small model answers the
 * same questions as JSON booleans, read as 1 or 0, so both go through the same
 * decision. Measured on 144 goal-report turns (hand-written, labelled before
 * any answer was seen) plus 8 real goal turns: Jev 142/144 with both misses
 * on the safe side (a finished turn read as "continue"), gpt-6-luna 141/144.
 * Change the wording or the thresholds only with a new run of that measurement.
 */
import { z } from 'zod';

const CONTEXT = 'A user gave an AI coding agent the goal in `objective`. `answer` is the agent\'s latest message, which ends with a report of what is done and what remains.';

const QUESTIONS = {
  all_done: {
    question: 'Does `answer` report that all the work requested in `objective` is done?',
    criteria: {
      true: 'Every part the objective asks for is reported done. Steps left only for the user, such as testing in the app, reviewing, or committing, and optional ideas the objective did not ask for, do not count against it. A step the objective itself asks the agent to do, such as a commit or a pull request, counts as requested work.',
      false: 'Some requested part is reported unfinished, skipped, postponed, not started, or only partly done, or the agent narrowed the goal to a subset, even if the message says "done".',
    },
  },
  remaining: {
    question: 'Does `answer` name requested work that the agent itself still has to do?',
    criteria: {
      true: 'The message lists or mentions remaining steps of the objective the agent can still carry out, or says it will continue, fix, retry, or finish something.',
      false: 'Nothing of the objective is left for the agent: either everything is done, or what is left needs the user, or it is only user-side checking the objective did not ask the agent to do, or an optional unrequested idea.',
    },
  },
  needs_user: {
    question: 'Does `answer` say the agent cannot go on with the objective without something only the user can provide?',
    criteria: {
      true: 'The agent is stopped by missing credentials, login, keys or access; a decision between options only the user can make; a device or machine it cannot reach; or an external failure it cannot work around.',
      false: 'The agent can keep going on its own: it picked a sensible default, the problem is one it can fix or retry, it only asks an optional question, or all that is left for the user is testing or review of finished work.',
    },
  },
};

const QUESTION_IDS = Object.keys(QUESTIONS);

/**
 * How the agent ends a goal turn, sent with the goal's first turn and every
 * continuation. Each report line answers one question above, so the check
 * reads the agent's own words for it, and "nothing" is said out loud rather
 * than left to be inferred. User-side steps get no line, since they do not
 * keep a goal open (the `remaining` and `needs_user` criteria).
 *
 * Commands that never finish are stopped every turn, with no exception: the
 * loop waits for a background command started in the round (`runtime.js`), and
 * a server left running would hold every round for the full wait.
 */
export const GOAL_REPORT_INSTRUCTIONS = [
  'Your final message is read by an independent check, and it ends the run. Send it only when the whole objective is done and verified, or when only the user can unblock you. Stopping with work you could still do yourself is an early stop.',
  '',
  'Before that message, stop every background command you started that does not finish on its own, such as a dev server or a watcher.',
  '',
  'End that message with a short status block, in the language of your reply, with exactly these four lines:',
  '- Done: what is finished.',
  '- Verified: how you checked it (the command, test or file), or "not verified".',
  '- Remaining: the parts of the objective you still have to do yourself, or "nothing".',
  '- Needs from the user: what only the user can provide before you can go on (credentials, access, a choice you cannot safely default), or "nothing".',
  'Unless the objective asks for them, testing in the app, review and committing are the user\'s steps after the work, not remaining work and not blockers. When it asks for them, such as a commit or a pull request, they are part of the work. Report what is true: unfinished work goes in Remaining.',
].join('\n');

/**
 * How the agent works on a goal, sent with the first turn and every
 * continuation. It says nothing about the loop continuing a stopped agent: a
 * promised continuation reads as permission to stop after one step.
 */
export const GOAL_MISSION_INSTRUCTIONS = [
  'Work autonomously through the entire objective in this one run. The user is away and is not reading progress updates.',
  '- When a step is finished, start the next one in the same run.',
  '- Decide open questions yourself with the most sensible default, note the choice, and go on.',
  '- When something fails, find the cause and try another route.',
  '- Check each part by running it, and fix what the check finds.',
  '- Autonomy covers the objective\'s own work. Leave out irreversible or outward-facing actions it does not ask for.',
].join('\n');
const THRESHOLD = 0.5;

// The report sits at the end of a turn, so a long turn keeps its opening and,
// mostly, its close.
const ANSWER_HEAD_CHARS = 2_000;
const ANSWER_TAIL_CHARS = 8_000;

const excerptAnswer = (text) => (text.length <= ANSWER_HEAD_CHARS + ANSWER_TAIL_CHARS
  ? text
  : `${text.slice(0, ANSWER_HEAD_CHARS).trimEnd()}\n[…]\n${text.slice(-ANSWER_TAIL_CHARS).trimStart()}`);

/** The Jev request for one check. */
export const buildJevAuditRequest = ({ objective, answer }) => ({
  state: { objective, answer: excerptAnswer(answer) },
  questions: Object.fromEntries(Object.entries(QUESTIONS).map(([id, { question, criteria }]) => [
    id,
    { type: 'noul', instructions: [CONTEXT, question], criteria },
  ])),
});

const noulAnswer = z.object({ noul: z.number() });

/** Jev's answers as scores, or null when any question went unanswered. */
export const readJevAnswers = (answers) => {
  const scores = {};
  for (const id of QUESTION_IDS) {
    const parsed = noulAnswer.safeParse(answers?.[id]);
    if (!parsed.success) return null;
    scores[id] = parsed.data.noul;
  }
  return scores;
};

/** The same questions for the small model, as one prompt asking for JSON booleans. */
export const buildSmallModelAuditPrompt = ({ objective, answer }) => [
  'You check the progress of an AI coding agent. Answer three yes/no questions and return exactly one JSON object and nothing else — no prose, no markdown, no code fences: {"all_done": boolean, "remaining": boolean, "needs_user": boolean}.',
  CONTEXT,
  ...Object.entries(QUESTIONS).map(([id, { question, criteria }]) => `${id}: ${question}\n  true: ${criteria.true}\n  false: ${criteria.false}`),
  `<objective>\n${objective}\n</objective>`,
  `<answer>\n${excerptAnswer(answer)}\n</answer>`,
  'Return the JSON.',
].join('\n\n');

const smallModelAnswers = z.object({ all_done: z.boolean(), remaining: z.boolean(), needs_user: z.boolean() });

/** The small model's reply as scores, or null when it is not the asked-for JSON. */
export const readSmallModelAnswers = (text) => {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = smallModelAnswers.safeParse(json);
  if (!parsed.success) return null;
  return Object.fromEntries(QUESTION_IDS.map((id) => [id, parsed.data[id] ? 1 : 0]));
};

/**
 * `blocked` first: a turn that waits on the user is not finished even when
 * everything else is. `complete` needs the report to say all is done and name
 * nothing left for the agent; anything else keeps the goal going.
 */
export const decideProgress = (scores) => {
  if (scores.needs_user >= THRESHOLD) return 'blocked';
  if (scores.all_done >= THRESHOLD && scores.remaining < THRESHOLD) return 'complete';
  return 'continue';
};
