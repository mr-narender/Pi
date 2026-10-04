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
    'piRpcInternal.switchToFullChat',
    'piRpc.switchSession',
    'piRpcInternal.start',
    'piRpcInternal.openChat',
    'piRpc.commandPalette',
    'piRpc.explainSelection',
    'piRpc.fixSelection',
    'piRpc.refactorSelection',
    'piRpcInternal.showHelp',
    'piRpcInternal.showChatList',
  ]) {
    assert.ok(commands.includes(id), `missing registered command ${id}`);
  }

  const all = extension.packageJSON.contributes.commands.map((command) => command.command);
  assert.ok(all.includes('piRpc.prompt'));
  assert.ok(!all.some((id) => /^piRpc\.(inspect|extensionUi)/.test(id)));
  assert.ok(all.includes('piRpc.newSession'));
  assert.ok(all.includes('piRpc.switchSession'));

  const views = extension.packageJSON.contributes.views.piRpc.map((view) => view.id);
  assert.deepEqual(views, ['piRpc.chat']);
  const viewTitle = extension.packageJSON.contributes.menus['view/title'];
  const agentic = viewTitle.filter(
    (item) => item.when === 'view == piRpc.chat && piRpc.sidebarSurface == list'
  );
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
}

module.exports = { run };
