/**
 * Wrap verbatim content in a Markdown code fence that the content cannot
 * close early: the fence is one backtick longer than the longest backtick run
 * inside the content. Keeps repository data clearly delimited as data.
 */
export function fence(content: string, lang = ''): string {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `${ticks}${lang}\n${body}${ticks}`;
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.md': 'md',
  '.mdx': 'mdx',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'sh',
  '.sql': 'sql',
  '.py': 'py',
};

export function langForPath(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return '';
  return LANG_BY_EXT[relPath.slice(dot).toLowerCase()] ?? '';
}
