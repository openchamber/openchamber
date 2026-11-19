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

const REVIEW_READY_THRESHOLD = 0.7;
const RECAP_SKIP_BELOW = 0.3;

const noul = (context: string, { question, criteria }: { question: string } & Pick<Question, 'criteria'>): Question => {
  const asked: Question = { type: 'noul', instructions: [context, question] };
  if (criteria) asked.criteria = criteria;
  return asked;
};

export const buildTurnEndRequest = ({ history, request, answer, ask }: TurnEndRequestInput): TurnEndRequest | null => {
  const questions: TurnEndRequest['questions'] = {};
  const signs = new Set([...(ask.wrapUp ? LOOKS_DONE_SIGNS : []), ...(ask.nextStep ? NEXT_STEP_SIGNS : [])]);
  for (const id of signs) questions[id] = noul(MESSAGE_CONTEXT, { question: SIGNS[id] });
  if (ask.reviewReady) questions.review_ready = noul(TURN_END_CONTEXT, REVIEW_READY);
  if (ask.recap) questions.recap = noul(TURN_END_CONTEXT, RECAP);
  if (Object.keys(questions).length === 0) return null;
  return { state: { history, request, answer }, questions };
};

const noulAnswer = z.object({ noul: z.number() });
const answerOf = (answers: TurnEndAnswers | null | undefined, id: string) => noulAnswer.safeParse(answers?.[id]).data?.noul ?? null;
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
