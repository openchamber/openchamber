/**
 * The Jev questions asked when a turn ends: whether the work looks done,
 * whether there are changes worth a look, and the session-assist gate; and
 * the decisions taken from their answers.
 *
 * Looks done and the next-step gate read plain signs of the agent's message
 * (is it a report, does the agent say it goes on, does it wait for the user,
 * does it offer more); the code combines them. A small model recognises such
 * signs reliably, while a question that weighs the whole conversation
 * ("does this turn close out the work") asks it to reason. Keep the criteria
 * general common sense about coding-agent work; never phrase them after one
 * user's habits. Change them only with a new measurement (DOCUMENTATION.md).
 */
import { z } from 'zod';

const TURN_END_CONTEXT = 'This is a turn in a chat between a user and an AI coding agent. `request` is the latest user message, `answer` is the agent\'s reply to it, and `history` holds earlier turns, oldest first, only to explain what a short `request` refers to.';

/** The signs are about `answer` alone; the conversation stays in the state for the other questions. */
const MESSAGE_CONTEXT = '`answer` is a message an AI coding agent wrote to its user. `request` and `history` are the conversation before it.';

const SIGNS = {
  report: 'Does `answer` read like a report of finished work?',
  agent_continues: 'Does `answer` say the agent will do more work itself?',
  waits_reader: 'Does `answer` wait for the reader\'s answer or decision before going on?',
  offers_agent: 'Does `answer` offer optional extra work the agent could do?',
};
const LOOKS_DONE_SIGNS = ['report', 'agent_continues', 'waits_reader', 'offers_agent'];
const NEXT_STEP_SIGNS = ['agent_continues', 'waits_reader'];
const SIGN_THRESHOLD = 0.5;

/**
 * Asked in the same call: the turn handed over changes the user could look over
 * (the composer then offers an AI review or a walkthrough). Measured against
 * whether the turn ran an edit tool, which Jev never sees: on 190 held-out
 * sessions at 0.7, with a looks-done hint taking precedence, it hinted after
 * 271 of 362 edit turns and after 14 of 823 turns without edits. Two other
 * wordings (handed over as done; no criteria) hinted 4-7x more on turns
 * without edits. Most false hints are cleanups outside the code (deleted
 * builds); most misses say "did not change the app" after scratch edits.
 */
const REVIEW_READY = {
  question: 'Did the agent change the project in this turn, so there are new changes the user could look over now?',
  criteria: {
    true: '`answer` reports that the agent itself edited the project in this turn: implemented, fixed, added, removed, refactored, or rewrote code, UI, docs, tests, or configuration.',
    false: 'The agent only explained, answered a question, investigated, reviewed code or a PR, proposed or planned a change without making it, drafted a message, ran commands to show output, or committed, pushed, or merged changes made earlier; or it failed before changing anything.',
  },
};

const RECAP = {
  question: 'Is there substantive work or a finding in this conversation worth a one-line reminder later: something the agent changed, fixed, found out, or a decision that was reached?',
  criteria: {
    true: 'The agent changed code, fixed or diagnosed something, answered a real question with a concrete finding, or the user and agent settled a decision.',
    false: 'Only small talk, a greeting, an acknowledgment, a trivial lookup, or a command whose output needs no reminder.',
  },
};

const REVIEW_READY_THRESHOLD = 0.7;
/** The recap is skipped only when Jev is nearly sure there is nothing to remind. */
const RECAP_SKIP_BELOW = 0.3;

const noul = (context, { question, criteria }) => {
  const asked = { type: 'noul', instructions: [context, question] };
  if (criteria) asked.criteria = criteria;
  return asked;
};

/**
 * The request Jev reads when a turn ended, or null when nothing is asked.
 * `ask` names the groups: `wrapUp` (the session is in work), `reviewReady`
 * (the review offer is on), `recap` and `nextStep` (the assist fields the
 * user has on). A sign both groups need is asked once.
 */
export const buildTurnEndRequest = ({ history, request, answer, ask }) => {
  const questions = {};
  const signs = new Set([...(ask.wrapUp ? LOOKS_DONE_SIGNS : []), ...(ask.nextStep ? NEXT_STEP_SIGNS : [])]);
  for (const id of signs) questions[id] = noul(MESSAGE_CONTEXT, { question: SIGNS[id] });
  if (ask.reviewReady) questions.review_ready = noul(TURN_END_CONTEXT, REVIEW_READY);
  if (ask.recap) questions.recap = noul(TURN_END_CONTEXT, RECAP);
  if (Object.keys(questions).length === 0) return null;
  return { state: { history, request, answer }, questions };
};

const noulAnswer = z.object({ noul: z.number() });
const answerOf = (answers, id) => noulAnswer.safeParse(answers?.[id]).data?.noul ?? null;
/** True or false for an answered sign, null for one Jev did not answer. */
const signOf = (answers, id) => {
  const score = answerOf(answers, id);
  return score === null ? null : score >= SIGN_THRESHOLD;
};

/** A report of finished work, with the agent neither going on, waiting for the user, nor offering more. */
export const decideWrapUp = (answers) => signOf(answers, 'report') === true
  && signOf(answers, 'agent_continues') === false
  && signOf(answers, 'waits_reader') === false
  && signOf(answers, 'offers_agent') === false;

export const decideReviewReady = (answers) => {
  const score = answerOf(answers, 'review_ready');
  return score !== null && score >= REVIEW_READY_THRESHOLD;
};

/**
 * Which assist fields are worth the Small Model. A field Jev did not answer
 * stays allowed: an unanswered question must not silence the assist. A next
 * step is worth suggesting when the agent says it goes on and is not waiting
 * for the user.
 */
export const decideAssist = (answers) => {
  const recap = answerOf(answers, 'recap');
  const continues = signOf(answers, 'agent_continues');
  const waits = signOf(answers, 'waits_reader');
  return {
    recap: recap === null || recap >= RECAP_SKIP_BELOW,
    suggestion: continues === null || waits === null || (continues && !waits),
  };
};
