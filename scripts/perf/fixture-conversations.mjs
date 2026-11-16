/**
 * Scripted conversations for the fixture provider, keyed by the user's prompt.
 *
 * The rate-named documents in `fixture-provider.mjs` are stimuli for timing:
 * one document repeated, whatever was asked. A design review needs the
 * opposite, a history that reads like real work, so `scripts/design/shots.mjs`
 * seeds its sessions with the prompts below. When the last user message of a
 * request contains one of these prompts, the fixture plays that script, at
 * seeding speed, whatever model was asked for: tool steps first (OpenCode runs
 * the tools for real against the scratch project), then the answer.
 *
 * The edit step replaces text in `src/api/retry.ts`, so the project's starting
 * content lives here too (`DESIGN_PROJECT_FILES`): the shots script writes it
 * before seeding, and the edit's `oldString` is cut from it.
 */

const FENCE = "```"

const RETRY_SLEEP = "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))"

const RETRY_CATCH_BEFORE = [
  "    } catch (error) {",
  "      lastError = error",
  "      await sleep(options.baseDelayMs * 2 ** attempt)",
  "    }",
].join("\n")

const RETRY_CATCH_AFTER = [
  "    } catch (error) {",
  "      // A cancelled request is the caller's decision, not a failure to retry.",
  "      if (options.signal?.aborted || isAbortError(error)) throw error",
  "      lastError = error",
  "      await sleep(backoff(options.baseDelayMs, attempt), options.signal)",
  "    }",
].join("\n")

const RETRY_ORIGINAL = [
  "export interface RetryOptions {",
  "  /** How many times to call `run`, the first call included. */",
  "  attempts: number",
  "  /** Delay before the second call; it doubles after each failure. */",
  "  baseDelayMs: number",
  "  signal?: AbortSignal",
  "}",
  "",
  RETRY_SLEEP,
  "",
  "export async function withRetry(run: () => Promise<Response>, options: RetryOptions): Promise<Response> {",
  "  let lastError: unknown",
  "  for (let attempt = 0; attempt < options.attempts; attempt += 1) {",
  "    try {",
  "      const response = await run()",
  "      if (response.status >= 500) {",
  "        lastError = new Error(`Server answered ${response.status}`)",
  "        await sleep(options.baseDelayMs * 2 ** attempt)",
  "        continue",
  "      }",
  "      return response",
  RETRY_CATCH_BEFORE,
  "  }",
  "  throw lastError",
  "}",
  "",
].join("\n")

const RETRY_SLEEP_AFTER = [
  "const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {",
  "  const timer = setTimeout(resolve, ms)",
  "  signal?.addEventListener(\"abort\", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })",
  "})",
  "",
  "const isAbortError = (error: unknown) => error instanceof DOMException && error.name === \"AbortError\"",
  "",
  "/** Exponential backoff with full jitter, so clients that failed together do not retry together. */",
  "const backoff = (baseDelayMs: number, attempt: number) => Math.round(Math.random() * baseDelayMs * 2 ** attempt)",
].join("\n")

