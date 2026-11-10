import { isAbsolute, join, sep } from 'node:path';

export interface ShellSegment {
  words: string[];
  writes: string[];
}

const BYPASS_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'ls',
  'find',
  'wc',
]);

const ISSUE_ID = /^[a-z0-9][a-z0-9_-]*-[a-z0-9]+(\.\d+)*$/i;

function findClosingQuote(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\' && quote === '"') i++;
    else if (quote === '"' && text[i] === '$' && text[i + 1] === '(')
      i = findClosingParen(text, i + 1);
    else if (text[i] === quote) return i;
  }
  return text.length;
}

function findClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') i = findClosingQuote(text, i);
    else if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
    else if (
      c === '<' &&
      text[i + 1] === '<' &&
      text[i + 2] !== '<' &&
      text[i - 1] !== '<'
    ) {
      const heredoc = /^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(text.slice(i));
      if (!heredoc) continue;
      const bodyStart = text.indexOf('\n', i);
      if (bodyStart === -1) return text.length;
      i = skipHeredocBody(text, bodyStart + 1, heredoc[2]);
    }
  }
  return text.length;
}

function skipHeredocBody(
  text: string,
  from: number,
  delimiter: string,
): number {
  let lineStart = from;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    if (text.slice(lineStart, lineEnd).trim() === delimiter) return lineEnd;
    lineStart = lineEnd + 1;
  }
  return text.length;
}

export function parseShell(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { words: [], writes: [] };
  let word = '';
  let hasWord = false;
  let numeric = true;
  let expect: 'write' | 'drop' | 'heredoc' | null = null;
  let heredocDelimiter: string | null = null;

  const endWord = () => {
    if (!hasWord) return;
    if (expect === 'write') current.writes.push(word);
    else if (expect === 'heredoc') heredocDelimiter = word;
    else if (expect !== 'drop') current.words.push(word);
    expect = null;
    word = '';
    hasWord = false;
    numeric = true;
  };
  const endSegment = () => {
    endWord();
    if (current.words.length || current.writes.length) segments.push(current);
    current = { words: [], writes: [] };
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = findClosingQuote(command, i);
      const quoted = command.slice(i + 1, end);
      // Only single quotes keep a backslash-newline line continuation.
      word += c === '"' ? quoted.replaceAll('\\\n', '') : quoted;
      hasWord = true;
      numeric = false;
      i = end;
    } else if (c === '\\' && command[i + 1] === '\n') {
      // A line continuation joins the lines and leaves nothing behind.
      i++;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
      numeric = false;
    } else if (c === '\n') {
      endSegment();
      if (heredocDelimiter !== null) {
        i = skipHeredocBody(command, i + 1, heredocDelimiter);
        heredocDelimiter = null;
      }
    } else if (c === ';' || c === '|' || c === '&') {
      if (c === '&' && command[i - 1] === '>') continue;
      endSegment();
    } else if (c === '#' && !hasWord) {
      // A comment runs to the end of the line; the newline still ends the segment.
      const newline = command.indexOf('\n', i);
      i = (newline === -1 ? command.length : newline) - 1;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '>') {
      if (hasWord && numeric) {
        word = '';
        hasWord = false;
      } else endWord();
      if (command[i + 1] === '>') i++;
      if (command[i + 1] === '&') {
        i++;
        expect = 'drop';
      } else expect = 'write';
    } else if (c === '<') {
      endWord();
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        i += 2;
        expect = 'drop';
      } else if (command[i + 1] === '<') {
        i++;
        if (command[i + 1] === '-') i++;
        expect = 'heredoc';
      }
    } else {
      word += c;
      hasWord = true;
      if (!/\d/.test(c)) numeric = false;
    }
  }
  endSegment();
  return segments;
}

export function commandWords(segment: ShellSegment): string[] {
  const words = [...segment.words];
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  if (words[0] === 'command' || words[0] === 'sudo') words.shift();
  return words;
}

function isInPlaceSed(name: string, args: string[]): boolean {
  return (
    name === 'sed' &&
    args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')
  );
}

function inPlaceSedFiles(args: string[]): string[] {
  // macOS takes the backup suffix as its own word, often empty: `sed -i ''`.
  const kept = args.filter((a, i) => !(a === '' && args[i - 1] === '-i'));
  return readTargets('sed', kept);
}

