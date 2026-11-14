const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { blame, git, isCommitted, previousVersion } = require('../src/git');

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitpraise-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'empty.gitconfig');
  const repository = path.join(root, 'repository');
  await fs.writeFile(config, '');
  await fs.mkdir(repository);
  const run = (...args) => execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }
  }).trim();
  run('init', '--quiet');
  run('config', 'user.email', 'fixture@example.test');
  run('config', 'commit.gpgSign', 'false');
  run('config', 'core.autocrlf', 'false');
  run('config', 'core.quotePath', 'true');
  const commit = (author, subject) => {
    run('add', '--all');
    run('-c', 'user.name=' + author, 'commit', '-qm', subject);
    return run('rev-parse', 'HEAD');
  };
  return { root: repository, run, commit };
}

test('attributes unsaved insertions without shifting authorship on neighboring lines', async t => {
  const { root, commit } = await fixture(t);
  const filename = path.join(root, 'é sample.txt');
  await fs.writeFile(filename, 'one\n\nthree\n');
  const first = commit('Ana Silva', 'Initial file');
  await fs.writeFile(filename, 'one\n\nthree edited\n');
  const second = commit('Bo Chen', 'Edit line three');

  const result = await blame(filename, 'one\nnew unsaved line\n\nthree edited\n', {});
  assert.equal(result.file, 'é sample.txt');
  assert.deepEqual(result.lines.map(line => isCommitted(line.block.commit.sha)), [true, false, true, true]);
  assert.deepEqual(result.lines.map(line => line.originalLine), [1, 2, 2, 3]);
  assert.equal(result.lines[0].block.commit.sha, first);
  assert.equal(result.lines[2].block.commit.author, 'Ana Silva');
  assert.equal(result.lines[3].block.commit.sha, second);
  assert.equal(result.lines[3].block.commit.subject, 'Edit line three');
  assert.deepEqual(await previousVersion(result.root, result.lines[3].block), { sha: first, file: 'é sample.txt' });
  assert.equal(await previousVersion(result.root, result.lines[0].block), undefined);
});

test('opens historical content using the path before a rename', async t => {
  const { root, run, commit } = await fixture(t);
  const original = 'archive/[old] café.txt';
  const renamed = 'archive/[new] café.txt';
  const target = path.join(root, renamed);
  const before = Array.from({ length: 15 }, (_, i) => 'Unchanged text on line ' + i).join('\n') + '\n';
  const after = before.replace('Unchanged text on line 2\n', 'Edited on rename\n');
  await fs.mkdir(path.join(root, 'archive'));
  await fs.writeFile(path.join(root, original), before);
  const first = commit('Ana Silva', 'Initial file');
  run('mv', '--', original, renamed);
  await fs.writeFile(target, after);
  const second = commit('Bo Chen', 'Rename and edit');

  const result = await blame(target, after, {});
  assert.equal(result.lines[0].block.file, original);
  assert.equal(result.lines[2].block.file, renamed);
  assert.equal(result.lines[2].block.commit.sha, second);
  const parent = await previousVersion(result.root, result.lines[2].block);
  assert.deepEqual(parent, { sha: first, file: original });
  assert.equal(await git(result.root, ['cat-file', 'blob', parent.sha + ':' + parent.file]), before);
});

test('preserves CRLF attribution and supports ignoring whitespace', async t => {
  const { root, commit } = await fixture(t);
  const filename = path.join(root, 'windows.txt');
  const contents = 'first\r\nsecond\r\n';
  await fs.writeFile(filename, contents);
  const first = commit('Ana Silva', 'CRLF file');
  const changed = '    first\r\nsecond\r\n';

  assert.equal((await blame(filename, contents, {})).lines[0].block.commit.sha, first);
  assert.equal(isCommitted((await blame(filename, changed, {})).lines[0].block.commit.sha), false);
  assert.equal((await blame(filename, changed, { ignoreWhitespace: true })).lines[0].block.commit.sha, first);
});

test('explains why an untracked file cannot be annotated', async t => {
  const { root, commit } = await fixture(t);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'initial\n');
  commit('Ana Silva', 'Initial file');
  const filename = path.join(root, 'untracked.txt');
  await fs.writeFile(filename, 'new\n');

  await assert.rejects(blame(filename, 'new\n', {}), /needs a committed version/);
});