/** The files a fresh scratch project starts with, committed as its first commit. */
export const DESIGN_PROJECT_FILES = {
  "package.json": JSON.stringify({
    name: "relay-desk",
    version: "0.8.3",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "tsc -b && vite build", test: "vitest run", lint: "eslint src" },
    dependencies: { react: "^19.1.0", "react-dom": "^19.1.0", zustand: "^5.0.3" },
    devDependencies: { typescript: "^5.7.2", vite: "^6.0.7", vitest: "^2.1.8" },
  }, null, 2) + "\n",
  "README.md": [
    "# Relay Desk",
    "",
    "A small support inbox: conversations from email and chat in one list, with drafts that survive a reload.",
    "",
    "## Development",
    "",
    `${FENCE}sh`,
    "npm install",
    "npm run dev",
    FENCE,
    "",
    "The API client lives in `src/api`; every request goes through `withRetry`.",
    "",
  ].join("\n"),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true },
    include: ["src"],
  }, null, 2) + "\n",
  "src/api/retry.ts": RETRY_ORIGINAL,
  "src/api/client.ts": [
    "import { withRetry } from \"./retry\"",
    "",
    "export interface Conversation {",
    "  id: string",
    "  subject: string",
    "  channel: \"email\" | \"chat\"",
    "  updatedAt: number",
    "  unread: number",
    "}",
    "",
    "const BASE_URL = import.meta.env.VITE_API_URL ?? \"/api\"",
    "",
    "async function request<T>(path: string, init: RequestInit = {}): Promise<T> {",
    "  const response = await withRetry(() => fetch(`${BASE_URL}${path}`, init), {",
    "    attempts: 4,",
    "    baseDelayMs: 250,",
    "    signal: init.signal ?? undefined,",
    "  })",
    "  if (!response.ok) throw new Error(`${init.method ?? \"GET\"} ${path} failed with ${response.status}`)",
    "  return response.json() as Promise<T>",
    "}",
    "",
    "export const listConversations = (signal?: AbortSignal) =>",
    "  request<Conversation[]>(\"/conversations\", { signal })",
    "",
    "export const markRead = (id: string) =>",
    "  request<void>(`/conversations/${id}/read`, { method: \"POST\" })",
    "",
  ].join("\n"),
  "src/api/retry.test.ts": [
    "import { describe, expect, it, vi } from \"vitest\"",
    "import { withRetry } from \"./retry\"",
    "",
    "describe(\"withRetry\", () => {",
    "  it(\"returns the first successful response\", async () => {",
    "    const run = vi.fn().mockResolvedValue(new Response(\"ok\"))",
    "    const response = await withRetry(run, { attempts: 3, baseDelayMs: 1 })",
    "    expect(await response.text()).toBe(\"ok\")",
    "    expect(run).toHaveBeenCalledTimes(1)",
    "  })",
    "",
    "  it(\"retries a 503 until it succeeds\", async () => {",
    "    const run = vi.fn()",
    "      .mockResolvedValueOnce(new Response(\"\", { status: 503 }))",
    "      .mockResolvedValue(new Response(\"ok\"))",
    "    await withRetry(run, { attempts: 3, baseDelayMs: 1 })",
    "    expect(run).toHaveBeenCalledTimes(2)",
    "  })",
    "})",
    "",
  ].join("\n"),
  "src/lib/format.ts": [
    "const relative = new Intl.RelativeTimeFormat(undefined, { numeric: \"auto\" })",
    "",
    "/** \"5 minutes ago\", \"yesterday\", or a date for anything older than a week. */",
    "export function formatUpdatedAt(timestamp: number, now = Date.now()): string {",
    "  const minutes = Math.round((timestamp - now) / 60_000)",
    "  if (Math.abs(minutes) < 60) return relative.format(minutes, \"minute\")",
    "  const hours = Math.round(minutes / 60)",
    "  if (Math.abs(hours) < 24) return relative.format(hours, \"hour\")",
    "  const days = Math.round(hours / 24)",
    "  if (Math.abs(days) < 7) return relative.format(days, \"day\")",
    "  return new Date(timestamp).toLocaleDateString()",
    "}",
    "",
  ].join("\n"),
  "src/components/ConversationList.tsx": [
    "import type { Conversation } from \"../api/client\"",
    "import { formatUpdatedAt } from \"../lib/format\"",
    "",
    "interface ConversationListProps {",
    "  conversations: Conversation[]",
    "  selectedId: string | null",
    "  onSelect: (id: string) => void",
    "}",
    "",
    "export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {",
    "  if (conversations.length === 0) return <p className=\"empty\">No conversations yet.</p>",
    "  return (",
    "    <ul className=\"conversation-list\">",
    "      {conversations.map((conversation) => (",
    "        <li key={conversation.id} aria-current={conversation.id === selectedId}>",
    "          <button type=\"button\" onClick={() => onSelect(conversation.id)}>",
    "            <span className=\"subject\">{conversation.subject}</span>",
    "            <time>{formatUpdatedAt(conversation.updatedAt)}</time>",
    "            {conversation.unread > 0 && <span className=\"badge\">{conversation.unread}</span>}",
    "          </button>",
    "        </li>",
    "      ))}",
    "    </ul>",
    "  )",
    "}",
    "",
  ].join("\n"),
}

/** `src/api/retry.ts` after the agent's edit in the main conversation. */
export const DESIGN_RETRY_EDITED = RETRY_ORIGINAL
  .replace(RETRY_SLEEP, RETRY_SLEEP_AFTER)
  .replace(RETRY_CATCH_BEFORE, RETRY_CATCH_AFTER)

