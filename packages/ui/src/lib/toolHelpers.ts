export interface ToolMetadata {
  displayName: string;
  icon?: string;
  outputLanguage?: string;
  inputFields?: {
    key: string;
    label: string;
    type: 'command' | 'file' | 'pattern' | 'text' | 'code';
    language?: string;
  }[];
  category: 'file' | 'search' | 'code' | 'system' | 'ai' | 'web';
}

export const TOOL_METADATA: Record<string, ToolMetadata> = {

  read: {
    displayName: 'Read File',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'filePath', label: 'File Path', type: 'file' },
      { key: 'offset', label: 'Start Line', type: 'text' },
      { key: 'limit', label: 'Lines to Read', type: 'text' }
    ]
  },
  write: {
    displayName: 'Write File',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'filePath', label: 'File Path', type: 'file' },
      { key: 'content', label: 'Content', type: 'code' }
    ]
  },
  edit: {
    displayName: 'Edit File',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'filePath', label: 'File Path', type: 'file' },
      { key: 'oldString', label: 'Find', type: 'code' },
      { key: 'newString', label: 'Replace', type: 'code' },
      { key: 'replaceAll', label: 'Replace All', type: 'text' }
    ]
  },
  multiedit: {
    displayName: 'Multi-Edit',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'filePath', label: 'File Path', type: 'file' },
      { key: 'edits', label: 'Edits', type: 'code', language: 'json' }
    ]
  },
  apply_patch: {
    displayName: 'Apply Patch',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'patchText', label: 'Patch', type: 'code', language: 'diff' }
    ]
  },

  bash: {
    displayName: 'Shell Command',
    category: 'system',
    outputLanguage: 'text',
    inputFields: [
      { key: 'command', label: 'Command', type: 'command', language: 'bash' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'text' }
    ]
  },

  grep: {
    displayName: 'Search Files',
    category: 'search',
    outputLanguage: 'text',
    inputFields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern' },
      { key: 'path', label: 'Directory', type: 'file' },
      { key: 'include', label: 'Include Pattern', type: 'pattern' }
    ]
  },
  glob: {
    displayName: 'Find Files',
    category: 'search',
    outputLanguage: 'text',
    inputFields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern' },
      { key: 'path', label: 'Directory', type: 'file' }
    ]
  },
  list: {
    displayName: 'List Directory',
    category: 'file',
    outputLanguage: 'text',
    inputFields: [
      { key: 'path', label: 'Directory', type: 'file' },
      { key: 'ignore', label: 'Ignore Patterns', type: 'pattern' }
    ]
  },

  task: {
    displayName: 'Agent Task',
    category: 'ai',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'description', label: 'Task', type: 'text' },
      { key: 'prompt', label: 'Instructions', type: 'text' },
      { key: 'subagent_type', label: 'Agent Type', type: 'text' }
    ]
  },

  webfetch: {
    displayName: 'Fetch URL',
    category: 'web',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'url', label: 'URL', type: 'text' },
      { key: 'format', label: 'Format', type: 'text' },
      { key: 'timeout', label: 'Timeout', type: 'text' }
    ]
  },

   websearch: {
     displayName: 'Web Search',
     category: 'web',
     outputLanguage: 'markdown',
     inputFields: [
       { key: 'query', label: 'Search Query', type: 'text' },
       { key: 'numResults', label: 'Results Count', type: 'text' },
       { key: 'type', label: 'Search Type', type: 'text' }
     ]
   },
   codesearch: {
     displayName: 'Code Search',
     category: 'web',
     outputLanguage: 'markdown',
     inputFields: [
       { key: 'query', label: 'Search Query', type: 'text' },
       { key: 'tokensNum', label: 'Tokens', type: 'text' }
     ]
   },

   todowrite: {
     displayName: 'Update Todo List',
     category: 'system',
     outputLanguage: 'json',
     inputFields: [
       { key: 'todos', label: 'Todo Items', type: 'code', language: 'json' }
     ]
   },
   todoread: {
     displayName: 'Read Todo List',
     category: 'system',
     outputLanguage: 'json',
     inputFields: []
   },
   skill: {
     displayName: 'Load Skill',
     category: 'ai',
     outputLanguage: 'markdown',
     inputFields: [
       { key: 'name', label: 'Skill Name', type: 'text' }
     ]
   },
   question: {
      displayName: 'Question',
      category: 'ai',
      outputLanguage: 'text',
      inputFields: [
        { key: 'questions', label: 'Questions', type: 'code', language: 'json' }
      ]
    },

    plan_enter: {
      displayName: 'Plan Mode',
      category: 'ai',
      outputLanguage: 'text',
      inputFields: []
    },

    plan_exit: {
      displayName: 'Build Mode',
      category: 'ai',
      outputLanguage: 'text',
      inputFields: []
    },

    StructuredOutput: {
      displayName: 'Structured Output',
      category: 'ai',
      outputLanguage: 'json',
      inputFields: []
    },

    structuredoutput: {
      displayName: 'Structured Output',
      category: 'ai',
      outputLanguage: 'json',
      inputFields: []
    }
  };

