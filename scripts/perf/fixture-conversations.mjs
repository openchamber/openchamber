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
export const fixtureMessageText = (content) => (Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : String(content ?? ""))

// Turns behavior scenarios (scripts/verify) send that no design shot shows.
// The workflow's agents answer slowly so a scenario sees the run while it works.
const VERIFY_WORKFLOW_SCRIPT = [
  "export const meta = { name: 'api-exports', description: 'Lists what each API file exports', phases: ['Read'] }",
  "phase('Read')",
  "return parallel(['src/api/retry.ts', 'src/api/client.ts'].map((file) => () => agent('List what ' + file + ' exports.', { label: file, model: 'perf/stream-100cps' })))",
].join("\n")

/**
 * Turns the behavior scenarios (`scripts/verify`) play that no design shot
 * shows. `OPERATOR_PROMPT` makes the agent start a worker session as part of
 * its own work (`session.create` with `ownWork`) on a model that thinks for
 * thirty seconds, so the worker is still running while the scenario looks.
 */
export const OPERATOR_PROMPT = "Start a worker session of your own for the parser fix."
export const OPERATOR_WORKTREE_PROMPT = "Start a worker of your own in a new worktree for the lexer fix."
export const OPERATOR_TAKEOVER_PROMPT = "Start a worker of your own in a new worktree that I may take over."
export const OPERATOR_PHONE_PROMPT = "Start a worker of your own in a new worktree that I may take over on my phone."
const operatorWorktreeCode = (title, worktree) => [
  `return await tools.openchamber({ action: 'session.create', parameters: { title: '${title}', prompt: 'Fix it.', model: 'perf/think-30s', ownWork: true, worktree: '${worktree}' } })`,
].join("\n")

const operatorWorktreeTurn = (id, prompt, title, worktree) => ({
  id,
  prompt,
  steps: [{ text: "Starting a worker in its own worktree.", calls: [{ name: "execute", arguments: { code: operatorWorktreeCode(title, worktree) } }] }],
  answer: "The worker runs in its own worktree.\n",
})

/**
 * `SUBAGENT_PROMPT` starts a subagent that thinks for thirty seconds, so its
 * session is still running while a scenario looks at it.
 * `SUBAGENT_PERMISSION_PROMPT` starts a subagent that reads `notes.secret`,
 * which the verify stand asks permission for, so the subagent's read-only
 * session asks for a permission.
 * `QUESTION_PROMPT` asks the user a question and answers after it.
 * `verify_locales` changes more files than the turn footer shows as chips.
 */
export const SUBAGENT_PROMPT = "Hand the parser review to a subagent."
export const SUBAGENT_PERMISSION_PROMPT = "Hand the secret notes to a subagent."
const SECRET_NOTES_PROMPT = "Read the secret notes"
export const QUESTION_PROMPT = "Ask me which retry policy to use."
const subagentTurn = (id, prompt, task, model) => ({
  id,
  prompt,
  steps: [{
    text: "Handing it to a subagent.",
    calls: [{ name: "subagent", arguments: { agent: "general", description: task, prompt: `${task}.`, model } }],
  }],
  answer: "The subagent is on it.\n",
})

const LOCALES = ["de", "fr", "pl", "uk", "ja"]

