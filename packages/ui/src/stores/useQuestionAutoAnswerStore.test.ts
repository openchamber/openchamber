import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { QuestionRequest } from "@/types/question";

const respondCalls: Array<{ sessionId: string; requestId: string; answers: string[][] }> = [];

mock.module("@/sync/session-actions", () => ({
  respondToQuestion: mock((sessionId: string, requestId: string, answers: string[][]) => {
    respondCalls.push({ sessionId, requestId, answers });
    return Promise.resolve();
  }),
}));

const {
  useQuestionAutoAnswerStore,
  clampQuestionAutoAnswerDelay,
  MIN_QUESTION_AUTO_ANSWER_DELAY,
  MAX_QUESTION_AUTO_ANSWER_DELAY,
  DEFAULT_QUESTION_AUTO_ANSWER_DELAY,
} = await import("./useQuestionAutoAnswerStore");

let questionCounter = 0;
const makeQuestion = (overrides?: Partial<QuestionRequest>): QuestionRequest => ({
  id: `q-${++questionCounter}`,
  sessionID: "session-1",
  questions: [
    {
      question: "Pick one",
      header: "Choice",
      options: [
        { label: "First", description: "" },
        { label: "Second", description: "" },
      ],
    },
  ],
  ...overrides,
});

beforeEach(() => {
  respondCalls.length = 0;
  useQuestionAutoAnswerStore.setState({
    enabled: true,
    delaySeconds: DEFAULT_QUESTION_AUTO_ANSWER_DELAY,
    deadlines: {},
  });
});

describe("clampQuestionAutoAnswerDelay", () => {
  test("clamps to min/max and rounds", () => {
    expect(clampQuestionAutoAnswerDelay(0)).toBe(MIN_QUESTION_AUTO_ANSWER_DELAY);
    expect(clampQuestionAutoAnswerDelay(99999)).toBe(MAX_QUESTION_AUTO_ANSWER_DELAY);
    expect(clampQuestionAutoAnswerDelay(10.6)).toBe(11);
    expect(clampQuestionAutoAnswerDelay(Number.NaN)).toBe(DEFAULT_QUESTION_AUTO_ANSWER_DELAY);
  });
});

describe("useQuestionAutoAnswerStore", () => {
  test("schedule registers a deadline when enabled", () => {
    const question = makeQuestion();
    useQuestionAutoAnswerStore.getState().schedule(question);
    const deadline = useQuestionAutoAnswerStore.getState().deadlines[question.id];
    expect(deadline).toBeGreaterThan(Date.now());
    useQuestionAutoAnswerStore.getState().clear(question.id);
  });

  test("schedule is a no-op when disabled", () => {
    useQuestionAutoAnswerStore.getState().setEnabled(false);
    const question = makeQuestion();
    useQuestionAutoAnswerStore.getState().schedule(question);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);
  });

  test("schedule skips questions without options", () => {
    const question = makeQuestion({
      questions: [{ question: "Free form", header: "", options: [] }],
    });
    useQuestionAutoAnswerStore.getState().schedule(question);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);
  });

  test("cancel removes the deadline and blocks rescheduling", () => {
    const question = makeQuestion();
    useQuestionAutoAnswerStore.getState().schedule(question);
    useQuestionAutoAnswerStore.getState().cancel(question.id);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);

    useQuestionAutoAnswerStore.getState().schedule(question);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);
  });

  test("clear removes the deadline but allows rescheduling", () => {
    const question = makeQuestion();
    useQuestionAutoAnswerStore.getState().schedule(question);
    useQuestionAutoAnswerStore.getState().clear(question.id);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);

    useQuestionAutoAnswerStore.getState().schedule(question);
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBeGreaterThan(Date.now());
    useQuestionAutoAnswerStore.getState().clear(question.id);
  });

  test("disabling cancels all pending deadlines", () => {
    const a = makeQuestion();
    const b = makeQuestion();
    useQuestionAutoAnswerStore.getState().schedule(a);
    useQuestionAutoAnswerStore.getState().schedule(b);
    useQuestionAutoAnswerStore.getState().setEnabled(false);
    expect(useQuestionAutoAnswerStore.getState().deadlines).toEqual({});
  });

  test("fires respondToQuestion with first option of each question after the delay", async () => {
    useQuestionAutoAnswerStore.setState({ delaySeconds: MIN_QUESTION_AUTO_ANSWER_DELAY });
    const question = makeQuestion({
      questions: [
        {
          question: "Pick one",
          header: "A",
          options: [
            { label: "Alpha", description: "" },
            { label: "Beta", description: "" },
          ],
        },
        {
          question: "Pick another",
          header: "B",
          options: [{ label: "Gamma", description: "" }],
          multiple: true,
        },
      ],
    });
    useQuestionAutoAnswerStore.getState().schedule(question);

    await new Promise((resolve) => setTimeout(resolve, MIN_QUESTION_AUTO_ANSWER_DELAY * 1000 + 200));

    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0]).toEqual({
      sessionId: "session-1",
      requestId: question.id,
      answers: [["Alpha"], ["Gamma"]],
    });
    expect(useQuestionAutoAnswerStore.getState().deadlines[question.id]).toBe(undefined);
  });
});
