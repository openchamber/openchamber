/**
 * File type detection and categorization utilities.
 *
 * This module provides functions to detect binary files, categorize files by type,
 * and determine appropriate handling for different file formats.
 */

/**
 * File categories for different types of files.
 * - text: Source code, configuration, documentation, etc.
 * - image: Images that can be displayed (PNG, JPEG, GIF, SVG, etc.)
 * - pdf: PDF documents
 * - audio: Audio files (MP3, WAV, OGG, etc.)
 * - video: Video files (MP4, WEBM, etc.)
 * - archive: Compressed archives (ZIP, TAR, GZ, etc.)
 * - executable: Executable files (EXE, binary, etc.)
 * - font: Font files (WOFF, TTF, etc.)
 * - document: Office documents (DOC, DOCX, XLS, etc.)
 * - data: Data files (databases, etc.)
 */
export type FileCategory =
  | 'text'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'archive'
  | 'executable'
  | 'font'
  | 'document'
  | 'data';

/**
 * Information about a file's type and how it should be handled.
 */
export interface FileTypeInfo {
  category: FileCategory;
  isBinary: boolean;
  /** Whether the file can be displayed in the viewer */
  canDisplay: boolean;
  /** Human-readable description of the file type */
  description: string;
  /** Suggested action or viewer for this file type */
  suggestedAction?: string;
}

/**
 * Extensions for text files that can be opened and edited.
 */
const TEXT_EXTENSIONS = new Set([
  // Source code
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'pyx', 'pyi',
  'rb', 'erb', 'rake', 'gemspec',
  'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh',
  'cs', 'csx', 'fs', 'fsx', 'vb',
  'go', 'rs', 'swift', 'dart', 'lua',
  'pl', 'pm', 'r', 'jl', 'hs', 'lhs',
  'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'cljc', 'edn',
  'lisp', 'cl', 'el', 'scm', 'ss', 'rkt',
  'ml', 'mli', 're', 'rei',
  'nim', 'nims', 'zig', 'v', 'cr', 'd', 'di',
  'php', 'phtml',
  'm', 'mm', // Objective-C
  'sol', // Solidity

  // Web
  'html', 'htm', 'xhtml', 'vue', 'svelte', 'astro',
  'css', 'scss', 'sass', 'less', 'styl', 'pcss',
  'ejs', 'hbs', 'handlebars', 'mustache', 'njk', 'twig', 'liquid',

  // Data/config
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson',
  'yaml', 'yml', 'toml', 'xml', 'xsl', 'xslt', 'xsd', 'dtd',
  'ini', 'cfg', 'conf', 'config', 'properties', 'env',
  'csv', 'tsv', 'plist',

  // Shell/scripts
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh',
  'ps1', 'psm1', 'psd1', 'bat', 'cmd',

  // Documentation
  'md', 'mdx', 'markdown', 'mdown', 'mkd',
  'rst', 'adoc', 'asciidoc', 'org', 'txt', 'text',
  'tex', 'latex', 'sty', 'cls', 'bib', 'bst',

  // Query languages
  'sql', 'psql', 'mysql', 'pgsql', 'graphql', 'gql',

  // Infrastructure
  'tf', 'tfvars', 'hcl', 'nix',
  'dockerfile', 'dockerignore',
  'pp', // Puppet

  // Build/project
  'cmake', 'mk', 'makefile', 'gnumakefile',
  'gradle', 'sbt',

  // Other
  'diff', 'patch',
  'vim', 'vimrc',
  'prisma', 'proto', 'thrift',
  'glsl', 'vert', 'frag', 'geom', 'comp', 'hlsl', 'shader',
  'htaccess', 'nginx',
  'log', 'gitignore', 'gitattributes', 'gitmodules',
  'editorconfig', 'npmrc', 'yarnrc', 'prettierrc', 'eslintrc', 'babelrc',
  'browserslistrc', 'codeowners',
  'lock', // Various lock files (yarn.lock, etc.)

  // SVG is text-based XML
  'svg',

  // Assembly (often viewable as text)
  'asm', 's',
]);

/**
 * Extensions for image files.
 * Exported as the canonical source of truth for image extensions.
 */
export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
  'svg', // SVG is text-based but renders as image
]);

/**
 * Extensions for audio files.
 */
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'aiff', 'opus', 'mid', 'midi',
]);

/**
 * Extensions for video files.
 */
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'ogv', '3gp',
]);

/**
 * Extensions for archive files.
 */
const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'cab', 'iso', 'dmg',
  'jar', 'war', 'ear', // Java archives
  'deb', 'rpm', // Package archives
  'apk', 'ipa', // Mobile app packages
]);

