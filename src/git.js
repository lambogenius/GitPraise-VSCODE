const { execFile } = require('node:child_process');
const path = require('node:path');

const oid = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const headerPattern = new RegExp('^(' + oid + ') (\\d+) (\\d+) (\\d+)$');
const previousPattern = new RegExp('^(' + oid + ') (.+)$');
const parentPattern = new RegExp('^parent (' + oid + ')$', 'm');
const objectIdPattern = new RegExp('^' + oid + '$');

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string, signal?: AbortSignal, executable?: string }} [options]
 * @returns {Promise<string>}
 */
function git(cwd, args, { input, signal, executable = 'git' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['--no-pager', '--literal-pathspecs', ...args], {
      cwd,
      signal,
      windowsHide: true,
      timeout: 25000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') {
        reject(new Error('Git was not found. Install Git or set git.path in your user settings.'));
      } else if (error?.killed && !signal?.aborted) {
        reject(new Error('Git did not finish within 25 seconds.'));
      } else if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });

    // Git can exit before consuming stdin, for example when HEAD lacks the path.
    child.stdin?.on('error', error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE' && !signal?.aborted) reject(error);
    });
    child.stdin?.end(input);
  });
}

/** @param {string} value */
function unquotePath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' };
  const chunks = value.slice(1, -1).match(/\\[0-7]{3}|\\.|[^\\]+/gu) ?? [];
  return Buffer.concat(chunks.map(chunk => {
    if (/^\\[0-7]{3}$/.test(chunk)) return Buffer.from([parseInt(chunk.slice(1), 8)]);
    const escaped = /** @type {keyof typeof escapes} */ (chunk.slice(1));
    return Buffer.from(chunk.startsWith('\\') ? (escapes[escaped] ?? escaped) : chunk);
  })).toString('utf8');
}

/**
 * @typedef {{ sha: string, author: string, date: string, subject: string }} Commit
 * @typedef {{ sha: string, file: string }} Revision
 * @typedef {{ commit: Commit, file: string, originalLine: number, firstLine: number, length: number, previous?: Revision }} BlameBlock
 * @typedef {{ root: string, file: string, lines: (undefined | { block: BlameBlock, originalLine: number })[] }} Blame
 */

/** @param {string} output @returns {BlameBlock[]} */
function parseBlame(output) {
  /** @type {Map<string, Commit>} */
  const commits = new Map();
  /** @type {BlameBlock[]} */
  const blocks = [];
  /** @type {BlameBlock | undefined} */
  let current;
  let time = 0;

  for (const line of output.split('\n')) {
    if (!current) {
      const header = headerPattern.exec(line);
      if (!header) continue;
      const [, sha, originalLine, finalLine, length] = header;
      const commit = commits.get(sha) ?? { sha, author: '', date: '', subject: '' };
      commits.set(sha, commit);
      current = { commit, originalLine: Number(originalLine), firstLine: Number(finalLine), length: Number(length), file: '' };
      time = 0;
      continue;
    }

    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    switch (key) {
      case 'author': current.commit.author = value; break;
      case 'author-time': time = Number(value); break;
      case 'author-tz': {
        const offset = /^([+-])(\d{2})(\d{2})$/.exec(value);
        const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1) : 0;
        const date = new Date((time + minutes * 60) * 1000);
        current.commit.date = Number.isNaN(date.valueOf()) ? '' : date.toISOString().split('T')[0];
        break;
      }
      case 'summary': current.commit.subject = value; break;
      case 'previous': {
        const previous = previousPattern.exec(value);
        if (previous) current.previous = { sha: previous[1], file: unquotePath(previous[2]) };
        break;
      }
      case 'filename':
        current.file = unquotePath(value);
        blocks.push(current);
        current = undefined;
        break;
    }
  }
  return blocks;
}

/** @param {string} filename @param {string} contents @param {{ executable?: string, signal?: AbortSignal, ignoreWhitespace?: boolean, detectMovedLines?: boolean }} options @returns {Promise<Blame>} */
async function blame(filename, contents, options) {
  let locations;
  try {
    locations = await git(path.dirname(filename), ['rev-parse', '--show-toplevel', '--show-prefix'], options);
  } catch (error) {
    if (error instanceof Error && /not a git repository/.test(error.message)) {
      throw new Error('This file is outside a Git repository.');
    }
    throw error;
  }
  // --show-prefix is relative to the repository and ends with a slash for subdirectories.
  const [root, prefix] = locations.split(/\r?\n/);
  const file = prefix + path.basename(filename);
  const args = ['-c', 'core.quotePath=false', 'blame', '--incremental', '--encoding=UTF-8', '--no-textconv'];
  if (options.ignoreWhitespace) args.push('-w');
  if (options.detectMovedLines) args.push('-M');
  let output;
  try {
    output = await git(root, [...args, '--contents', '-', '--', file], { ...options, input: contents });
  } catch (error) {
    if (error instanceof Error && /no such path .+ in HEAD|bad revision 'HEAD'|ambiguous argument 'HEAD'|no such ref: HEAD|no such ref: refs\/heads\//s.test(error.message)) {
      throw new Error('This file needs a committed version before Git can annotate it.');
    }
    throw error;
  }

  /** @type {Blame['lines']} */
  const lines = [];
  for (const block of parseBlame(output)) {
    for (let offset = 0; offset < block.length; offset++) {
      lines[block.firstLine - 1 + offset] = { block, originalLine: block.originalLine + offset };
    }
  }
  return { root, file, lines };
}

/** @param {string} root @param {BlameBlock} block @param {string} [executable] */
async function previousVersion(root, { commit, file, previous }, executable) {
  if (previous) return previous;

  // A boundary in a shallow clone can still have a parent that isn't available locally.
  const raw = await git(root, ['cat-file', 'commit', commit.sha], { executable });
  const parent = parentPattern.exec(raw.split('\n\n', 1)[0])?.[1];
  if (!parent) return undefined;
  let entry;
  try {
    entry = await git(root, ['ls-tree', '-z', '--full-tree', parent, '--', file], { executable });
  } catch (error) {
    if (error instanceof Error && /not a tree object/.test(error.message)) {
      throw new Error('The parent commit is unavailable in the local clone.');
    }
    throw error;
  }
  return /^[0-7]+ blob /.test(entry) ? { sha: parent, file } : undefined;
}

/** @param {string} sha */
function isCommitted(sha) {
  return objectIdPattern.test(sha) && !/^0+$/.test(sha);
}

module.exports = { blame, git, isCommitted, previousVersion };
