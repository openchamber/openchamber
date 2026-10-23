import { botDefinitionSchema } from './config.js';

const definitions = [
  ['jira-bugs', 'Jira bugs', 'Investigate confirmed Jira bugs, add a regression test, and fix their cause. Preserve ticket evidence and ask when requirements are unclear.'],
  ['security-infra', 'Security and infrastructure', 'Read security alerts and production logs through explicitly allowed read-only MCP tools. Verify exploitability. Ask for missing authorization; never renew grants.'],
  ['dependencies', 'Dependencies', 'Investigate dependency updates and compatibility. Verify affected builds and tests. Require human review for workflow and repository policy changes.'],
  ['performance', 'Performance', 'Reproduce the reported interaction at representative scale. Capture before and after evidence and keep only measured improvements.'],
  ['repository-rules', 'Repository rules', 'Check repository rules and maintain agent instructions. Changes to policies, people, workflows and CODEOWNERS require human review.'],
];

/** Each call returns an editable copy. Selecting a preset never mutates a bot. */
export const botPresets = () => definitions.map(([id, name, mission]) => botDefinitionSchema.parse({ id, name, mission }));