const VERIFY_TURNS = [
{
  id: "verify_locales",
  prompt: "Add a locale file for each language we ship.",
  steps: [{
    text: "Writing one file per locale:",
    calls: LOCALES.map((locale) => ({ name: "write", arguments: { path: `src/locales/${locale}.json`, content: `${JSON.stringify({ locale, inbox: "Inbox" }, null, 2)}\n` } })),
  }],
  answer: `Added ${LOCALES.length} locale files under \`src/locales\`, each with the inbox title.\n`,
},
  subagentTurn("verify_subagent", SUBAGENT_PROMPT, "Review the parser", "perf/think-30s"),
  subagentTurn("verify_subagent_permission", SUBAGENT_PERMISSION_PROMPT, SECRET_NOTES_PROMPT, "perf/stream-20000cps"),
{
  id: "verify_secret_notes",
  prompt: SECRET_NOTES_PROMPT,
  steps: [{ text: "Reading them.", calls: [{ name: "read", arguments: { path: "notes.secret" } }] }],
  answer: "The secret notes hold one line.\n",
},
{
  id: "verify_question",
  prompt: QUESTION_PROMPT,
  steps: [{
    text: "One thing to settle first.",
    calls: [{
      name: "question",
      arguments: {
        questions: [{
          question: "Which retry policy should withRetry use?",
          header: "Retry policy",
          options: [
            { label: "Exponential backoff", description: "Double the wait after each failure." },
            { label: "Fixed delay", description: "Wait the same time before every retry." },
          ],
        }],
      },
    }],
  }],
  answer: "Going with the policy you picked.\n",
}, {
  id: "verify_workflow",
  prompt: "Run the workflow we agreed on over the API files.",
  steps: [{
    text: "Starting the workflow we agreed on.",
    calls: [{ name: "openchamber_workflow", arguments: { action: "workflow.run", parameters: { script: VERIFY_WORKFLOW_SCRIPT } } }],
  }],
  answer: "The workflow card is in the chat; its report comes back here when the run ends.\n",
}, {
  id: "operator_1",
  prompt: OPERATOR_PROMPT,
  steps: [{
    text: "Starting a worker for it.",
    calls: [{
      name: "execute",
      arguments: { code: "return await tools.openchamber({ action: 'session.create', parameters: { title: 'Parser worker', prompt: 'Fix the parser.', model: 'perf/think-30s', ownWork: true } })" },
    }],
  }],
  answer: "The worker is running; its answer comes back here when it finishes.\n",
},
  operatorWorktreeTurn("operator_worktree_1", OPERATOR_WORKTREE_PROMPT, "Lexer worker", "lexer-fix"),
  operatorWorktreeTurn("operator_takeover_1", OPERATOR_TAKEOVER_PROMPT, "Takeover worker", "takeover-fix"),
  operatorWorktreeTurn("operator_phone_1", OPERATOR_PHONE_PROMPT, "Phone worker", "phone-fix"),
  // Tool rows of the chat (scripts/verify/zones/chat.json, feature `tools`):
  // one turn per kind of row, each with output a scenario can name.
  {
    id: "tools_shell",
    prompt: "Print the verify banner in the shell.",
    steps: [{ text: "Printing it.", calls: [{ name: "shell", arguments: { command: "echo verify-banner-$((6 * 7)); echo verify-second-$((7 * 8))" } }] }],
    answer: "The banner is printed.\n",
  },
  {
    id: "tools_shell_long",
    prompt: "Run the long verify watcher in the shell.",
    steps: [{ text: "Starting the watcher.", calls: [{ name: "shell", arguments: { command: "echo verify-watcher-$((3 * 4)); sleep 120; echo verify-watcher-done" } }] }],
    answer: "The watcher ended.\n",
  },
  {
    id: "tools_shell_background",
    prompt: "Run the verify watcher in the background.",
    steps: [{ text: "Starting it in the background.", calls: [{ name: "shell", arguments: { command: "echo verify-background-$((5 * 5)); sleep 120", background: true } }] }],
    answer: "The watcher runs in the background.\n",
  },
  {
    id: "tools_write",
    prompt: "Write the verify notes file.",
    steps: [{ text: "Writing it.", calls: [{ name: "write", arguments: { path: "notes/verify-notes.md", content: "# Verify notes\n\nfirst-note-line\nsecond-note-line\n" } }] }],
    answer: "The notes file is written.\n",
  },
  {
    id: "tools_todo",
    prompt: "Plan the verify work as a task list.",
    steps: [{
      text: "Planning it.",
      calls: [{
        name: "todowrite",
        arguments: { todos: [
          { content: "Reproduce the verify failure", status: "completed" },
          { content: "Patch the verify retry", status: "in_progress" },
          { content: "Rerun the verify suite", status: "pending" },
        ] },
      }],
    }],
    answer: "The list is set.\n",
  },
  {
    id: "tools_failure",
    prompt: "Edit the verify marker that is not in retry.ts.",
    steps: [{ text: "Editing it.", calls: [{ name: "edit", arguments: { path: "src/api/retry.ts", oldString: "verify-marker-not-present", newString: "verify-marker-replaced" } }] }],
    answer: "The marker is not there.\n",
  },
  {
    id: "tools_json",
    prompt: "Return the verify owners as JSON.",
    steps: [{ text: "Collecting them.", calls: [{ name: "execute", arguments: { code: "const owners = ['alpha', 'beta'].map((name, index) => ({ id: 'owner-' + name.toUpperCase(), revision: index + 3 })); return { owners, total: owners.length }" } }] }],
    answer: "Two owners.\n",
  },
  {
    id: "tools_subagent",
    prompt: "Ask a subagent about the TypeScript bump.",
    steps: [{
      text: "Asking a subagent.",
      calls: [{ name: "subagent", arguments: { agent: "general", description: "Verify TypeScript bump", prompt: "Bump TypeScript to 5.7 and fix whatever breaks." } }],
    }],
    answer: "The subagent answered.\n",
  },
  {
    id: "tools_subagent_slow",
    prompt: "Ask a slow subagent about the parser.",
    steps: [{
      text: "Asking a subagent that takes its time.",
      calls: [{ name: "subagent", arguments: { agent: "general", description: "Verify slow parser", prompt: "Look at the parser.", model: "perf/think-30s" } }],
    }],
    answer: "The slow subagent is on it.\n",
  },
  {
    // OpenCode offers `patch` instead of `edit` and `write` only to GPT models: send it to `perf/gpt-5-scripted`.
    id: "tools_patch",
    prompt: "Add the two verify patch notes.",
    steps: [{
      text: "Adding both in one patch.",
      calls: [{ name: "patch", arguments: { patchText: "*** Begin Patch\n*** Add File: notes/patch-one.md\n+patch-one-line\n*** Add File: notes/patch-two.md\n+patch-two-line\n*** End Patch" } }],
    }],
    answer: "Both notes are added.\n",
  },
  {
    id: "tools_script_calls",
    prompt: "List the verify worktrees twice in one script.",
    steps: [{ text: "Listing twice.", calls: [{ name: "execute", arguments: { code: "const first = await tools.opencode.worktree_list(); const second = await tools.opencode.worktree_list(); return { lists: [first, second].length }" } }] }],
    answer: "Listed twice.\n",
  },
  {
    id: "tools_script_long",
    prompt: "Print the long verify report from a script.",
    steps: [{ text: "Printing it.", calls: [{ name: "execute", arguments: { code: "return Array.from({ length: 6000 }, (_, index) => 'verify report line ' + index).join('\\n')" } }] }],
    answer: "The report is long.\n",
  },
  {
    id: "tools_openchamber_failure",
    prompt: "Delete the verify note that does not exist.",
    steps: [{ text: "Deleting it.", calls: [{ name: "execute", arguments: { code: "return await tools.openchamber_knowledge({ action: 'knowledge.delete', parameters: { kind: 'note', id: 'verify-missing-note' } })" } }] }],
    answer: "There was no such note.\n",
  },
  {
    // The subagent's report comes back to the parent as a new message.
    id: "tools_subagent_report",
    prompt: "Verify TypeScript bump",
    answer: "Noted the subagent's report.\n",
  },
  {
    id: "tools_question",
    prompt: "Ask me which verify mode to use.",
    steps: [{
      text: "Asking.",
      calls: [{
        name: "question",
        arguments: { questions: [{
          question: "Which verify mode should run?",
          header: "Verify mode",
          options: [{ label: "Quick verify", description: "Only the changed zone" }, { label: "Full verify", description: "Every zone" }],
        }] },
      }],
    }],
    answer: "Running that mode.\n",
  },
  {
    id: "tools_opencode_call",
    prompt: "List the verify worktrees.",
    steps: [{ text: "Listing them.", calls: [{ name: "execute", arguments: { code: "return await tools.opencode.worktree_list()" } }] }],
    answer: "Those are the worktrees.\n",
  },
  {
    id: "tools_openchamber_call",
    prompt: "Save the verify note to the project knowledge.",
    steps: [{ text: "Saving it.", calls: [{ name: "execute", arguments: { code: "return await tools.openchamber_knowledge({ action: 'knowledge.save', parameters: { kind: 'note', body: 'The verify runner answers from a fixture model.' } })" } }] }],
    answer: "Saved.\n",
  },
  // A fetch waits on the user's permission (the verify stand asks before
  // every fetch); a question waits on their answer.
  {
    id: "verify_permission",
    prompt: "Fetch the release checklist from the wiki and follow it.",
    steps: [{ text: "Fetching the checklist.", calls: [{ name: "webfetch", arguments: { url: "https://wiki.example.com/release-checklist", format: "text" } }] }],
    answer: "Followed the checklist.\n",
  },
  {
    id: "verify_branch_question",
    prompt: "Ask me which branch to base the release on before you start.",
    steps: [{
      text: "Asking which branch to use.",
      calls: [{
        name: "question",
        arguments: { questions: [{ question: "Which branch should the release start from?", header: "Branch", options: [{ label: "main", description: "The default branch" }, { label: "next", description: "The upcoming release" }] }] },
      }],
    }],
    answer: "Starting the release from the branch you picked.\n",
  },
  // A page the agent shows waits on the user's answer.
  {
    id: "verify_waiting_page",
    prompt: "Show me a page to pick the release day.",
    steps: [{
      text: "Showing the page.",
      calls: [{
        name: "openchamber_render",
        arguments: { action: "render.page", parameters: { title: "Release day", awaitAnswer: true, html: "<p>Which day should the release go out?</p><button class=\"oc-button\" onclick=\"openchamber.submit({ day: 'friday' }, 'Friday')\">Friday</button>" } },
      }],
    }],
    answer: "Releasing on the day you picked.\n",
  },
]

const TURNS = [
  ...DESIGN_SESSIONS.flatMap((session) => session.turns.map((turn, index) => ({ ...turn, id: `${session.key}_${index + 1}` }))),
  ...VERIFY_TURNS,
]

/**
 * What the scripted conversation answers to this request, or null when the
 * last user message is not one of its prompts. Tool results since that
 * message say how many tool steps already ran.
 */
export const planScriptedResponse = (messages) => {
  const lastPrompt = messages.findLastIndex((message) => message?.role === "user")
  if (lastPrompt < 0) return null
  const prompt = fixtureMessageText(messages[lastPrompt].content)
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
