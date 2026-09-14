import { create } from "zustand"

export type QuestionSubmissionIdentity = {
  runtimeKey: string
  sessionID: string
  requestID: string
}

export type QuestionSubmission = {
  answers: string[][]
  customAnswers: Record<number, string>
  pending: boolean
}

type QuestionSubmissionState = {
  submissions: Map<string, QuestionSubmission>
  begin: (identity: QuestionSubmissionIdentity, answers: string[][], customAnswers: Record<number, string>) => boolean
  update: (identity: QuestionSubmissionIdentity, index: number, answer: string[], customAnswer?: string) => boolean
  release: (identity: QuestionSubmissionIdentity) => void
  clear: (identity: QuestionSubmissionIdentity) => void
}

function submissionKey({ runtimeKey, sessionID, requestID }: QuestionSubmissionIdentity): string {
  return `${runtimeKey}\u0000${sessionID}\u0000${requestID}`
}

export const useQuestionSubmissionStore = create<QuestionSubmissionState>((set, get) => ({
  submissions: new Map(),
  begin: (identity, answers, customAnswers) => {
    const key = submissionKey(identity)
    if (get().submissions.get(key)?.pending) return false
    set((state) => ({
      submissions: new Map(state.submissions).set(key, { answers, customAnswers, pending: true }),
    }))
    return true
  },
  update: (identity, index, answer, customAnswer) => {
    const key = submissionKey(identity)
    const current = get().submissions.get(key)
    if (!current || current.pending) return false
    const answers = [...current.answers]
    answers[index] = answer
    const customAnswers = { ...current.customAnswers }
    if (customAnswer === undefined) {
      delete customAnswers[index]
    } else {
      customAnswers[index] = customAnswer
    }
    set((state) => ({
      submissions: new Map(state.submissions).set(key, { answers, customAnswers, pending: false }),
    }))
    return true
  },
  release: (identity) => {
    const key = submissionKey(identity)
    const current = get().submissions.get(key)
    if (!current || !current.pending) return
    set((state) => ({
      submissions: new Map(state.submissions).set(key, { ...current, pending: false }),
    }))
  },
  clear: (identity) => {
    const key = submissionKey(identity)
    if (!get().submissions.has(key)) return
    set((state) => {
      const submissions = new Map(state.submissions)
      submissions.delete(key)
      return { submissions }
    })
  },
}))

export function getQuestionSubmission(identity: QuestionSubmissionIdentity): QuestionSubmission | null {
  return useQuestionSubmissionStore.getState().submissions.get(submissionKey(identity)) ?? null
}

export function beginQuestionSubmission(
  identity: QuestionSubmissionIdentity,
  answers: string[][],
  customAnswers: Record<number, string> = {},
): boolean {
  return useQuestionSubmissionStore.getState().begin(identity, answers, customAnswers)
}

export function releaseQuestionSubmission(identity: QuestionSubmissionIdentity): void {
  useQuestionSubmissionStore.getState().release(identity)
}

export function updateQuestionSubmission(
  identity: QuestionSubmissionIdentity,
  index: number,
  answer: string[],
  customAnswer?: string,
): boolean {
  return useQuestionSubmissionStore.getState().update(identity, index, answer, customAnswer)
}

export function clearQuestionSubmission(identity: QuestionSubmissionIdentity): void {
  useQuestionSubmissionStore.getState().clear(identity)
}

export function resetQuestionSubmissionStateForTests(): void {
  useQuestionSubmissionStore.setState({ submissions: new Map() })
}
