const assert = require('node:assert/strict');

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
    'piRpc.toggleAdvancedMode',
    'piRpcInternal.showHelp',
    'piRpc.extensionUi.setTitle',
    'piRpc.extensionUiLocal.setTheme',
  ]) {
    assert.ok(commands.includes(id), `missing registered command ${id}`);
  }

  const all = extension.packageJSON.contributes.commands.map((command) => command.command);
  assert.ok(all.includes('piRpc.prompt'));
  assert.ok(all.includes('piRpc.extensionUiLocal.setTheme'));
  assert.ok(all.includes('piRpc.newSession'));
  assert.ok(all.includes('piRpc.switchSession'));

  const views = extension.packageJSON.contributes.views.piRpc.map((view) => view.id);
  assert.deepEqual(views, ['piRpc.sessions']);

  const customEditor = extension.packageJSON.contributes.customEditors.find(
    (item) => item.viewType === 'piRpc.chatEditor'
  );
  assert.ok(customEditor, 'missing pi chat custom editor contribution');

  const editorTitleMenu = extension.packageJSON.contributes.menus['editor/title'];
  assert.ok(editorTitleMenu.some((item) => item.command === 'piRpcInternal.openChat'));
  assert.ok(editorTitleMenu.some((item) => item.command === 'piRpc.newSession'));

  const allMenus = JSON.stringify(extension.packageJSON.contributes.menus ?? {});
  assert.ok(!allMenus.includes('piRpc.currentChat'));

  const advancedMode = await vscode.commands.executeCommand('piRpc.toggleAdvancedMode');
  assert.equal(advancedMode, 'advanced');
  const simpleMode = await vscode.commands.executeCommand('piRpc.toggleAdvancedMode');
  assert.equal(simpleMode, 'simple');

  // showHelp opens a modal popover; the test harness refuses modal dialogs, so
  // just assert the command is registered (checked above) rather than invoking it.

  const themeResult = await vscode.commands.executeCommand('piRpc.extensionUiLocal.setTheme');
  assert.equal(themeResult.success, false);

  const toolsExpanded = await vscode.commands.executeCommand(
    'piRpc.extensionUiLocal.getToolsExpanded'
  );
  assert.equal(toolsExpanded, false);

  const editorText = await vscode.commands.executeCommand('piRpc.extensionUiLocal.getEditorText');
  assert.equal(editorText, '');

  // Regression: opening a pi-chat custom editor must resolve (not hang on a
  // permanent loading indicator). This proves a FileSystemProvider is
  // registered for the pi-chat scheme so vscode.openWith can back the editor.
  if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
    const folderUri = vscode.workspace.workspaceFolders[0].uri.toString();
    const seg = Buffer.from(folderUri, 'utf8').toString('base64url');
    const chatUri = vscode.Uri.from({ scheme: 'pi-chat', path: `/${seg}/draft.chat` });
    // Regression: opening the pi-chat custom editor must resolve quickly. It
    // hung indefinitely when postSnapshot awaited webview.postMessage inside
    // resolveCustomEditor (channel not established until resolve returns).
    let openWithOutcome = 'pending';
    await Promise.race([
      Promise.resolve(
        vscode.commands.executeCommand('vscode.openWith', chatUri, 'piRpc.chatEditor', {
          preview: false,
          preserveFocus: false,
        })
      )
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
}

module.exports = { run };