const MAIN_ANSWER = [
  "## Що відбувається, коли запит скасовано",
  "",
  "Повтор спрацьовує, бо `withRetry` вважає скасування звичайною помилкою. Коли список розмонтовується, компонент скасовує свій запит, `fetch` падає з `AbortError`, а гілка `catch` у `src/api/retry.ts` записує це в `lastError`, чекає і **викликає `run()` ще раз**. Новий виклик створює свіжий `fetch` з тим самим, уже скасованим, сигналом, тож одразу падає знову, і цикл крутиться, доки не скінчаться `attempts`.",
  "",
  "Звідси й картина з логів:",
  "",
  "1. Користувач переходить з інбоксу в розмову, і список скасовує `GET /conversations`.",
  "2. `withRetry` чекає 250 мс, потім 500 мс, потім 1 с і повторює запит, на який ніхто не чекає.",
  "3. Останній `AbortError` вилітає як необроблена помилка, і це той самий тост «aborted», про який писали.",
  "",
  "### Чому в мережі видно два запити",
  "",
  "**Перший повтор стартує раніше, ніж скасування доходить до паузи.** `sleep` взагалі не знає про сигнал, тож запит, скасований під час очікування, відправляється ще раз.",
  "",
  "**Зламане не тільки скасування.** Усі вкладки, які втратили зʼєднання, повторюють за однаковим розкладом, і саме це дало стрибок навантаження на API після минулого деплою.",
  "",
  "## Що змінити",
  "",
  "Дві правки в `retry.ts`, у тих, хто його викликає, нічого не міняється:",
  "",
  `${FENCE}ts`,
  "} catch (error) {",
  "  // A cancelled request is the caller's decision, not a failure to retry.",
  "  if (options.signal?.aborted || isAbortError(error)) throw error",
  "  lastError = error",
  "  await sleep(backoff(options.baseDelayMs, attempt), options.signal)",
  "}",
  FENCE,
  "",
  "- **Зупинятись на скасуванні.** Одразу кидати помилку далі, щоб `catch` у викликача отримав `AbortError`, якого він чекає.",
  "- **Переривати паузу.** `sleep` приймає сигнал і завершується, щойно він спрацював, тож після скасування повтор не стартує.",
  "- **Додати розкид (jitter).** Затримка стає випадковою в межах `baseDelayMs * 2 ** attempt`, і клієнти перестають бити в сервер одночасно.",
  "",
  "| Випадок | Зараз | Після правки |",
  "| :--- | :--- | :--- |",
  "| Запит скасовано під час виконання | 3 повтори, потім тост | одна помилка, без тосту |",
  "| Скасовано під час паузи | один зайвий запит | жодного запиту |",
  "| Сервер відповів 503 | повтори з фіксованою затримкою | повтори з розкидом |",
  "| Сервер відповів 404 | повертається викликачу | без змін |",
  "",
  "Зробити правку і додати тест на скасування?",
  "",
].join("\n")

const AGENT_SUMMARY = [
  "Готово. `withRetry` тепер зупиняється, щойно запит скасовано, і пауза між повторами переривається разом з ним.",
  "",
  "**Змінені файли**",
  "",
  "- `src/api/retry.ts` (+12 −2): кидаємо `AbortError` далі, `sleep` слухає сигнал, `backoff` з розкидом.",
  "- `src/api/client.ts` без змін: він уже передає `init.signal` у `withRetry`.",
  "",
  "**Що лишилось**",
  "",
  "- Тест на скасування я не додав: `retry.test.ts` працює на справжніх таймерах, і перевести його на `vi.useFakeTimers()` краще окремою правкою.",
  "- `git diff --stat` показує тільки `retry.ts`, тож у PR піде одна зміна.",
  "",
].join("\n")

/**
 * The sessions a design shot shows, newest first. The shots script places
 * each one in time when it stamps the database: its last activity
 * `ageMinutes` before the run, its history spread over `spanMinutes`.
 * `pinned` pins it, `inWork` leaves it in the In work block (every other one
 * is marked done). `steps` are tool steps played before `answer`, one model
 * request each; a step's `reasoning` streams as the model's thinking before
 * its text.
 */
