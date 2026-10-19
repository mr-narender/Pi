const assert = require('node:assert/strict');

async function verifySafeUndo(vscode) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { buildSync } = require('esbuild');
  const output = buildSync({
    entryPoints: [path.resolve(__dirname, '../../../src/review/safeUndo.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const notices = [];
  const window = new Proxy(vscode.window, {
    get(target, property) {
      return property === 'showWarningMessage'
        ? async (message) => {
            notices.push(message);
            return 'Keep current file';
          }
        : Reflect.get(target, property);
    },
  });
  const host = new Proxy(vscode, {
    get: (target, property) => (property === 'window' ? window : Reflect.get(target, property)),
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(
    (name) => (name === 'vscode' ? host : require(name)),
    loaded,
    loaded.exports
  );
  const { captureUndoState, restoreUndoFile } = loaded.exports;
  const scratch = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pi-extension');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'safe-undo-host-'));
  let opened;
  try {
    const file = path.join(root, 'edited.txt');
    const uri = vscode.Uri.file(file);
    const before = Buffer.from('before Pi\n');
    const after = Buffer.from('Pi result\n');
    await fs.writeFile(file, after);
    const expected = await captureUndoState(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    opened = await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), 'my unsaved text\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    const dirtyText = document.getText();
    assert.equal(await restoreUndoFile(uri, expected, before, after), false);
    assert.equal(document.getText(), dirtyText, 'Undo must preserve real unsaved editor text');
    assert.equal(document.isDirty, true);
    assert.deepEqual(await fs.readFile(file), after, 'dirty conflict must preserve saved Pi bytes');

    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.equal(document.isDirty, false);
    assert.equal(await restoreUndoFile(uri, expected, before, after), true);
    assert.deepEqual(await fs.readFile(file), before);
    const deadline = Date.now() + 5000;
    while (document.getText() !== before.toString() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      document.getText(),
      before.toString(),
      'clean open editor must show restored content'
    );
    assert.equal(document.isDirty, false);

    const externalFile = path.join(root, 'external.txt');
    const externalUri = vscode.Uri.file(externalFile);
    await fs.writeFile(externalFile, after);
    const externalExpected = await captureUndoState(externalUri);
    await fs.writeFile(externalFile, 'newer external edit\n');
    assert.equal(await restoreUndoFile(externalUri, externalExpected, before, after), false);
    assert.equal(await fs.readFile(externalFile, 'utf8'), 'newer external edit\n');

    const createdFile = path.join(root, 'created.txt');
    const createdUri = vscode.Uri.file(createdFile);
    await fs.writeFile(createdFile, after);
    const createdExpected = await captureUndoState(createdUri);
    await fs.writeFile(createdFile, 'newer edit in Pi-created file\n');
    assert.equal(await restoreUndoFile(createdUri, createdExpected, null, after), false);
    assert.equal(await fs.readFile(createdFile, 'utf8'), 'newer edit in Pi-created file\n');
    const unchangedFile = path.join(root, 'unchanged-created.txt');
    const unchangedUri = vscode.Uri.file(unchangedFile);
    await fs.writeFile(unchangedFile, after);
    const unchangedCreated = await captureUndoState(unchangedUri);
    assert.equal(await restoreUndoFile(unchangedUri, unchangedCreated, null), true);
    await assert.rejects(fs.readFile(unchangedFile), { code: 'ENOENT' });
    const deletedExpected = await captureUndoState(unchangedUri);
    assert.equal(await restoreUndoFile(unchangedUri, deletedExpected, before), true);
    assert.deepEqual(await fs.readFile(unchangedFile), before);
    assert.equal(notices.length, 3, 'only the three conflicts should request a decision');
  } finally {
    if (opened && vscode.window.activeTextEditor === opened) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function verifyReadonlyIdeQueries(vscode) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { buildSync } = require('esbuild');
  const output = buildSync({
    entryPoints: [path.resolve(__dirname, '../../../src/ide/query.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(
    require,
    loaded,
    loaded.exports
  );
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ide-host-')));
  const file = path.join(root, 'sample.piide');
  const uri = vscode.Uri.file(file);
  const selector = { scheme: 'file', pattern: '**/*.piide' };
  const disposables = [];
  let opened;
  const diagnostics = vscode.languages.createDiagnosticCollection('pi-ide-regression');
  disposables.push(diagnostics);
  try {
    await fs.writeFile(file, 'const value = missing;\nvalue;\n');
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(2, 0), '// unsaved fixture');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    disposables.push(
      vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(doc) {
          assert.equal(
            doc.isDirty,
            true,
            'language service must observe the existing dirty buffer'
          );
          return [
            new vscode.DocumentSymbol(
              'value',
              '',
              vscode.SymbolKind.Variable,
              new vscode.Range(0, 0, 1, 6),
              new vscode.Range(0, 6, 0, 11)
            ),
          ];
        },
      })
    );
    disposables.push(
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition() {
          return [
            {
              targetUri: uri,
              targetRange: new vscode.Range(0, 0, 0, 22),
              targetSelectionRange: new vscode.Range(0, 6, 0, 11),
            },
          ];
        },
      })
    );
    disposables.push(
      vscode.languages.registerReferenceProvider(selector, {
        provideReferences() {
          return [
            new vscode.Location(uri, new vscode.Position(0, 6)),
            new vscode.Location(uri, new vscode.Position(1, 0)),
          ];
        },
      })
    );
    diagnostics.set(uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 14, 0, 21),
        'Fixture missing name',
        vscode.DiagnosticSeverity.Error
      ),
    ]);
    const countTabs = () =>
      vscode.window.tabGroups.all.reduce((total, group) => total + group.tabs.length, 0);
    const before = countTabs();
    const query = (request) =>
      loaded.exports.runIdeQuery(root, request, new AbortController().signal, () => true);
    const problems = await query({ operation: 'diagnostics', path: 'sample.piide' });
    assert.equal(problems.status, 'ok');
    assert.equal(problems.locations[0].message, 'Fixture missing name');
    const symbols = await query({ operation: 'document_symbols', path: 'sample.piide' });
    assert.equal(symbols.locations[0].name, 'value');
    const definitions = await query({
      operation: 'definitions',
      path: 'sample.piide',
      line: 2,
      character: 1,
    });
    assert.deepEqual(definitions.locations, [{ path: 'sample.piide', line: 1, character: 7 }]);
    const references = await query({
      operation: 'references',
      path: 'sample.piide',
      line: 2,
      character: 1,
    });
    assert.equal(references.locations.length, 2);
    assert.equal(countTabs(), before, 'background IDE queries must never open editor tabs');
    await loaded.exports.openIdeLocation(root, definitions.locations[0]);
    opened = vscode.window.activeTextEditor;
    assert.equal(opened.document.uri.toString(), uri.toString());
    assert.equal(opened.selection.active.line, 0);
    assert.equal(opened.selection.active.character, 6);
  } finally {
    for (const disposable of disposables) disposable.dispose();
    if (opened && vscode.window.activeTextEditor === opened) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('mr-narender.pi');
  assert.ok(extension, 'extension not found');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    'piRpc.prompt',
    'piRpc.showModels',
    'piRpc.newSession',
    'piRpc.switchSession',
    'piRpcInternal.start',
    'piRpcInternal.openChat',
    'piRpc.commandPalette',
    'piRpc.explainSelection',
    'piRpc.fixSelection',
    'piRpc.refactorSelection',
    'piRpcInternal.showHelp',
  ]) {
    assert.ok(commands.includes(id), `missing registered command ${id}`);
  }

  const all = extension.packageJSON.contributes.commands.map((command) => command.command);
  for (const id of [
    'piRpcInternal.switchToFullChat',
    'piRpcInternal.showChatInSidebar',
    'piRpcInternal.showChatList',
    'piRpc.openSidebarChat',
  ])
    assert.ok(!commands.includes(id), `removed sidebar conversation command ${id}`);
  assert.ok(all.includes('piRpc.prompt'));
  assert.ok(!all.some((id) => /^piRpc\.(inspect|extensionUi)/.test(id)));
  assert.ok(all.includes('piRpc.newSession'));
  assert.ok(all.includes('piRpc.switchSession'));

  const views = extension.packageJSON.contributes.views.piRpc.map((view) => view.id);
  assert.deepEqual(views, ['piRpc.chat']);
  const viewTitle = extension.packageJSON.contributes.menus['view/title'];
  const agentic = viewTitle.filter((item) => item.when === 'view == piRpc.chat');
  assert.deepEqual(
    agentic.map((item) => item.command || item.submenu),
    ['piRpc.newSession', 'piRpc.agenticActions']
  );
  assert.ok(extension.packageJSON.contributes.menus['piRpc.agenticActions'].length > 0);
  assert.equal(
    extension.packageJSON.contributes.configuration.properties['piRpc.followAgent'].default,
    'off'
  );
  assert.ok(!commands.includes('piRpc.toggleSidebarMode'));
  assert.ok(!extension.packageJSON.contributes.configuration.properties['piRpc.sidebarMode']);
  assert.ok(
    !extension.packageJSON.contributes.configuration.properties['piRpc.editorTabs.enabled']
  );

  const customEditor = extension.packageJSON.contributes.customEditors.find(
    (item) => item.viewType === 'piRpc.chatEditor'
  );
  assert.ok(customEditor, 'missing pi chat custom editor contribution');

  const editorTitleMenu = extension.packageJSON.contributes.menus['editor/title'];
  assert.ok(editorTitleMenu.some((item) => item.command === 'piRpcInternal.openChat'));
  assert.ok(editorTitleMenu.some((item) => item.command === 'piRpc.newSession'));

  const allMenus = JSON.stringify(extension.packageJSON.contributes.menus ?? {});
  assert.ok(!allMenus.includes('piRpc.currentChat'));

  // showHelp opens a modal popover; the test harness refuses modal dialogs, so
  // just assert the command is registered (checked above) rather than invoking it.

  // Regression: opening a pi-chat custom editor must resolve (not hang on a
  // permanent loading indicator). This proves a FileSystemProvider is
  // registered for the pi-chat scheme so vscode.openWith can back the editor.
  if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
    // Regression: opening the pi-chat custom editor must resolve quickly. It
    // hung indefinitely when postSnapshot awaited webview.postMessage inside
    // resolveCustomEditor (channel not established until resolve returns).
    let openWithOutcome = 'pending';
    await Promise.race([
      Promise.resolve(vscode.commands.executeCommand('piRpcInternal.openChat'))
        .then(() => {
          openWithOutcome = 'ok';
        })
        .catch((error) => {
          openWithOutcome = `error: ${error && error.message ? error.message : String(error)}`;
        }),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
    assert.equal(openWithOutcome, 'ok', `openWith outcome: ${openWithOutcome}`);
    const hasChatTab = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => tab.input && tab.input.viewType === 'piRpc.chatEditor')
    );
    assert.ok(hasChatTab, 'no pi-chat editor tab was opened');
  }
  await verifyReadonlyIdeQueries(vscode);
  await verifySafeUndo(vscode);
}

module.exports = { run };
