import {
  SECRET_REQUEST_MAX_LABEL_LENGTH,
  SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH,
  SECRET_REQUEST_MAX_REASON_LENGTH,
} from '../openchamber-control/secret-request.js';
import {
  SECRET_RUN_DEFAULT_TIMEOUT_MS,
  SECRET_RUN_MAX_INPUTS,
  SECRET_RUN_MAX_LABEL_LENGTH,
  SECRET_RUN_MAX_PLACEHOLDER_LENGTH,
  SECRET_RUN_MAX_TIMEOUT_MS,
} from '../openchamber-control/secret-run.js';

export const SECRET_PARAMETER_PROPERTIES = {
  program: { type: 'string', description: 'secret.run: the executable, by name on PATH or absolute path. No shell: for a script use "sh" (or "bash") with args ["-c", "<script>"]' },
  args: { type: 'array', items: { type: 'string' }, description: 'secret.run: arguments, without secrets' },
  inputs: {
    type: 'array',
    minItems: 1,
    maxItems: SECRET_RUN_MAX_INPUTS,
    description: 'secret.run: one field per secret, which the command reads from the named environment variable',
    items: {
      type: 'object',
      properties: {
        env: { type: 'string', description: 'Environment variable name, such as CLOUDFLARE_API_TOKEN' },
        label: { type: 'string', description: `What the secret is, shown above its field, in the user's language. At most ${SECRET_RUN_MAX_LABEL_LENGTH} characters` },
        placeholder: { type: 'string', description: `The value's shape, such as sk-ant-...; at most ${SECRET_RUN_MAX_PLACEHOLDER_LENGTH} characters` },
      },
      required: ['env', 'label'],
      additionalProperties: false,
    },
  },
  timeoutMs: { type: 'integer', minimum: 1, maximum: SECRET_RUN_MAX_TIMEOUT_MS, description: `secret.run: how long the command may run once the user answered, default ${SECRET_RUN_DEFAULT_TIMEOUT_MS}` },
  saved: { type: 'boolean', description: 'secret.forget: true also asks the user, on a card, to forget the saved secrets, this project\'s and those for all projects. Only when the user asks' },
  label: { type: 'string', description: `secret.request: what the secret is, the card's title, such as Cloudflare API token. At most ${SECRET_REQUEST_MAX_LABEL_LENGTH} characters` },
  reason: { type: 'string', description: `In the user's language: what you will do with the secrets, and where to create them when that is not obvious. At most ${SECRET_REQUEST_MAX_REASON_LENGTH} characters` },
  placeholder: { type: 'string', description: `secret.request: the value's shape, such as sk-ant-...; at most ${SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH} characters` },
};

export const SECRET_TOOL_DESCRIPTION = "Ask the user for secrets (API keys, tokens, passwords, one-time codes) on a private card in the chat, and wait for them. "
  + "secret.run is the default: name the command and the environment variables it reads the secrets from. After the user approves the command line and fills the card, it runs once in this session's directory with the secrets in its environment, and the call returns its exit code and output with every secret value replaced by [secret:NAME]. It runs without a shell or input; a command that fails can be fixed and run again. "
  + "On the card the user can let this chat remember a field for 10 minutes; the result's remembered lists those env names, and a new secret.run with the same env name uses it without asking. secret.forget drops them when the user asks or the work is done. "
  + "The user can also save a field for the project or for all projects; the result's saved lists those env names, and a later secret.run shows them on the card for the user to confirm with one click. secret.forget with saved: true asks the user on a card to forget them too, only when the user asks. "
  + "secret.request is for a secret a program must read from a file (a key file, a kubeconfig): the value goes to a file only this user can read, deleted after 24 hours, and the call returns only its path. Read it inside the command that needs it; never print, echo or log it, and never copy it into the project. "
  + "The call returns status declined when the user declines, or answered: false when they wrote in the chat instead.";
