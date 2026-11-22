/**
 * The Jev questions behind "In work" and the session-assist gate, and the
 * decisions taken from their answers: whether a sent message or a finished
 * turn starts work (asked only while sessions enter In work by Jev's
 * decision), whether the work looks done, whether there are changes worth a
 * look.
 *
 * The wording and thresholds were measured on 156 real sessions and then
 * checked on 190 held-out ones (send and turn end together: 4/92 work sessions
 * missed, 10/78 false opens). Keep the criteria general common sense about
 * coding-agent work; never phrase them after one user's habits. Change them
 * only with a new measurement.
 */
import { z } from 'zod';
import type { createJevClient } from '../routing/jev.js';

export interface TurnEndRequestInput {
  history: { role: string; text: string }[];
  request: string;
  answer: string;
  ask: { wrapUp: boolean; nextStep: boolean; reviewReady: boolean; recap: boolean };
}

interface Question {
  type: 'noul';
  instructions: string[];
  criteria?: { true: string; false: string };
}

export interface TurnEndRequest {
  state: Omit<TurnEndRequestInput, 'ask'>;
  questions: Record<string, Question>;
}

export type TurnEndAnswers = Awaited<ReturnType<ReturnType<typeof createJevClient>['ask']>>['answers'];

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

const MESSAGE_CONTEXT = '`answer` is a message an AI coding agent wrote to its user. `request` and `history` are the conversation before it.';

const SIGNS = {
  report: 'Does `answer` read like a report of finished work?',
  agent_continues: 'Does `answer` say the agent will do more work itself?',
  waits_reader: 'Does `answer` wait for the reader\'s answer or decision before going on?',
  offers_agent: 'Does `answer` offer optional extra work the agent could do?',
};
const LOOKS_DONE_SIGNS: (keyof typeof SIGNS)[] = ['report', 'agent_continues', 'waits_reader', 'offers_agent'];
const NEXT_STEP_SIGNS: (keyof typeof SIGNS)[] = ['agent_continues', 'waits_reader'];
const SIGN_THRESHOLD = 0.5;

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

/** Open when either passes (measured together). */
const OPEN_THRESHOLDS = { change: 0.85, towardChange: 0.9 };
const REVIEW_READY_THRESHOLD = 0.7;
const RECAP_SKIP_BELOW = 0.3;

const noul = (context: string, { question, criteria }: { question: string } & Pick<Question, 'criteria'>): Question => {
  const asked: Question = { type: 'noul', instructions: [context, question] };
  if (criteria) asked.criteria = criteria;
  return asked;
};

/** The request Jev reads when a message was just sent. */
export const buildSendRequest = ({ history, request }: { history: TurnEndRequestInput['history']; request: string }) => ({
  state: { history, request },
  questions: {
    change: noul(SEND_CONTEXT, CHANGE),
    toward_change: noul(SEND_CONTEXT, TOWARD_CHANGE),
  },
});

export const buildTurnEndRequest = ({ history, request, answer, ask }: TurnEndRequestInput & { ask: TurnEndRequestInput['ask'] & { open?: boolean } }): TurnEndRequest | null => {
  const questions: TurnEndRequest['questions'] = {};
  // `open`: Jev decides what enters In work and the session is not in work.
  if (ask.open) {
    questions.change = noul(TURN_END_CONTEXT, CHANGE);
    questions.toward_change = noul(TURN_END_CONTEXT, TOWARD_CHANGE);
  }
  const signs = new Set([...(ask.wrapUp ? LOOKS_DONE_SIGNS : []), ...(ask.nextStep ? NEXT_STEP_SIGNS : [])]);
  for (const id of signs) questions[id] = noul(MESSAGE_CONTEXT, { question: SIGNS[id] });
  if (ask.reviewReady) questions.review_ready = noul(TURN_END_CONTEXT, REVIEW_READY);
  if (ask.recap) questions.recap = noul(TURN_END_CONTEXT, RECAP);
  if (Object.keys(questions).length === 0) return null;
  return { state: { history, request, answer }, questions };
};

const noulAnswer = z.object({ noul: z.number() });
const answerOf = (answers: TurnEndAnswers | null | undefined, id: string) => noulAnswer.safeParse(answers?.[id]).data?.noul ?? null;

/** True when the answers say real work started; a missing answer never opens. */
export const decideOpen = (answers: TurnEndAnswers | null | undefined) => {
  const change = answerOf(answers, 'change');
  const towardChange = answerOf(answers, 'toward_change');
  return (change !== null && change >= OPEN_THRESHOLDS.change)
    || (towardChange !== null && towardChange >= OPEN_THRESHOLDS.towardChange);
};

const signOf = (answers: TurnEndAnswers | null | undefined, id: string) => {
  const score = answerOf(answers, id);
  return score === null ? null : score >= SIGN_THRESHOLD;
};

export const decideWrapUp = (answers: TurnEndAnswers | null | undefined) => signOf(answers, 'report') === true
  && signOf(answers, 'agent_continues') === false
  && signOf(answers, 'waits_reader') === false
  && signOf(answers, 'offers_agent') === false;

export const decideReviewReady = (answers: TurnEndAnswers | null | undefined) => {
  const score = answerOf(answers, 'review_ready');
  return score !== null && score >= REVIEW_READY_THRESHOLD;
};

export const decideAssist = (answers: TurnEndAnswers | null | undefined) => {
  const recap = answerOf(answers, 'recap');
  const continues = signOf(answers, 'agent_continues');
  const waits = signOf(answers, 'waits_reader');
  return {
    recap: recap === null || recap >= RECAP_SKIP_BELOW,
    suggestion: continues === null || waits === null || (continues && !waits),
  };
};