export const DESIGN_SESSIONS = [
  {
    key: "main",
    title: "Повтор запиту спрацьовує після скасування",
    ageMinutes: 14,
    spanMinutes: 9,
    pinned: true,
    turns: [
      {
        prompt: "Коли я переходжу з інбоксу в розмову, у вкладці Network іноді двічі видно GET /conversations, а потім вилазить тост «aborted». Розберись, чому повтор продовжується після того, як список розмонтувався?",
        answer: MAIN_ANSWER,
      },
      {
        prompt: "Так, виправ у retry.ts.",
        steps: [
          {
            reasoning: "Сигнал треба прокинути в sleep, інакше пауза між повторами переживе скасування. Спершу подивлюся, хто ще викликає withRetry.",
            text: "Перечитаю хелпер і гляну, хто його викликає, перш ніж правити.",
            calls: [
              { name: "read", arguments: { path: "src/api/retry.ts" } },
              { name: "grep", arguments: { pattern: "withRetry", path: "src" } },
            ],
          },
          {
            text: "Викликає тільки `client.ts`, і сигнал він уже передає. Правлю хелпер:",
            calls: [
              { name: "edit", arguments: { path: "src/api/retry.ts", oldString: RETRY_SLEEP, newString: RETRY_SLEEP_AFTER } },
              { name: "edit", arguments: { path: "src/api/retry.ts", oldString: RETRY_CATCH_BEFORE, newString: RETRY_CATCH_AFTER } },
            ],
          },
          {
            reasoning: "Обидві правки в одному файлі; варто переконатися, що client.ts не зачепило.",
            text: "Перевіряю, що змінилось:",
            calls: [{ name: "shell", arguments: { command: "git diff --stat" } }],
          },
        ],
        answer: AGENT_SUMMARY,
      },
    ],
  },
  {
    key: "ci-windows",
    title: "Розібратися, чому білд у CI падає на Windows",
    ageMinutes: 75,
    spanMinutes: 3,
    pinned: true,
    turns: [{
      prompt: "Чому білд у CI падає тільки на Windows?",
      answer: "Падає крок `vite build`: шлях до `src\\api` збирається через `path.join`, і в імпортах лишаються зворотні слеші. На macOS і Linux цього не видно. Виправлення в один рядок: `path.posix.join` у `vite.config.ts`.\n",
    }],
  },
  {
    key: "sidebar-scroll",
    title: "Sidebar: keep the scroll position when a project collapses and reopens after a reload",
    ageMinutes: 190,
    spanMinutes: 2,
    inWork: true,
    turns: [{
      prompt: "The sidebar jumps to the top whenever I collapse a project and open it again after a reload. Where is the scroll position lost?",
      answer: "The list remounts when the project's `collapsed` flag changes, and the scroll offset lives in component state, so a remount starts from zero. Keeping the offset per project in the store fixes both the collapse and the reload.\n",
    }],
  },
  {
    key: "settings-migration",
    title: "Міграція налаштувань на нову схему без втрати старих ключів у профілях користувачів",
    ageMinutes: 320,
    spanMinutes: 4,
    inWork: true,
    turns: [{
      prompt: "Як перенести налаштування на нову схему так, щоб старі ключі не загубились?",
      answer: "Читаємо стару схему один раз, пишемо нову поруч і видаляємо старі ключі тільки після успішного запису. Якщо запис упав, старий файл лишається як був, і наступний запуск пробує ще раз.\n",
    }],
  },
  {
    key: "unread-badge",
    title: "Лічильник непрочитаних не скидається після відкриття розмови",
    ageMinutes: 7 * 60,
    spanMinutes: 3,
    inWork: true,
    turns: [{
      prompt: "Чому лічильник непрочитаних лишається, коли розмову вже відкрито?",
      answer: "`markRead` викликається, але список не оновлюється: відповідь сервера ніхто не кладе в стор. Достатньо після успішного `markRead` обнулити `unread` у локальному стані розмови.\n",
    }],
  },
  {
    key: "palette-shortcut",
    title: "Add a keyboard shortcut for the command palette",
    ageMinutes: 26 * 60,
    spanMinutes: 2,
    turns: [{
      prompt: "Add Cmd+K for the command palette, but don't break Cmd+K in the editor.",
      answer: "The palette shortcut is now registered on the window and skips events whose target is inside the editor, so the editor keeps its own Cmd+K.\n",
    }],
  },
  {
    key: "drafts",
    title: "Чернетки відповідей зникають після перезавантаження сторінки",
    ageMinutes: 30 * 60,
    spanMinutes: 4,
    turns: [{
      prompt: "Чернетка відповіді пропадає, якщо перезавантажити сторінку. Де її зберігати?",
      answer: "Зараз чернетка живе тільки в стані компонента. Пишемо її в `localStorage` з ключем по `conversation.id` і чистимо після відправки.\n",
    }],
  },
  {
    key: "flaky-test",
    title: "Flaky test in conversation-list.spec",
    ageMinutes: 2 * 24 * 60 + 90,
    spanMinutes: 5,
    turns: [{
      prompt: "conversation-list.spec fails about once in ten runs on CI. Can you find out why?",
      answer: "The test formats `updatedAt` relative to the real clock, so a run that crosses a minute boundary renders \"1 minute ago\" instead of \"now\". Passing a fixed `now` into `formatUpdatedAt` makes it deterministic.\n",
    }],
  },
  {
    key: "readme",
    title: "Переписати README для нових контриб'юторів",
    ageMinutes: 3 * 24 * 60 + 200,
    spanMinutes: 3,
    turns: [{
      prompt: "Перепиши README так, щоб новий контриб'ютор за 10 хвилин підняв проєкт локально.",
      answer: "Переписав: спочатку три команди для запуску, потім де лежить API-клієнт і як прогнати тести. Розділ про деплой переніс у `docs/deploy.md`.\n",
    }],
  },
  {
    key: "email-parser",
    title: "Парсер листів ламає кирилицю в темі",
    ageMinutes: 4 * 24 * 60 + 60,
    spanMinutes: 6,
    turns: [{
      prompt: "Теми листів з кирилицею приходять як «ÐŸÑ€Ð¸Ð²Ñ–Ñ‚». Де ламається кодування?",
      answer: "Заголовок `Subject` закодований як `=?UTF-8?B?...?=`, а парсер декодує base64 у `latin1`. Треба декодувати в `utf-8` за кодуванням, вказаним у самому заголовку.\n",
    }],
  },
  {
    key: "diff-contrast",
    title: "Dark mode contrast in the diff viewer",
    ageMinutes: 6 * 24 * 60,
    spanMinutes: 1,
    turns: [{
      prompt: "Removed lines in the diff viewer are almost unreadable in dark mode. What contrast do we have now?",
      answer: "Removed lines are `#f87171` text on `#3f1d1d`, a contrast of 3.1:1. Lightening the text to `#fca5a5` gets 5.2:1 without changing the background.\n",
    }],
  },
  {
    key: "rate-limit",
    title: "Обробка 429 від API пошти",
    ageMinutes: 7 * 24 * 60 + 300,
    spanMinutes: 3,
    turns: [{
      prompt: "API пошти почало відповідати 429. Як правильно чекати?",
      answer: "Беремо затримку з заголовка `Retry-After`, а якщо його нема, використовуємо той самий `backoff`, що й для 503. Повторювати 429 без паузи не можна, інакше ліміт тільки продовжиться.\n",
    }],
  },
  {
    key: "typescript",
    title: "Bump TypeScript to 5.7",
    ageMinutes: 9 * 24 * 60,
    spanMinutes: 6,
    turns: [{
      prompt: "Bump TypeScript to 5.7 and fix whatever breaks.",
      answer: "Bumped. Two errors came up, both from stricter checks on `import.meta.env`; typing `VITE_API_URL` in `env.d.ts` fixed them.\n",
    }],
  },
  {
    key: "attachments",
    title: "Upload attachments larger than 10 MB in chunks",
    ageMinutes: 12 * 24 * 60,
    spanMinutes: 7,
    turns: [{
      prompt: "Attachments over 10 MB time out. Can we upload them in chunks?",
      answer: "Yes: split the file into 5 MB parts, upload them in order with the part number in the URL, and finish with one `complete` call. A failed part is retried on its own.\n",
    }],
  },
  {
    key: "queue-review",
    title: "Огляд PR #412: черга повідомлень",
    ageMinutes: 15 * 24 * 60,
    spanMinutes: 2,
    turns: [{
      prompt: "Подивись PR #412 з чергою повідомлень. Що там може зламатись?",
      answer: "Черга чиститься до того, як сервер підтвердив відправку, тож при обриві зʼєднання повідомлення губиться. Решта виглядає добре.\n",
    }],
  },
]