/**
 * Extensions for executable files.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'app', 'msi', 'bin', 'com',
  'out', // Common compiled binary name
  'a', 'lib', // Static libraries
  'o', 'obj', // Object files
]);

/**
 * Extensions for font files.
 */
const FONT_EXTENSIONS = new Set([
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'fon', 'fnt',
]);

/**
 * Extensions for document files (Office, etc.).
 */
const DOCUMENT_EXTENSIONS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', // OpenDocument
  'rtf',
  'pages', 'numbers', 'key', // Apple iWork
]);

/**
 * Extensions for data files.
 */
const DATA_EXTENSIONS = new Set([
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', // Databases
  'dat', 'sav', // Generic data
  'pdb', 'rdb', // Specialized databases
  'pickle', 'pkl', // Python serialized
  'npy', 'npz', // NumPy
  'parquet', 'feather', // Data formats
  'hdf', 'hdf5', 'h5', // HDF
]);

/**
 * MIME type prefixes that indicate binary content.
 */
const BINARY_MIME_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'application/octet-stream',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-',
  'application/vnd.openxmlformats-',
  'font/',
  'application/font-',
  'application/x-font-',
];

/**
 * Get the file extension from a file path (lowercase).
 */
function getExtension(filePath: string): string {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1] || '';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === 0) {
    // No extension or hidden file without extension
    return '';
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

/**
 * Get the filename from a file path (lowercase).
 */
function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return (parts[parts.length - 1] || '').toLowerCase();
}

/**
 * Check if a file is a text file based on its extension.
 */
export function isTextFile(filePath: string): boolean {
  const ext = getExtension(filePath);
  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  // Check for known text filenames without extensions
  const filename = getFilename(filePath);
  const textFilenames = [
    'dockerfile', 'makefile', 'gnumakefile', 'gemfile', 'rakefile',
    'podfile', 'vagrantfile', 'guardfile', 'brewfile', 'fastfile',
    'procfile', 'codeowners', 'license', 'readme', 'changelog',
    'authors', 'contributors', 'copying', 'notice', 'todo',
    // Common dotfiles
    '.gitignore', '.gitattributes', '.gitmodules',
    '.editorconfig', '.npmrc', '.yarnrc', '.prettierrc', '.eslintrc', '.babelrc',
    '.browserslistrc',
  ];

  return textFilenames.includes(filename);
}

/**
 * Check if a file is a binary file (not readable as text).
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = getExtension(filePath);

  // Explicitly text files are not binary
  if (isTextFile(filePath)) {
    return false;
  }

  // Check binary categories
  if (IMAGE_EXTENSIONS.has(ext) && ext !== 'svg') return true;
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  if (VIDEO_EXTENSIONS.has(ext)) return true;
  if (ARCHIVE_EXTENSIONS.has(ext)) return true;
  if (EXECUTABLE_EXTENSIONS.has(ext)) return true;
  if (FONT_EXTENSIONS.has(ext)) return true;
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  if (DATA_EXTENSIONS.has(ext)) return true;

  // PDF is binary
  if (ext === 'pdf') return true;

  // WASM is binary
  if (ext === 'wasm') return true;

  // If we don't recognize the extension, assume it might be text
  // (this allows opening unknown file types)
  return false;
}

/**
 * Check if a file is a binary file based on MIME type.
 */
export function isBinaryMimeType(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();

  // Text MIME types are not binary
  if (lower.startsWith('text/')) {
    return false;
  }

  // JSON and XML application types are text
  if (lower === 'application/json' || lower === 'application/xml') {
    return false;
  }

  // Check binary prefixes
  return BINARY_MIME_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * Heuristic binary detection based on decoded text content.
 * Useful for unknown extensions where extension-based checks are inconclusive.
 */
export function looksLikeBinaryContent(content: string): boolean {
  if (!content) {
    return false;
  }

  const sampleSize = Math.min(content.length, 8_192);
  let suspiciousControlChars = 0;
  let replacementChars = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const code = content.charCodeAt(index);

    // Null bytes are a strong binary indicator.
    if (code === 0) {
      return true;
    }

    // U+FFFD replacement characters are common when binary bytes are decoded as UTF-8.
    if (code === 0xFFFD) {
      replacementChars += 1;
      continue;
    }

    // Control characters excluding common whitespace.
    const isSuspiciousControl = code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27;
    if (isSuspiciousControl) {
      suspiciousControlChars += 1;
    }
  }

  const suspiciousControlRatio = suspiciousControlChars / sampleSize;
  const replacementRatio = replacementChars / sampleSize;

  return suspiciousControlRatio > 0.2 || replacementRatio > 0.2;
}

