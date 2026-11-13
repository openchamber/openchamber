import { giteaDescriptor } from '../gitea/descriptor.js';
import { normalizeOriginInstance } from '../source-control/origin-instance.js';

// Forgejo's logo by Caesar Schinas, CC BY-SA 4.0
// (https://creativecommons.org/licenses/by-sa/4.0/), scaled from its 512x512
// box into a 24x24 one with the inset and line weight of the other provider
// marks; this path is under the same license.
const FORGEJO_PATH = 'M15.78 8.62c-0.86 0-1.6 0.47-2 1.17h-1.06c-1.27 0-2.43 0.42-3.38 1.13v-1.62c0-1.86 1.51-3.38 3.38-3.38H13.78c0.39 0.7 1.14 1.17 2 1.17 1.27 0 2.3-1.03 2.3-2.3S17.05 2.5 15.78 2.5c-0.86 0-1.6 0.47-2 1.17h-1.06c-3.11 0-5.63 2.53-5.63 5.63v7.9c-0.7 0.39-1.17 1.14-1.17 2 0 1.27 1.03 2.3 2.3 2.3s2.3-1.03 2.3-2.3c0-0.86-0.48-1.61-1.17-2v-1.78c0-1.86 1.51-3.38 3.38-3.38H13.78c0.39 0.7 1.14 1.17 2 1.17 1.27 0 2.3-1.03 2.3-2.3S17.05 8.62 15.78 8.62'
  + 'm0-4.77c0.52 0 0.95 0.42 0.95 0.95s-0.43 0.95-0.95 0.95c-0.52 0-0.95-0.42-0.95-0.95s0.43-0.95 0.95-0.95'
  + 'M8.22 20.15c-0.52 0-0.95-0.43-0.95-0.95 0-0.52 0.43-0.95 0.95-0.95s0.95 0.43 0.95 0.95c0 0.52-0.43 0.95-0.95 0.95'
  + 'm7.56-8.28c-0.52 0-0.95-0.42-0.95-0.95s0.43-0.95 0.95-0.95c0.52 0 0.95 0.42 0.95 0.95s-0.43 0.95-0.95 0.95';

/**
 * Forgejo's static description: synchronous and dependency-free. Forgejo
 * speaks Gitea's API (`../gitea/`), so everything a person does not see is
 * Gitea's: capabilities, transport, limits and the mutation table. What
 * differs is the name, the mark, the default instance and where a pull
 * request template may live. Codeberg is the public Forgejo instance, so its
 * remotes are recognised before any account is connected; every other
 * instance comes from an account the user connected with a personal access
 * token.
 */
export const forgejoDescriptor = Object.freeze({
  ...giteaDescriptor,
  id: 'forgejo',
  label: 'Forgejo',
  iconId: 'forgejo',
  instance: Object.freeze({
    ...giteaDescriptor.instance,
    defaultInstances: Object.freeze(['https://codeberg.org']),
    normalize: (value) => normalizeOriginInstance(value, { label: 'Forgejo' }),
  }),
  presentation: Object.freeze({
    ...giteaDescriptor.presentation,
    icon: Object.freeze({ path: FORGEJO_PATH }),
    instances: Object.freeze({ ...giteaDescriptor.presentation.instances, placeholder: 'https://forgejo.example.com' }),
    features: Object.freeze({
      ...giteaDescriptor.presentation.features,
      // Forgejo's own lookup order, Markdown only: YAML templates are forms.
      changeRequestTemplates: Object.freeze([
        'PULL_REQUEST_TEMPLATE.md',
        'pull_request_template.md',
        '.forgejo/PULL_REQUEST_TEMPLATE.md',
        '.forgejo/pull_request_template.md',
        '.gitea/PULL_REQUEST_TEMPLATE.md',
        '.gitea/pull_request_template.md',
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/pull_request_template.md',
      ]),
    }),
  }),
});