export function shellWritePaths(segments: ShellSegment[]): string[] {
  const paths: string[] = [];
  for (const segment of segments) {
    paths.push(...segment.writes.filter((p) => !p.startsWith('/dev/')));
    const [name, ...args] = commandWords(segment);
    const operands = args.filter((a) => !a.startsWith('-'));
    if (name === 'tee') paths.push(...operands);
    else if (isInPlaceSed(name, args)) paths.push(...inPlaceSedFiles(args));
    else if ((name === 'cp' || name === 'mv') && operands.length >= 2)
      paths.push(operands[operands.length - 1]);
  }
  return paths;
}

const BD_BOOLEAN_FLAGS = new Set([
  '--claim',
  '--force',
  '-f',
  '--json',
  '--dry-run',
  '--suggest-next',
  '--continue',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
  '--no-daemon',
  '--sandbox',
]);

// Global flags before the verb that take a value in the next word.
const BD_GLOBAL_VALUE_FLAGS = new Set(['--actor', '--db', '--dir']);

function positionalArguments(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) positional.push(arg);
    else if (!arg.includes('=') && !BD_BOOLEAN_FLAGS.has(arg)) i++;
  }
  return positional;
}

export function bdCommands(
  segments: ShellSegment[],
): { verb: 'claim' | 'close'; issue_id: string }[] {
  const found: { verb: 'claim' | 'close'; issue_id: string }[] = [];
  for (const segment of segments) {
    const [name, ...rest] = commandWords(segment);
    if (name !== 'bd') continue;
    // Skip global flags before the verb, such as `bd --sandbox --actor x update`.
    let v = 0;
    while (v < rest.length && rest[v].startsWith('-'))
      v += BD_GLOBAL_VALUE_FLAGS.has(rest[v]) ? 2 : 1;
    const [verb, ...args] = rest.slice(v);
    const ids = positionalArguments(args).filter((a) => ISSUE_ID.test(a));
    if (verb === 'update' && args.some((a) => a.startsWith('--claim')))
      for (const id of ids) found.push({ verb: 'claim', issue_id: id });
    else if (verb === 'close')
      for (const id of ids) found.push({ verb: 'close', issue_id: id });
  }
  return found;
}

// Commands whose first positional argument is a pattern or script, not a file.
const PATTERN_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
]);
// Flags that carry the pattern or script, so every positional is a file.
const PATTERN_FLAGS = new Set([
  '-e',
  '-f',
  '--regexp',
  '--file',
  '--expression',
]);

function readTargets(reader: string, args: string[]): string[] {
  if (reader === 'find') {
    // Start paths come before the first expression argument.
    const end = args.findIndex(
      (a) => a.startsWith('-') || a === '(' || a === '!',
    );
    return end === -1 ? args : args.slice(0, end);
  }
  if (!PATTERN_COMMANDS.has(reader))
    return args.filter((a) => !a.startsWith('-'));
  const operands: string[] = [];
  let patternFromFlag = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (PATTERN_FLAGS.has(arg)) {
      patternFromFlag = true;
      i++;
    } else if (PATTERN_FLAGS.has(arg.split('=')[0])) patternFromFlag = true;
    else if (!arg.startsWith('-')) operands.push(arg);
  }
  return patternFromFlag ? operands : operands.slice(1);
}

// Skips git's global options before the subcommand. `-C <dir>` moves git, so
// relative targets are joined onto it; the callers resolve them against cwd.
function gitSubcommand(words: string[]): { words: string[]; dir: string } {
  let dir = '';
  let i = 0;
  while (i < words.length && words[i].startsWith('-')) {
    const option = words[i++];
    if (option === '-C') {
      const next = words[i++] ?? '';
      dir = isAbsolute(next) || !dir ? next : join(dir, next);
    } else if (['-c', '--git-dir', '--work-tree'].includes(option)) i++;
  }
  return { words: words.slice(i), dir };
}

export function bypassReadArguments(segments: ShellSegment[]): string[] {
  const targets: string[] = [];
  for (const segment of segments) {
    const [name, ...words] = commandWords(segment);
    const git = name === 'git' ? gitSubcommand(words) : null;
    const isGitGrep = git?.words[0] === 'grep';
    const reader = isGitGrep ? 'grep' : name;
    const args = isGitGrep ? git.words.slice(1) : words;
    if (!BYPASS_COMMANDS.has(reader) || isInPlaceSed(name, args)) continue;
    const dir = isGitGrep ? git.dir : '';
    const read = readTargets(reader, args);
    // git grep with no path searches the whole -C directory.
    if (isGitGrep && read.length === 0 && dir) targets.push(dir);
    for (const target of read)
      targets.push(dir && !isAbsolute(target) ? join(dir, target) : target);
  }
  return targets;
}

export function isInside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir + sep);
}
