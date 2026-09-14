import { z } from 'zod';

const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'terminal', 'shell_command']);

/**
 * Tools that speak to a Git host or write Git transport configuration. A shell
 * command that runs one of these leaves the repository binding, the planned
 * network operations and the credential broker out of the loop.
 */
const GIT_TOOLS = new Set(['git', 'gh', 'glab', 'hub']);

/** `git` subcommands that only read the local repository. */
const LOCAL_READ_SUBCOMMANDS = new Set([
    'blame', 'cat-file', 'check-ignore', 'describe', 'diff', 'log', 'ls-files', 'ls-tree',
    'merge-base', 'name-rev', 'rev-list', 'rev-parse', 'shortlog', 'show', 'status',
    'symbolic-ref', 'var', 'version',
]);

/** `git` subcommands whose listing form only reads, but which can also write. */
const LISTABLE_SUBCOMMANDS = new Set(['branch', 'remote', 'stash', 'tag', 'worktree']);
const LISTING_ARGUMENTS = new Set(['-v', '--verbose', '-l', '--list', 'list', 'show']);

/** `git` options that take a separate value, so the value is not the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const SEGMENT_SEPARATOR = /\|\||&&|[;|\n]/;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type ShellOperationInitiator = 'agent' | 'user';

export type ShellOperationBoundary = {
    initiator: ShellOperationInitiator;
    verification: 'unverified';
    boundary: 'outside-managed-boundary';
};

/** Drops leading environment assignments and shell grouping punctuation. */
const commandTokens = (segment: string): string[] => segment
    .replace(/[(){}]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token, index, tokens) => index >= tokens.findIndex((entry) => !ENVIRONMENT_ASSIGNMENT.test(entry)));

const gitSubcommand = (tokens: string[]): { subcommand: string; rest: string[] } | null => {
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index].includes('=') ? tokens[index].split('=')[0] : tokens[index];
        index += GIT_OPTIONS_WITH_VALUE.has(option) && !tokens[index].includes('=') ? 2 : 1;
    }
    const subcommand = tokens[index];
    return subcommand ? { subcommand: subcommand.toLowerCase(), rest: tokens.slice(index + 1) } : null;
};

/**
 * Whether one command in a shell string can reach the managed Git boundary.
 *
 * Unrecognized input counts as reaching it. A missed warning is worse than an
 * extra one, so only positively identified local reads are cleared.
 */
const segmentCrossesBoundary = (segment: string): boolean => {
    const tokens = commandTokens(segment);
    if (tokens.length === 0) return false;

    const tool = tokens[0].split('/').pop()?.toLowerCase() ?? '';
    if (!GIT_TOOLS.has(tool)) return false;
    // The provider CLIs exist to talk to the host, so every invocation counts.
    if (tool !== 'git') return true;

    const parsed = gitSubcommand(tokens);
    if (!parsed) return false;
    if (LOCAL_READ_SUBCOMMANDS.has(parsed.subcommand)) return false;
    if (LISTABLE_SUBCOMMANDS.has(parsed.subcommand)) {
        return !parsed.rest.every((argument) => LISTING_ARGUMENTS.has(argument));
    }
    return true;
};

/** Reads a shell command out of a tool input payload at its I/O boundary. */
export const shellCommandInputSchema = z.object({ command: z.string().min(1) }).partial();

/**
 * Marks a shell tool call that steps outside OpenChamber's managed Git model.
 *
 * `command` is the shell string the tool was given, or null when the payload
 * carried none this could read. Null keeps the warning: it must not go quiet
 * on input it does not understand.
 */
export const getShellOperationBoundary = (
    toolName: string,
    initiator: ShellOperationInitiator,
    command: string | null = null,
): ShellOperationBoundary | null => {
    if (!SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase())) return null;

    if (command !== null && !command.split(SEGMENT_SEPARATOR).some(segmentCrossesBoundary)) {
        return null;
    }

    return {
        initiator,
        verification: 'unverified',
        boundary: 'outside-managed-boundary',
    };
};
