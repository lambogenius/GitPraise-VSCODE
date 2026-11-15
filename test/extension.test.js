const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');
const gitModule = require('../src/git');

test('toolbar submenu provides existing icon assets for light and dark themes', () => {
  const repository = fs.realpathSync(path.resolve(__dirname, '..'));
  const menu = require('../package.json').contributes.submenus.find(item => item.id === 'gitPraise.menu');
  assert.ok(menu);
  for (const theme of ['light', 'dark']) {
    assert.equal(typeof menu.icon?.[theme], 'string', 'The submenu needs an icon path for the ' + theme + ' theme.');
    const asset = fs.realpathSync(path.resolve(repository, menu.icon[theme]));
    assert.ok(asset.startsWith(repository + path.sep), 'The icon must resolve inside the repository.');
    assert.ok(fs.statSync(asset).isFile());
  }
});

function fixture(t) {
  const commands = new Map();
  const requests = [];
  const decorationTypes = [];
  const disposable = () => ({ dispose() {} });
  class Uri {
    constructor(file) { this.scheme = 'file'; this.fsPath = file; this.path = file; }
    toString() { return 'file://' + this.path; }
  }
  const editor = {
    document: {
      uri: new Uri('/sample.js'), version: 1, lineCount: 1, isClosed: false,
      getText: () => 'one\n'
    },
    selection: { active: { line: 0 } },
    decorations: new Map(),
    setDecorations(type, entries) { this.decorations.set(type, entries); }
  };
  const vscode = {
    Uri,
    ThemeColor: class {},
    Range: class {},
    Disposable: class { constructor(callback) { this.dispose = callback; } },
    DecorationRangeBehavior: { ClosedClosed: 0 },
    ProgressLocation: { Window: 0 },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      async executeCommand() {}
    },
    extensions: { getExtension() {} },
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      createTextEditorDecorationType() {
        const type = disposable();
        decorationTypes.push(type);
        return type;
      },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      withProgress: (_options, callback) => callback(),
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeWindowState: disposable
    },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      registerTextDocumentContentProvider: disposable,
      onDidChangeTextDocument: disposable,
      onDidChangeConfiguration: disposable,
      onDidCloseTextDocument: disposable
    }
  };
  const gitMock = {
    ...gitModule,
    blame: () => new Promise(resolve => requests.push(resolve))
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './git') return gitMock;
      return require(name);
    },
    Buffer, AbortController, setTimeout, clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/extension'), 'utf8'), context);
  const subscriptions = [];
  context.module.exports.activate({ subscriptions });
  t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
  const result = {
    lines: [{ block: { commit: {
      sha: 'a'.repeat(40), author: 'Fixture author', date: '2026-11-15', subject: 'Fixture commit'
    } } }]
  };
  return {
    run: command => commands.get('gitPraise.' + command)(editor.document.uri),
    complete: index => requests[index](result),
    columns: () => decorationTypes.map(type => editor.decorations.get(type)?.length ?? 0)
  };
}

test('Commit Info opens both columns without changing a replacement annotation after loading', async t => {
  const { run, complete, columns } = fixture(t);
  const initial = run('toggleDetails');
  await nextTurn();
  complete(0);
  await initial;
  assert.deepEqual(columns(), [1, 1]);

  await run('toggleDetails');
  assert.deepEqual(columns(), [1, 0]);
  await run('showDetails');
  assert.deepEqual(columns(), [1, 1]);
  await run('hideDetails');
  assert.deepEqual(columns(), [1, 0]);
  await run('toggle');

  const cancelled = run('toggleDetails');
  await nextTurn();
  await run('toggle');
  const reopened = run('toggle');
  await nextTurn();
  complete(1);
  await cancelled;
  complete(2);
  await reopened;
  assert.deepEqual(columns(), [1, 0]);
});
