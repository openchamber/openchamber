import { CronExpressionParser } from 'cron-parser';

export type CronValidationResult = {
  valid: boolean;
  error?: string;
};

export function isValidCronExpression(expression: string): CronValidationResult {
  if (!expression || !expression.trim()) {
    return { valid: false, error: 'required' };
  }
  try {
    CronExpressionParser.parse(expression);
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid cron expression';
    return { valid: false, error: message };
  }
}

export function getNextRuns(
  expression: string,
  timezone: string,
  count: number = 4,
): Date[] {
  try {
    const options = timezone ? { tz: timezone, currentDate: new Date() } : { currentDate: new Date() };
    const interval = CronExpressionParser.parse(expression, options);
    const dates: Date[] = [];
    for (let i = 0; i < count; i += 1) {
      const next = interval.next();
      if (next) {
        dates.push(next.toDate());
      }
    }
    return dates;
  } catch {
    return [];
  }
}

export const CRON_EXAMPLES: ReadonlyArray<{
  expression: string;
  labelKey: string;
}> = [
  { expression: '*/5 * * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.every5min' },
  { expression: '0 * * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.everyHour' },
  { expression: '0 9 * * 1', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.monday9am' },
  { expression: '0 9,17 * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.9am5pm' },
  { expression: '0 0 1 * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.firstOfMonth' },
];