/**
 * Get the category of a file based on its extension.
 */
export function getFileCategory(filePath: string): FileCategory {
  const ext = getExtension(filePath);

  // Check specific categories first
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (EXECUTABLE_EXTENSIONS.has(ext)) return 'executable';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (DATA_EXTENSIONS.has(ext)) return 'data';

  // Check if it's a text file
  if (isTextFile(filePath)) return 'text';

  // For all other unrecognized files, assume they might be text
  // (this allows opening unknown file types without warnings)
  return 'text';
}

/**
 * Get detailed information about a file type.
 */
export function getFileTypeInfo(filePath: string): FileTypeInfo {
  const category = getFileCategory(filePath);
  const ext = getExtension(filePath);

  switch (category) {
    case 'text':
      return {
        category,
        isBinary: false,
        canDisplay: true,
        description: 'Text file',
      };

    case 'image': {
      // SVG is text-based and can be viewed/edited
      const isSvg = ext === 'svg';
      return {
        category,
        isBinary: !isSvg,
        canDisplay: true,
        description: isSvg ? 'SVG image (vector)' : 'Image file',
        suggestedAction: 'This file will be displayed in the image viewer.',
      };
    }

    case 'pdf':
      return {
        category,
        isBinary: true,
        canDisplay: true,
        description: 'PDF document',
        suggestedAction: 'This file will be displayed in the PDF viewer.',
      };

    case 'audio':
      return {
        category,
        isBinary: true,
        canDisplay: true,
        description: 'Audio file',
        suggestedAction: 'This file will be played in the audio player.',
      };

    case 'video':
      return {
        category,
        isBinary: true,
        canDisplay: true,
        description: 'Video file',
        suggestedAction: 'This file will be played in the video player.',
      };

    case 'archive':
      return {
        category,
        isBinary: true,
        canDisplay: false,
        description: 'Archive file',
        suggestedAction: 'Archive files cannot be extracted in the file viewer. Use appropriate tools to extract the contents.',
      };

    case 'executable':
      return {
        category,
        isBinary: true,
        canDisplay: false,
        description: 'Executable or compiled binary',
        suggestedAction: 'Binary executables cannot be displayed as text. These files contain machine code.',
      };

    case 'font':
      return {
        category,
        isBinary: true,
        canDisplay: false,
        description: 'Font file',
        suggestedAction: 'Font files cannot be displayed in the file viewer. Consider using a font preview tool.',
      };

    case 'document':
      return {
        category,
        isBinary: true,
        canDisplay: false,
        description: 'Office document',
        suggestedAction: 'Office documents cannot be displayed in the file viewer. Consider opening with the appropriate application.',
      };

    case 'data':
      return {
        category,
        isBinary: true,
        canDisplay: false,
        description: 'Data file',
        suggestedAction: 'Data files cannot be displayed as text. These files contain binary data.',
      };

    default:
      return {
        category: 'text',
        isBinary: false,
        canDisplay: true,
        description: 'Text file',
      };
  }
}

/**
 * Check if a file can be displayed in the viewer.
 * Returns true for text files and images (which have dedicated viewers).
 */
export function canDisplayFile(filePath: string): boolean {
  const info = getFileTypeInfo(filePath);
  return info.canDisplay;
}

/**
 * Get a user-friendly description of why a file cannot be displayed.
 */
export function getBinaryFileWarning(filePath: string): {
  title: string;
  message: string;
} {
  const info = getFileTypeInfo(filePath);
  const filename = filePath.split('/').pop() || filePath;

  if (info.canDisplay) {
    return {
      title: '',
      message: '',
    };
  }

  switch (info.category) {
    case 'archive':
      return {
        title: 'Archive File',
        message: `"${filename}" is a compressed archive. Archive contents cannot be extracted or browsed in the file viewer. Use appropriate tools to extract the contents.`,
      };

    case 'executable':
      return {
        title: 'Binary Executable',
        message: `"${filename}" is an executable or compiled binary file. These files contain machine code and cannot be meaningfully displayed as text.`,
      };

    case 'font':
      return {
        title: 'Font File',
        message: `"${filename}" is a font file. Font files cannot be previewed in the file viewer. Consider using a dedicated font preview tool.`,
      };

    case 'document':
      return {
        title: 'Office Document',
        message: `"${filename}" is an Office document. These files require specialized software to view and edit. Consider opening with the appropriate application.`,
      };

    case 'data':
      return {
        title: 'Data File',
        message: `"${filename}" is a data file containing binary data. These files cannot be displayed as text.`,
      };

    default:
      return {
        title: 'Binary File',
        message: `"${filename}" appears to be a binary file that cannot be displayed as text.`,
      };
  }
}