export function getToolMetadata(toolName: string): ToolMetadata {
  return TOOL_METADATA[toolName] || {
    displayName: toolName.charAt(0).toUpperCase() + toolName.slice(1).replace(/-/g, ' '),
    category: 'system',
    outputLanguage: 'text',
    inputFields: []
  };
}

export function detectToolOutputLanguage(
  toolName: string,
  output: string,
  input?: Record<string, unknown>
): string {
  const metadata = getToolMetadata(toolName);

  if (metadata.outputLanguage === 'auto') {

    if (input?.filePath || input?.file_path || input?.sourcePath) {
      const filePath = (input.filePath || input.file_path || input.sourcePath) as string;
      const language = getLanguageFromExtension(filePath);
      if (language) return language;
    }

    if (toolName === 'webfetch') {
      if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
        try {
          JSON.parse(output);
          return 'json';
        } catch { /* ignored */ }
      }
      if (output.trim().startsWith('<')) {
        return 'html';
      }
      if (output.includes('```')) {
        return 'markdown';
      }
    }

    return 'text';
  }

  return metadata.outputLanguage || 'text';
}

export function getLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  // Handle special filenames without extensions
  const filename = filePath.split('/').pop()?.toLowerCase() || '';
  const filenameMap: Record<string, string> = {
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'gnumakefile': 'makefile',
    'cmakelists.txt': 'cmake',
    'gemfile': 'ruby',
    'rakefile': 'ruby',
    'podfile': 'ruby',
    'vagrantfile': 'ruby',
    'guardfile': 'ruby',
    'brewfile': 'ruby',
    'fastfile': 'ruby',
    'appfile': 'ruby',
    'matchfile': 'ruby',
    'pluginfile': 'ruby',
    'scanfile': 'ruby',
    'snapfile': 'ruby',
    '.gitignore': 'text',
    '.gitattributes': 'text',
    '.gitmodules': 'ini',
    '.editorconfig': 'ini',
    '.npmrc': 'ini',
    '.yarnrc': 'yaml',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
    '.browserslistrc': 'text',
    'tsconfig.json': 'jsonc',
    'jsconfig.json': 'jsonc',
    '.env': 'bash',
    '.env.local': 'bash',
    '.env.development': 'bash',
    '.env.production': 'bash',
    '.env.test': 'bash',
    'procfile': 'yaml',
    'codeowners': 'text',
    // Lock files
    'package-lock.json': 'json',
    'composer.lock': 'json',
    'yarn.lock': 'yaml',
    'pnpm-lock.yaml': 'yaml',
    'cargo.lock': 'toml',
    'poetry.lock': 'toml',
    'gemfile.lock': 'ruby',
    'pubspec.lock': 'yaml',
    'packages.lock.json': 'json',
    'bun.lockb': 'text',
    'bun.lock': 'json',
  };
  
  if (filenameMap[filename]) {
    return filenameMap[filename];
  }

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'mts': 'typescript',
    'cts': 'typescript',

    // Web markup/styling
    'html': 'html',
    'htm': 'html',
    'xhtml': 'html',
    'vue': 'html',
    'svelte': 'html',
    'astro': 'html',
    'ejs': 'html',
    'hbs': 'handlebars',
    'handlebars': 'handlebars',
    'mustache': 'handlebars',
    'njk': 'twig',
    'nunjucks': 'twig',
    'twig': 'twig',
    'liquid': 'liquid',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'styl': 'stylus',
    'stylus': 'stylus',
    'pcss': 'css',
    'postcss': 'css',

    // Data/config formats
    'json': 'json',
    'jsonc': 'json',
    'json5': 'json',
    'jsonl': 'json',
    'ndjson': 'json',
    'geojson': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
    'xsl': 'xml',
    'xslt': 'xml',
    'xsd': 'xml',
    'dtd': 'xml',
    'plist': 'xml',
    'svg': 'xml',
    'rss': 'xml',
    'atom': 'xml',
    'xaml': 'xml',
    'csproj': 'xml',
    'vbproj': 'xml',
    'fsproj': 'xml',
    'props': 'xml',
    'targets': 'xml',
    'nuspec': 'xml',
    'resx': 'xml',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    'config': 'ini',
    'properties': 'properties',
    'env': 'bash',
    'csv': 'text',
    'tsv': 'text',

    // Python
    'py': 'python',
    'pyw': 'python',
    'pyx': 'python',
    'pxd': 'python',
    'pxi': 'python',
    'pyi': 'python',
    'gyp': 'python',
    'gypi': 'python',
    'bzl': 'python',

    // Ruby
    'rb': 'ruby',
    'erb': 'erb',
    'rake': 'ruby',
    'gemspec': 'ruby',
    'ru': 'ruby',
    'podspec': 'ruby',
    'thor': 'ruby',
    'jbuilder': 'ruby',
    'rabl': 'ruby',
    'builder': 'ruby',

    // PHP
    'php': 'php',
    'phtml': 'php',
    'php3': 'php',
    'php4': 'php',
    'php5': 'php',
    'php7': 'php',
    'phps': 'php',
    'inc': 'php',
    'blade.php': 'php',

    // Java/JVM
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    'sc': 'scala',
    'groovy': 'groovy',
    'gradle': 'groovy',
    'gvy': 'groovy',
    'gy': 'groovy',
    'gsh': 'groovy',

    // C/C++/Objective-C
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'c++': 'cpp',
    'hpp': 'cpp',
    'hxx': 'cpp',
    'hh': 'cpp',
    'h++': 'cpp',
    'ino': 'cpp',
    'm': 'objectivec',
    'mm': 'objectivec',

    // C#/F#/.NET
    'cs': 'csharp',
    'csx': 'csharp',
    'cake': 'csharp',
    'fs': 'fsharp',
    'fsx': 'fsharp',
    'fsi': 'fsharp',
    'vb': 'vbnet',

    // Go
    'go': 'go',
    'mod': 'go',
    'sum': 'text',

    // Rust
    'rs': 'rust',

    // Swift
    'swift': 'swift',

    // Dart
    'dart': 'dart',

    // Lua
    'lua': 'lua',

    // Perl
    'pl': 'perl',
    'pm': 'perl',
    'pod': 'perl',
    't': 'perl',

    // R
    'r': 'r',
    'R': 'r',
    'rmd': 'markdown',
    'rnw': 'r',

    // Julia
    'jl': 'julia',

    // Haskell
    'hs': 'haskell',
    'lhs': 'haskell',

    // Elixir/Erlang
    'ex': 'elixir',
    'exs': 'elixir',
    'eex': 'html',
    'heex': 'html',
    'leex': 'html',
    'erl': 'erlang',
    'hrl': 'erlang',

    // Clojure
    'clj': 'clojure',
    'cljs': 'clojure',
    'cljc': 'clojure',
    'edn': 'clojure',

    // Lisp/Scheme
    'lisp': 'lisp',
    'cl': 'lisp',
    'el': 'lisp',
    'scm': 'scheme',
    'ss': 'scheme',
    'rkt': 'scheme',

    // OCaml/ReasonML
    'ml': 'ocaml',
    'mli': 'ocaml',
    're': 'reason',
    'rei': 'reason',

    // Nim
    'nim': 'nim',
    'nims': 'nim',
    'nimble': 'nim',

    // Zig
    'zig': 'zig',

    // V
    'v': 'v',
    'vsh': 'v',

    // Crystal
    'cr': 'crystal',

    // D
    'd': 'd',
    'di': 'd',

    // Shell/Scripts
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ksh': 'bash',
    'csh': 'bash',
    'tcsh': 'bash',
    'ps1': 'powershell',
    'psm1': 'powershell',
    'psd1': 'powershell',
    'bat': 'batch',
    'cmd': 'batch',

    // SQL
    'sql': 'sql',
    'psql': 'sql',
    'plsql': 'sql',
    'mysql': 'sql',
    'pgsql': 'sql',
    'sqlite': 'sql',

    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',

    // Solidity
    'sol': 'solidity',

    // Assembly
    'asm': 'nasm',
    's': 'nasm',
    'S': 'nasm',

    // Nix
    'nix': 'nix',

    // Terraform/HCL
    'tf': 'hcl',
    'tfvars': 'hcl',
    'hcl': 'hcl',

    // Docker
    'dockerignore': 'text',

    // Puppet
    'pp': 'puppet',

    // LaTeX
    'tex': 'latex',
    'latex': 'latex',
    'sty': 'latex',
    'cls': 'latex',
    'bib': 'bibtex',
    'bst': 'bibtex',

    // Markdown/docs
    'md': 'markdown',
    'mdx': 'markdown',
    'markdown': 'markdown',
    'mdown': 'markdown',
    'mkd': 'markdown',
    'rst': 'text',
    'adoc': 'asciidoc',
    'asciidoc': 'asciidoc',
    'org': 'text',
    'txt': 'text',
    'text': 'text',
    'rtf': 'text',

    // Vim
    'vim': 'vim',
    'vimrc': 'vim',

    // Makefile variants
    'mk': 'makefile',

    // CMake
    'cmake': 'cmake',

    // Diff/Patch
    'diff': 'diff',
    'patch': 'diff',



    // Prisma
    'prisma': 'prisma',

    // Protocol Buffers
    'proto': 'protobuf',

    // Thrift
    'thrift': 'thrift',

    // WASM
    'wat': 'wasm',
    'wast': 'wasm',



    // GLSL/Shaders
    'glsl': 'glsl',
    'vert': 'glsl',
    'frag': 'glsl',
    'geom': 'glsl',
    'comp': 'glsl',
    'hlsl': 'hlsl',
    'fx': 'hlsl',
    'cg': 'cg',
    'shader': 'glsl',

    // Apache/Nginx config
    'htaccess': 'apacheconf',
    'nginx': 'nginx',

    // Kubernetes
    'kubeconfig': 'yaml',

    // Ansible
    'ansible': 'yaml',
  };

  return languageMap[ext || ''] || null;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

