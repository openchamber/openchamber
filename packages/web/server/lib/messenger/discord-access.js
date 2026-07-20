const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;

export const DEFAULT_DISCORD_ALLOW_ROLE = 'OpenChamber';
export const DEFAULT_DISCORD_BLOCK_ROLE = 'no-openchamber';

function normalizeRoleName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function permissionBits(value) {
  if (value == null || value === '') return 0n;
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

export function normalizeTrustedBotIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return Array.from(
    new Set(
      raw
        .map((id) => String(id ?? '').trim())
        .filter(Boolean),
    ),
  );
}

export function normalizeDiscordAccessSettings(settings = {}) {
  return {
    allowRoleName:
      typeof settings.allowRoleName === 'string' && settings.allowRoleName.trim()
        ? settings.allowRoleName.trim()
        : DEFAULT_DISCORD_ALLOW_ROLE,
    blockRoleName:
      typeof settings.blockRoleName === 'string' && settings.blockRoleName.trim()
        ? settings.blockRoleName.trim()
        : DEFAULT_DISCORD_BLOCK_ROLE,
    trustedBotIds: normalizeTrustedBotIds(settings.trustedBotIds),
  };
}

export function evaluateDiscordAccess({
  userId,
  isBot = false,
  guildId = null,
  guildOwnerId = null,
  permissions = null,
  roleNames = [],
  allowRoleName = DEFAULT_DISCORD_ALLOW_ROLE,
  blockRoleName = DEFAULT_DISCORD_BLOCK_ROLE,
  trustedBotIds = [],
} = {}) {
  const normalizedRoles = new Set((roleNames ?? []).map(normalizeRoleName).filter(Boolean));
  const allowRole = normalizeRoleName(allowRoleName);
  const blockRole = normalizeRoleName(blockRoleName);
  const id = userId == null ? '' : String(userId);

  if (blockRole && normalizedRoles.has(blockRole)) {
    return { allowed: false, reason: 'blocked-role' };
  }

  if (isBot && id && normalizeTrustedBotIds(trustedBotIds).includes(id)) {
    return { allowed: true, reason: 'trusted-bot' };
  }

  if (!guildId) {
    return { allowed: false, reason: 'no-guild' };
  }

  if (id && guildOwnerId && id === String(guildOwnerId)) {
    return { allowed: true, reason: 'guild-owner' };
  }

  const bits = permissionBits(permissions);
  if ((bits & ADMINISTRATOR_PERMISSION) !== 0n) {
    return { allowed: true, reason: 'administrator' };
  }
  if ((bits & MANAGE_GUILD_PERMISSION) !== 0n) {
    return { allowed: true, reason: 'manage-guild' };
  }

  if (allowRole && normalizedRoles.has(allowRole)) {
    return { allowed: true, reason: isBot ? 'bot-allow-role' : 'allow-role' };
  }

  return { allowed: false, reason: isBot ? 'bot-not-trusted' : 'not-privileged' };
}
