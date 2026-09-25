import { normalizeToolName } from '@/lib/opencode/tools';
import {
  isEditTool,
  isPatchTool,
  isShellTool,
  isSubagentTool,
  isWriteTool,
} from '@/lib/opencode/tools';

/** v2 file tools report `path`; the other keys cover MCP and plugin tools. */
const readInputPath = (input: Record<string, unknown> | undefined): string | null => {
  const value = input?.path ?? input?.filePath ?? input?.file_path ?? input?.sourcePath;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

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

const TOOL_METADATA: Record<string, ToolMetadata> = {

  read: {
    displayName: 'Read File',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'path', label: 'File Path', type: 'file' },
      { key: 'offset', label: 'Start Line', type: 'text' },
      { key: 'limit', label: 'Lines to Read', type: 'text' }
    ]
  },
  write: {
    displayName: 'Write File',
    category: 'file',
    outputLanguage: 'auto',
    inputFields: [
      { key: 'path', label: 'File Path', type: 'file' },
      { key: 'content', label: 'Content', type: 'code' }
    ]
  },
  edit: {
    displayName: 'Edit File',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'path', label: 'File Path', type: 'file' },
      { key: 'oldString', label: 'Find', type: 'code' },
      { key: 'newString', label: 'Replace', type: 'code' },
      { key: 'replaceAll', label: 'Replace All', type: 'text' }
    ]
  },
  patch: {
    displayName: 'Apply Patch',
    category: 'file',
    outputLanguage: 'diff',
    inputFields: [
      { key: 'patchText', label: 'Patch', type: 'code', language: 'diff' }
    ]
  },

  // OpenCode 2 Code Mode: one tool whose input is a short JS script that calls
  // the MCP and integration tools as functions.
  execute: {
    displayName: 'Script',
    category: 'code',
    outputLanguage: 'json',
    inputFields: [
      { key: 'code', label: 'Script', type: 'code', language: 'javascript' }
    ]
  },

  shell: {
    displayName: 'Shell Command',
    category: 'system',
    outputLanguage: 'text',
    inputFields: [
      { key: 'command', label: 'Command', type: 'command', language: 'bash' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'text' },
      { key: 'background', label: 'Background', type: 'text' }
    ]
  },

  grep: {
    displayName: 'Search Files',
    category: 'search',
    outputLanguage: 'text',
    inputFields: [
      { key: 'pattern', label: 'Pattern', type: 'pattern' },
      { key: 'path', label: 'Directory', type: 'file' },
      { key: 'include', label: 'Include Pattern', type: 'pattern' },
      { key: 'literal', label: 'Literal Match', type: 'text' },
      { key: 'caseSensitive', label: 'Case Sensitive', type: 'text' }
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
  subagent: {
    displayName: 'Agent Task',
    category: 'ai',
    outputLanguage: 'markdown',
    inputFields: [
      { key: 'description', label: 'Task', type: 'text' },
      { key: 'prompt', label: 'Instructions', type: 'text' },
      { key: 'agent', label: 'Agent', type: 'text' }
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

   skill: {
     displayName: 'Load Skill',
     category: 'ai',
     outputLanguage: 'markdown',
     inputFields: [
       { key: 'id', label: 'Skill', type: 'text' }
     ]
   },
   // The `opencode` namespace: OpenCode managing itself.
   session_rename: {
     displayName: 'Rename Session',
     category: 'system',
     outputLanguage: 'json',
     inputFields: [
       { key: 'title', label: 'Title', type: 'text' },
       { key: 'sessionID', label: 'Session', type: 'text' }
     ]
   },
   session_move: {
     displayName: 'Move Session',
     category: 'system',
     outputLanguage: 'json',
     inputFields: [
       { key: 'directory', label: 'Directory', type: 'file' },
       { key: 'sessionID', label: 'Session', type: 'text' }
     ]
   },
   models: {
     displayName: 'Search Models',
     category: 'system',
     outputLanguage: 'json',
     inputFields: [
       { key: 'search', label: 'Search', type: 'text' },
       { key: 'provider', label: 'Provider', type: 'text' }
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

    openchamber: {
      displayName: 'OpenChamber',
      category: 'system',
      outputLanguage: 'json',
      inputFields: []
    },

    openchamber_web: {
      displayName: 'OpenChamber Web',
      category: 'system',
      outputLanguage: 'json',
      inputFields: []
    },

    openchamber_memory: {
      displayName: 'OpenChamber Memory',
      category: 'system',
      outputLanguage: 'json',
      inputFields: []
    },

    openchamber_notify: {
      displayName: 'OpenChamber Notify',
      category: 'system',
      outputLanguage: 'json',
      inputFields: []
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

function formatUnknownToolDisplayName(toolName: string): string {
  return toolName
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase());
}

export function getToolMetadata(toolName: string): ToolMetadata {
  // Namespaced tools (`opencode.session_rename`) are keyed by their last segment.
  return TOOL_METADATA[toolName] || TOOL_METADATA[normalizeToolName(toolName)] || {
    displayName: formatUnknownToolDisplayName(toolName),
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

    const filePath = readInputPath(input);
    if (filePath) {
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

const DIAGRAM_EXTENSIONS = ['drawio', 'dio'];

export function isDrawioFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return DIAGRAM_EXTENSIONS.includes(ext || '');
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

export function isPdfFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'pdf';
}

export function isSvgFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.svg');
}

// Playable in a browser media element: the viewer plays these instead of
// offering a download. What a runtime's engine cannot decode (an HEVC .mov,
// a .mkv) still opens; the element reports the failure and the viewer says so.
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv'];
const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'];

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(getFileExtension(filePath));
}

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.includes(getFileExtension(filePath));
}

export function isFontFile(filePath: string): boolean {
  return FONT_EXTENSIONS.includes(getFileExtension(filePath));
}

/** Comma- or tab-separated text the viewer can lay out as a table. */
export function isDelimitedTableFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === 'csv' || ext === 'tsv';
}

export function isMermaidFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === 'mmd' || ext === 'mermaid';
}

/** Known non-text extensions that must not be opened or saved as UTF-8 text. */
const BINARY_FILE_EXTENSIONS = new Set([
  // Documents / office
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Archives / packages
  'zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'jar', 'war', 'apk', 'dmg', 'iso',
  'deb', 'rpm', 'msi',
  // Images (svg is text and is excluded via isSvgFile)
  ...IMAGE_EXTENSIONS.filter((ext) => ext !== 'svg'),
  // Audio / video
  ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, 'wma', 'avi', 'wmv',
  // Fonts
  ...FONT_EXTENSIONS, 'eot',
  // Native / bytecode
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'lib', 'wasm', 'node',
  // Databases / locks / misc binary
  'sqlite', 'sqlite3', 'db', 'dat', 'parquet', 'feather', 'pickle', 'pyc', 'pyo', 'lockb',
]);

export function getFileExtension(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** True for known binary extensions (including images/PDF). SVG is not binary. */
export function isBinaryFile(filePath: string): boolean {
  if (isSvgFile(filePath)) {
    return false;
  }
  const ext = getFileExtension(filePath);
  return BINARY_FILE_EXTENSIONS.has(ext);
}

/**
 * Heuristic for UTF-8 text that is actually binary (or was lossily decoded).
 * Used as defense-in-depth when extension checks miss a binary file.
 */
export function looksLikeBinaryText(content: string): boolean {
  if (!content) {
    return false;
  }

  const sample = content.length > 8192 ? content.slice(0, 8192) : content;
  if (sample.includes('\0')) {
    return true;
  }
  if (sample.startsWith('%PDF')) {
    return true;
  }
  // ZIP-based formats (docx/xlsx/pptx/jar/apk…) and raw ZIP.
  if (sample.startsWith('PK\u0003\u0004') || sample.startsWith('PK\u0005\u0006') || sample.startsWith('PK\u0007\u0008')) {
    return true;
  }

  let suspicious = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0xFFFD) {
      suspicious += 1;
      continue;
    }
    // C0 controls excluding common whitespace (TAB/LF/VT/FF/CR).
    if (code < 9 || (code > 13 && code < 32) || code === 127) {
      suspicious += 1;
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.1;
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

  if (isShellTool(toolName)) {
    const cmd = getString('command');
    if (cmd) return cmd;
  }

  if (isSubagentTool(toolName)) {
    const prompt = getString('prompt');
    if (prompt) return prompt;
    const desc = getString('description');
    if (desc) return desc;
  }

  if (isPatchTool(toolName) && typeof input === 'object') {
    const patchText = getString('patchText') || getString('patch_text') || getString('patch');
    if (patchText) {
      return patchText;
    }
  }

  if (isEditTool(toolName) && typeof input === 'object') {
    const filePath = readInputPath(input);
    if (filePath) {
      return `File path: ${filePath}`;
    }
  }

  if (isWriteTool(toolName) && typeof input === 'object') {

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
