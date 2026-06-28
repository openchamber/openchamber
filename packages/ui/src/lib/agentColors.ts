

const AGENT_COLOR_PALETTE = [
  { var: '--status-success', class: 'agent-success' },
  { var: '--syntax-keyword', class: 'agent-keyword' },
  { var: '--syntax-type', class: 'agent-type' },
  { var: '--syntax-function', class: 'agent-function' },
  { var: '--syntax-number', class: 'agent-number' },
  { var: '--status-info', class: 'agent-info' },
  { var: '--status-warning', class: 'agent-warning' },
  { var: '--syntax-variable', class: 'agent-variable' },
];

export function getAgentColor(agentName: string | undefined) {

  if (!agentName) {
    return AGENT_COLOR_PALETTE[0];
  }

  if (agentName === 'build') {
    return AGENT_COLOR_PALETTE[0];
  }

  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    const char = agentName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const paletteIndex = 1 + (Math.abs(hash) % (AGENT_COLOR_PALETTE.length - 1));
  return AGENT_COLOR_PALETTE[paletteIndex];
}