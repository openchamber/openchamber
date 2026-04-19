import Prism from 'prismjs';

type PrismLoader = () => Promise<unknown>;

const prismLanguageAliases: Record<string, string> = {
  text: 'plain',
  plaintext: 'plain',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  patch: 'diff',
  dockerfile: 'docker',
  js: 'javascript',
  ts: 'typescript',
};

const prismLanguageLoaders = new Map<string, PrismLoader>([
  ['markup', () => import('prismjs/components/prism-markup')],
  ['markup-templating', () => import('prismjs/components/prism-markup-templating')],
  ['javascript', () => import('prismjs/components/prism-javascript')],
  ['typescript', () => import('prismjs/components/prism-typescript')],
  ['jsx', () => import('prismjs/components/prism-jsx')],
  ['tsx', () => import('prismjs/components/prism-tsx')],
  ['css', () => import('prismjs/components/prism-css')],
  ['json', () => import('prismjs/components/prism-json')],
  ['bash', () => import('prismjs/components/prism-bash')],
  ['python', () => import('prismjs/components/prism-python')],
  ['rust', () => import('prismjs/components/prism-rust')],
  ['go', () => import('prismjs/components/prism-go')],
  ['java', () => import('prismjs/components/prism-java')],
  ['c', () => import('prismjs/components/prism-c')],
  ['cpp', () => import('prismjs/components/prism-cpp')],
  ['csharp', () => import('prismjs/components/prism-csharp')],
  ['ruby', () => import('prismjs/components/prism-ruby')],
  ['yaml', () => import('prismjs/components/prism-yaml')],
  ['toml', () => import('prismjs/components/prism-toml')],
  ['markdown', () => import('prismjs/components/prism-markdown')],
  ['sql', () => import('prismjs/components/prism-sql')],
  ['diff', () => import('prismjs/components/prism-diff')],
  ['docker', () => import('prismjs/components/prism-docker')],
  ['swift', () => import('prismjs/components/prism-swift')],
  ['kotlin', () => import('prismjs/components/prism-kotlin')],
  ['lua', () => import('prismjs/components/prism-lua')],
  ['php', async () => {
    await ensurePrismLanguageLoaded('markup-templating');
    return import('prismjs/components/prism-php');
  }],
  ['scss', () => import('prismjs/components/prism-scss')],
]);

const prismLanguagePromises = new Map<string, Promise<void>>();

export function normalizePrismLanguage(language: string): string {
  const lower = language.toLowerCase();
  return prismLanguageAliases[lower] ?? lower;
}

export async function ensurePrismLanguageLoaded(language: string): Promise<void> {
  const normalizedLanguage = normalizePrismLanguage(language);
  if (normalizedLanguage === 'plain' || normalizedLanguage === 'text') {
    return;
  }

  if (Prism.languages[normalizedLanguage]) {
    return;
  }

  let promise = prismLanguagePromises.get(normalizedLanguage);
  if (!promise) {
    const loader = prismLanguageLoaders.get(normalizedLanguage);
    if (!loader) {
      return;
    }

    promise = loader().then(() => undefined).catch(() => undefined);
    prismLanguagePromises.set(normalizedLanguage, promise);
  }

  await promise;
}