export function getImageMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  return mimeMap[ext || ''] || 'image/png';
}

export function formatToolInput(input: Record<string, unknown>, toolName: string): string {
  if (!input) return '';

  const getString = (key: string): string | null => {
    const val = input[key];
    return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : null);
  };

  if (toolName === 'bash') {
    const cmd = getString('command');
    if (cmd) return cmd;
  }

  if (toolName === 'task') {
    const prompt = getString('prompt');
    if (prompt) return prompt;
    const desc = getString('description');
    if (desc) return desc;
  }

  if (toolName === 'apply_patch' && typeof input === 'object') {
    const patchText = getString('patchText') || getString('patch_text') || getString('patch');
    if (patchText) {
      return patchText;
    }
  }

  if ((toolName === 'edit' || toolName === 'multiedit') && typeof input === 'object') {
    const filePath = getString('filePath') || getString('file_path') || getString('path');
    if (filePath) {
      return `File path: ${filePath}`;
    }
  }

  if (toolName === 'write' && typeof input === 'object') {

    const content = getString('content');
    if (content) {
      return content;
    }
  }

  if (typeof input === 'object') {
    const entries = Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {

        const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')
          .toLowerCase()
          .replace(/^./, str => str.toUpperCase());

        let formattedValue = value;
        if (typeof value === 'object') {
          formattedValue = JSON.stringify(value, null, 2);
        } else if (typeof value === 'boolean') {
          formattedValue = value ? 'Yes' : 'No';
        }

        return `${formattedKey}: ${formattedValue}`;
      });

    return entries.join('\n');
  }

  return String(input);
}
