/**
 * Reports that read as a completion notice rather than a row of their own.
 *
 * `classifySubagentReports` (see `@/lib/opencode/subagent-run`) decides which
 * loaded records these are, keyed by message id. The decision depends on the
 * whole timeline — whether a call in it already shows the run — so it is made
 * once in `ChatContainer` and handed to the notice row through this context
 * instead of being re-derived per row.
 */

import React from 'react';

import type { SubagentCallInfo } from '@/lib/opencode/subagent-run';

const SubagentReportNoticesContext = React.createContext<ReadonlyMap<string, SubagentCallInfo> | undefined>(undefined);

export const SubagentReportNoticesProvider = SubagentReportNoticesContext.Provider;

/** What the notice shows of the call that started the run, or undefined when the report is its own row. */
export const useSubagentReportNotice = (messageID: string): SubagentCallInfo | undefined => (
    React.useContext(SubagentReportNoticesContext)?.get(messageID)
);