// The OpenAI protocol sends a message's content as a string or as a list of parts.
const textOf = (content) => (Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : String(content ?? ""))

const TURNS = DESIGN_SESSIONS.flatMap((session) => session.turns.map((turn, index) => ({ ...turn, id: `${session.key}_${index + 1}` })))

/**
 * What the scripted conversation answers to this request, or null when the
 * last user message is not one of its prompts. Tool results since that
 * message say how many tool steps already ran.
 */
export const planScriptedResponse = (messages) => {
  const lastPrompt = messages.findLastIndex((message) => message?.role === "user")
  if (lastPrompt < 0) return null
  const prompt = textOf(messages[lastPrompt].content)
  const turn = TURNS.find((candidate) => prompt.includes(candidate.prompt))
  if (!turn) return null
  const toolResults = messages.slice(lastPrompt + 1).filter((message) => message?.role === "tool").length
  let callsBefore = 0
  for (const [stepIndex, step] of (turn.steps ?? []).entries()) {
    if (toolResults <= callsBefore) {
      return {
        reasoning: step.reasoning,
        text: `${step.text}\n\n`,
        toolCalls: step.calls.map((call, index) => ({ id: `call_${turn.id}_${stepIndex + 1}_${index + 1}`, ...call })),
      }
    }
    callsBefore += step.calls.length
  }
  return { text: turn.answer, toolCalls: [] }
}
