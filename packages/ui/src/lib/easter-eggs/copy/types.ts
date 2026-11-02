/**
 * The easter-egg lines of one locale. Each locale writes its own jokes rather
 * than translating the English ones, so lists may differ in length, and an
 * occasion list may be empty where a joke does not work in that language:
 * an empty list falls back to `everyday`.
 */

/** Text with a `{count}`, one entry per plural category the locale uses (`Intl.PluralRules`). */
export type CountedText = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export interface ToastLine {
  title: string;
  description: string;
}

export interface EasterEggCopy {
  /** The new-session heading. Every line contains `{project}`. */
  draftTitle: {
    everyday: readonly string[];
    /** 01:00 to 05:00. */
    deepNight: readonly string[];
    halloween: readonly string[];
    newYearsEve: readonly string[];
    newYearsDay: readonly string[];
  };
  /** The line under "Working tree clean", picked anew each time the panel shows it. */
  gitClean: {
    everyday: readonly string[];
    halloween: readonly string[];
    newYearsEve: readonly string[];
    newYearsDay: readonly string[];
  };
  /** Push toasts, one picked per push. */
  push: {
    /** Empty where Friday evening already is the weekend, so the joke has nothing to land on. */
    fridayEvening: readonly ToastLine[];
    /** Midnight to 05:00. Titles contain `{time}`. */
    smallHours: readonly ToastLine[];
  };
  /**
   * Said in place of "thinking" for about one block of reasoning in four.
   * Each line is a predicate like the agent status phrases: it follows the
   * model's name through `chat.statusRow.modelStatus` ("Opus is mulling it
   * over") and stands alone with a capital first letter.
   */
  thinking: readonly string[];
  /** A commit that removes clearly more lines than it adds. Titles contain `{count}`. */
  netDeletionCommit: readonly { title: CountedText; description: string }[];
}
