/**
 * The Jev questions behind "In work" and the session-assist gate, and the
 * decisions taken from their answers.
 *
 * The wording and thresholds were measured on 156 real sessions and then
 * checked on 190 held-out ones (send and turn end together: 4/92 work sessions
 * missed, 10/78 false opens). Keep the criteria general common sense about
 * coding-agent work; never phrase them after one user's habits. Change them
 * only with a new measurement.
 */
import { z } from 'zod';

const TURN_END_CONTEXT = 'This is a turn in a chat between a user and an AI coding agent. `request` is the latest user message, `answer` is the agent\'s reply to it, and `history` holds earlier turns, oldest first, only to explain what a short `request` refers to.';
const SEND_CONTEXT = 'This is a message a user just sent to an AI coding agent. `request` is that message and `history` holds earlier turns, oldest first, only to explain what a short `request` refers to.';

const CHANGE = {
  question: 'Does `request` ask the agent to change the project: build or add a feature, fix a bug, change code, UI, docs, or configuration, or approve a change the agent proposed so it gets carried out?',
  criteria: {
    true: 'The user wants the project changed: "fix this", "add X", "let\'s redesign Y", "implement the proposed improvements", "go ahead" after a proposed change, or feedback that asks to adjust something the agent just changed.',
    false: 'The user only wants information or an opinion: a question, an explanation, research, a report, a code or PR review, triage, a draft message to send someone, a status summary, running a command to show output, or a git housekeeping step such as commit, push, merge, or sync.',
  },
};

const TOWARD_CHANGE = {
  question: 'Is the user working toward a concrete change to their project in `request`: asking for a change, reporting a bug or problem in the project, or discussing how something in the project should change?',
  criteria: {
    true: 'Asking to build, fix, change, redesign, or remove something in the project; a bug report, user complaint, error, or broken behaviour of the project, even without the word "fix"; proposing or discussing a concrete change or redesign; approving a proposal ("go ahead", "yes, do it"); feedback on something just changed.',
    false: 'Only wanting to know or understand: how something works, a status catch-up, a code tour, searching history, a PR review or triage, drafting a reply to someone, general questions or opinions, or tasks unrelated to the project; also a bare housekeeping step such as commit, push, merge, or sync.',
  },
};

/**
 * Reads the whole turn, not only `request`: a shipping step (commit, push,
 * merge, sync, release) closes the work once `answer` reports it done.
 * Measured against the earlier request-only wording at the same threshold:
 * held-out 70 hints in 106 work sessions (18 followed by more edits) against
 * 60 (16), and 47 of 81 shipping steps hinted against 33. The threshold then
 * went from 0.85 to 0.8: 80 hints (22), 53 of 81 shipping steps, so a closing
 * turn whose answer hands the user a last check still gets the hint. The
 * answer excerpt then grew from 300+300 to 500+500 characters for
 * `review_ready`; re-run with the production request cut, wrap-up held: 80
 * hints (22) against 81 (24), 53 of 77 shipping steps either way.
 */
const WRAP_UP = 'Does this turn close out the work in this conversation: in `request` the user confirms it works or is good, thanks the agent, or asks to commit, push, merge, sync, or release it, without asking for any further change, and `answer` reports that step done?';

/**
 * Asked with `wrap_up`: the turn handed over changes the user could look over
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

const NEXT_STEP = {
  question: 'After `answer`, is part of what the user asked for in `request` still unfinished, so the agent could continue it with one more message without the user first testing, deciding, or approving anything?',
  criteria: {
    true: 'The agent stopped part-way: it names remaining steps of the requested work it can do itself, or the work was cut off.',
    false: 'The request is satisfied, or the next move belongs to the user (test, choose, approve, answer a question), or an analysis, explanation, or recommendation was requested and delivered.',
  },
};

/** Open when either passes (measured together). */
const OPEN_THRESHOLDS = { change: 0.85, towardChange: 0.9 };
const WRAP_UP_THRESHOLD = 0.8;
const REVIEW_READY_THRESHOLD = 0.7;
/** The recap is skipped only when Jev is nearly sure there is nothing to remind. */
const RECAP_SKIP_BELOW = 0.3;
const NEXT_STEP_THRESHOLD = 0.5;

const noul = (context, { question, criteria }) => {
  const asked = { type: 'noul', instructions: [context, question] };
  if (criteria) asked.criteria = criteria;
  return asked;
};

/** The request Jev reads when a message was just sent. */
export const buildSendRequest = ({ history, request }) => ({
  state: { history, request },
  questions: {
    change: noul(SEND_CONTEXT, CHANGE),
    toward_change: noul(SEND_CONTEXT, TOWARD_CHANGE),
  },
});

/**
 * The request Jev reads when a turn ended, or null when nothing is asked.
 * `ask` names the groups: `open` (the session is not in work), `wrapUp` (it
 * is), `reviewReady` (the review offer is on), `recap` and `nextStep` (the
 * assist fields the user has on).
 */
export const buildTurnEndRequest = ({ history, request, answer, ask }) => {
  const questions = {};
  if (ask.open) {
    questions.change = noul(TURN_END_CONTEXT, CHANGE);
    questions.toward_change = noul(TURN_END_CONTEXT, TOWARD_CHANGE);
  }
  if (ask.wrapUp) questions.wrap_up = noul(TURN_END_CONTEXT, { question: WRAP_UP });
  if (ask.reviewReady) questions.review_ready = noul(TURN_END_CONTEXT, REVIEW_READY);
  if (ask.recap) questions.recap = noul(TURN_END_CONTEXT, RECAP);
  if (ask.nextStep) questions.next_step = noul(TURN_END_CONTEXT, NEXT_STEP);
  if (Object.keys(questions).length === 0) return null;
  return { state: { history, request, answer }, questions };
};

const noulAnswer = z.object({ noul: z.number() });
const answerOf = (answers, id) => noulAnswer.safeParse(answers?.[id]).data?.noul ?? null;

/** True when the answers say real work started; a missing answer never opens. */
export const decideOpen = (answers) => {
  const change = answerOf(answers, 'change');
  const towardChange = answerOf(answers, 'toward_change');
  return (change !== null && change >= OPEN_THRESHOLDS.change)
    || (towardChange !== null && towardChange >= OPEN_THRESHOLDS.towardChange);
};

export const decideWrapUp = (answers) => {
  const score = answerOf(answers, 'wrap_up');
  return score !== null && score >= WRAP_UP_THRESHOLD;
};

export const decideReviewReady = (answers) => {
  const score = answerOf(answers, 'review_ready');
  return score !== null && score >= REVIEW_READY_THRESHOLD;
};

/**
 * Which assist fields are worth the Small Model. A field Jev did not answer
 * stays allowed: an unanswered question must not silence the assist.
 */
export const decideAssist = (answers) => {
  const recap = answerOf(answers, 'recap');
  const nextStep = answerOf(answers, 'next_step');
  return {
    recap: recap === null || recap >= RECAP_SKIP_BELOW,
    suggestion: nextStep === null || nextStep >= NEXT_STEP_THRESHOLD,
  };
};
