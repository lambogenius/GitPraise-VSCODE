const vscode = require('vscode');
const path = require('node:path');
const { blame, git, isCommitted, previousVersion } = require('./git');

const namespace = 'gitPraise';
const snapshotScheme = 'gitpraise';
const maxLines = 25000;
const maxBytes = 2 * 1024 * 1024;
const commitColors = ['#658aff30', '#30a38930', '#d6833b30', '#a781d030', '#d26d8630', '#429abd30'];
const editorForeground = new vscode.ThemeColor('editor.foreground');
const uncommittedBackground = new vscode.ThemeColor('diffEditor.insertedTextBackground');
const truncate = (/** @type {string} */ value, /** @type {number} */ length) => {
  const characters = Array.from(value.replace(/[\p{Cc}\p{Cf}\s]/gu, ' ').trim());
  return characters.length > length ? characters.slice(0, length - 1).join('') + '…' : characters.join('');
};

/**
 * @typedef {{ state: { HEAD?: { commit?: string }, onDidChange: vscode.Event<void> } }} GitRepository
 * @typedef {{ git: { path: string }, getRepository: (uri: vscode.Uri) => GitRepository | null }} GitApi
 * @typedef {{ enabled: boolean, getAPI: (version: 1) => GitApi }} GitExtension
 * @typedef {{
 *   document: vscode.TextDocument,
 *   timer?: ReturnType<typeof setTimeout>,
 *   operation?: AbortController,
 *   watcher?: vscode.Disposable,
 *   repository?: GitRepository | null,
 *   executable?: string,
 *   result?: import('./git').Blame,
 *   version?: number,
 *   expanded: boolean,
 *   authors: vscode.DecorationOptions[],
 *   details: vscode.DecorationOptions[]
 * }} Annotation
 */

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  /** @type {Map<string, Annotation>} */
  const annotations = new Map();
  const authorDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  const commitDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  const output = vscode.window.createOutputChannel('GitPraise');

  /** @param {Annotation} annotation */
  function render(annotation) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === annotation.document) {
        editor.setDecorations(authorDecoration, annotation.authors);
        editor.setDecorations(commitDecoration, annotation.expanded ? annotation.details : []);
      }
    }
  }

  /** @param {Annotation} annotation */
  function renderCommitColumn(annotation) {
    const current = annotation.version === annotation.document.version;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === annotation.document) {
        editor.setDecorations(commitDecoration, annotation.expanded && current ? annotation.details : []);
      }
    }
  }

  function updateMenus() {
    const open = [];
    const expanded = [];
    for (const annotation of annotations.values()) {
      const uri = annotation.document.uri;
      // A workspace extension receives local file URIs from a remote extension host.
      // The workbench's resourcePath uses the URI path when the file is remote.
      open.push(uri.fsPath, uri.path);
      if (annotation.expanded) expanded.push(uri.fsPath, uri.path);
    }
    return Promise.all([
      vscode.commands.executeCommand('setContext', namespace + '.annotated', open),
      vscode.commands.executeCommand('setContext', namespace + '.expanded', expanded)
    ]);
  }

  /** @param {string} key */
  function hide(key) {
    const annotation = annotations.get(key);
    if (!annotation) return;
    annotations.delete(key);
    clearTimeout(annotation.timer);
    annotation.operation?.abort();
    annotation.watcher?.dispose();
    annotation.authors = [];
    annotation.details = [];
    render(annotation);
    return updateMenus();
  }

  /** @param {Annotation} annotation @param {number} [delay] */
  function schedule(annotation, delay = 350) {
    annotation.operation?.abort();
    clearTimeout(annotation.timer);
    annotation.timer = setTimeout(() => {
      annotation.timer = undefined;
      void refresh(annotation, false);
    }, delay);
  }

  /** @returns {Promise<GitApi | undefined>} */
  async function getGitApi() {
    try {
      const extension = /** @type {vscode.Extension<GitExtension> | undefined} */ (vscode.extensions.getExtension('vscode.git'));
      const gitExtension = await extension?.activate();
      if (gitExtension?.enabled) return gitExtension.getAPI(1);
    } catch {
      // The standalone Git executable also works when the built-in extension is disabled.
    }
  }

  /** @param {Annotation} annotation @param {GitRepository | null | undefined} repository */
  function watchHead(annotation, repository) {
    if (annotation.repository === repository) return;
    annotation.watcher?.dispose();
    annotation.repository = repository;
    let head = repository?.state.HEAD?.commit;
    annotation.watcher = repository?.state.onDidChange(() => {
      const next = repository.state.HEAD?.commit;
      if (head === next) return;
      head = next;
      schedule(annotation, 0);
    });
  }

  /** @param {Annotation} annotation @param {boolean} notify */
  async function refresh(annotation, notify) {
    clearTimeout(annotation.timer);
    annotation.timer = undefined;
    annotation.operation?.abort();
    const operation = new AbortController();
    annotation.operation = operation;
    const { document } = annotation;
    const version = document.version;
    const key = document.uri.toString();
    try {
      if (document.lineCount > maxLines) throw new Error('Annotation supports up to 25,000 lines per file.');
      const contents = document.getText();
      if (Buffer.byteLength(contents) > maxBytes) throw new Error('Annotation supports text files up to 2 MiB.');
      if (contents.includes('\0')) throw new Error('Annotation requires a text file.');
      const api = await getGitApi();
      if (operation.signal.aborted) return;
      const executable = api?.git.path || undefined;
      watchHead(annotation, api?.getRepository(document.uri));
      const config = vscode.workspace.getConfiguration(namespace, document.uri);
      const result = await blame(document.uri.fsPath, contents, {
        signal: operation.signal,
        executable,
        ignoreWhitespace: config.get('ignoreWhitespace', false),
        detectMovedLines: config.get('detectMovedLines', false)
      });
      if (operation.signal.aborted || document.version !== version || document.isClosed) return;
      annotation.executable = executable;
      annotation.result = result;
      annotation.version = version;
      const authors = [];
      const details = [];
      for (let index = 0; index < Math.min(result.lines.length, document.lineCount); index++) {
        const line = result.lines[index];
        if (!line) continue;
        const { commit } = line.block;
        const committed = isCommitted(commit.sha);
        const backgroundColor = committed
          ? commitColors[parseInt(commit.sha.slice(0, 8), 16) % commitColors.length]
          : uncommittedBackground;
        const label = committed ? (commit.date || '          ') + '  ' + truncate(commit.author || 'Unknown author', 19) : 'Uncommitted changes';
        const range = new vscode.Range(index, 0, index, 0);
        authors.push({
          range,
          renderOptions: {
            before: {
              contentText: '\u00a0' + label.replace(/ /g, '\u00a0'),
              width: '34ch',
              margin: '0 0.8em 0 0',
              backgroundColor,
              fontWeight: committed ? 'normal' : 'bold',
              color: editorForeground
            }
          }
        });
        const summary = committed ? commit.sha.slice(0, 8) + '  ' + truncate(commit.subject || '(No commit subject)', 42) : '';
        details.push({
          range,
          renderOptions: {
            before: {
              contentText: '\u00a0' + summary.replace(/ /g, '\u00a0'),
              width: '55ch',
              margin: '0 0.8em 0 0',
              backgroundColor,
              color: editorForeground
            }
          }
        });
      }
      annotation.authors = authors;
      annotation.details = details;
      render(annotation);
    } catch (error) {
      if (operation.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      await hide(key);
      if (notify) void vscode.window.showWarningMessage('GitPraise could not annotate this file. ' + message);
      else void vscode.window.showWarningMessage('GitPraise closed the annotations. ' + message);
    } finally {
      if (annotation.operation === operation) annotation.operation = undefined;
    }
  }

  /** @param {vscode.Uri | { uri?: vscode.Uri, lineNumber?: number }} [argument] */
  function locate(argument) {
    const active = vscode.window.activeTextEditor;
    const menu = argument instanceof vscode.Uri ? { uri: argument } : argument;
    const uri = menu?.uri ?? active?.document.uri;
    if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote')) return undefined;
    const key = uri.toString();
    const editor = active?.document.uri.toString() === key
      ? active
      : vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === key);
    if (!editor) return undefined;
    return { editor, key, line: typeof menu?.lineNumber === 'number' ? menu.lineNumber - 1 : editor.selection.active.line };
  }

  /** @param {{ uri?: vscode.Uri, lineNumber?: number }} [argument] */
  async function show(argument) {
    const target = locate(argument);
    if (!vscode.workspace.isTrusted || !target || annotations.has(target.key)) return;
    /** @type {Annotation} */
    const annotation = { document: target.editor.document, expanded: false, authors: [], details: [] };
    annotations.set(target.key, annotation);
    await updateMenus();
    if (annotations.get(target.key) === annotation && !annotation.document.isClosed) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading GitPraise annotations' }, () => refresh(annotation, true));
    }
  }

  /** @param {boolean} expanded @param {vscode.Uri | { uri?: vscode.Uri, lineNumber?: number }} [argument] */
  async function setExpanded(expanded, argument) {
    const target = locate(argument);
    const annotation = target && annotations.get(target.key);
    if (!annotation || annotation.expanded === expanded) return;
    annotation.expanded = expanded;
    renderCommitColumn(annotation);
    await updateMenus();
  }

  /** @param {{ uri?: vscode.Uri, lineNumber?: number }} [argument] */
  function attribution(argument) {
    const target = locate(argument);
    if (!target) return;
    const annotation = annotations.get(target.key);
    if (!annotation?.result || annotation.version !== annotation.document.version) return;
    const result = annotation.result;
    const entry = result.lines[target.line];
    if (!entry) return;
    if (!isCommitted(entry.block.commit.sha)) {
      void vscode.window.showInformationMessage('This line has uncommitted changes.');
      return;
    }
    return { result, entry, executable: annotation.executable };
  }

  /** @param {string} root @param {string} file @param {string} sha @param {string} [executable] */
  function snapshotUri(root, file, sha, executable) {
    // git.path is resolved by VS Code, never from the URI supplied to the provider.
    const resource = vscode.Uri.from({ scheme: snapshotScheme, path: '/' + path.posix.basename(file), query: JSON.stringify({ root, file, sha }) });
    knownRepositories.set(root, executable);
    return resource;
  }

  /** @type {Map<string, string | undefined>} */
  const knownRepositories = new Map();
  context.subscriptions.push(
    authorDecoration,
    commitDecoration,
    output,
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, {
      async provideTextDocumentContent(uri, cancellation) {
        if (!vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to view Git revisions.');
        const { root, file, sha } = JSON.parse(uri.query);
        if (typeof root !== 'string' || !knownRepositories.has(root) || typeof file !== 'string' || !file ||
            path.posix.isAbsolute(file) || file.split('/').includes('..') || (sha !== '' && (typeof sha !== 'string' || !isCommitted(sha)))) {
          throw new Error('Invalid Git revision.');
        }
        if (!sha) return '';
        const controller = new AbortController();
        const listener = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) controller.abort();
        try {
          return await git(root, ['cat-file', 'blob', sha + ':' + file], { executable: knownRepositories.get(root), signal: controller.signal });
        } finally {
          listener.dispose();
        }
      }
    }),
    vscode.commands.registerCommand(namespace + '.toggle', async argument => {
      const target = locate(argument);
      if (!target) return;
      return annotations.has(target.key) ? hide(target.key) : show(argument);
    }),
    vscode.commands.registerCommand(namespace + '.show', show),
    vscode.commands.registerCommand(namespace + '.showDetails', argument => setExpanded(true, argument)),
    vscode.commands.registerCommand(namespace + '.hideDetails', argument => setExpanded(false, argument)),
    vscode.commands.registerCommand(namespace + '.hide', async argument => {
      const target = locate(argument);
      if (target) await hide(target.key);
    }),
    vscode.commands.registerCommand(namespace + '.refresh', async argument => {
      const target = locate(argument);
      const annotation = target && annotations.get(target.key);
      if (annotation) await refresh(annotation, true);
    }),
    vscode.commands.registerCommand(namespace + '.copyCommit', async argument => {
      const source = attribution(argument);
      if (source) await vscode.env.clipboard.writeText(source.entry.block.commit.sha);
    }),
    vscode.commands.registerCommand(namespace + '.openDiff', async argument => {
      const source = attribution(argument);
      if (!source || !vscode.workspace.isTrusted) return;
      const { entry, result, executable } = source;
      const { block, originalLine } = entry;
      const { root } = result;
      try {
        const previous = await previousVersion(root, block, executable);
        const left = snapshotUri(root, previous?.file ?? block.file, previous?.sha ?? '', executable);
        const right = snapshotUri(root, block.file, block.commit.sha, executable);
        const line = originalLine - 1;
        await vscode.commands.executeCommand('vscode.diff', left, right,
          path.posix.basename(block.file) + ' (' + block.commit.sha.slice(0, 12) + ')',
          { selection: new vscode.Range(line, 0, line, 0), preview: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(message);
        void vscode.window.showWarningMessage('GitPraise could not open the diff. ' + message);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const annotation of annotations.values()) {
        if (annotation.version === annotation.document.version) render(annotation);
      }
    }),
    vscode.window.onDidChangeWindowState(state => {
      if (!state.focused) return;
      for (const annotation of annotations.values()) {
        if (!annotation.operation && !annotation.timer && vscode.window.visibleTextEditors.some(editor => editor.document === annotation.document)) {
          schedule(annotation, 0);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length) return;
      const annotation = annotations.get(event.document.uri.toString());
      if (!annotation) return;
      // Let the editor move the existing decorations with the text until fresh blame is ready.
      schedule(annotation);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      for (const annotation of annotations.values()) {
        if (event.affectsConfiguration(namespace, annotation.document.uri)) schedule(annotation, 0);
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      void hide(document.uri.toString());
    }),
    new vscode.Disposable(() => {
      for (const annotation of annotations.values()) {
        clearTimeout(annotation.timer);
        annotation.operation?.abort();
        annotation.watcher?.dispose();
      }
      annotations.clear();
    })
  );
}

module.exports = { activate };
