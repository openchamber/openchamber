import type { AttachIssueRequest } from '@openchamber/sdk';

/**
 * The context text a guest chip sends to the model when the extension gave
 * none. A chip from a recognised chat link has only its identifier as title,
 * so the title is left out instead of repeating the identifier.
 */
export const guestAttachContextText = (issue: AttachIssueRequest): string => issue.text
  ?? `Attached ${issue.providerId} ${issue.id}${issue.title === issue.id ? '' : `: ${issue.title}`}\n${issue.url}`;
