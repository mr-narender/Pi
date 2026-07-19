const assert = require('node:assert/strict');

async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('local.pi-rpc-vscode');
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
  assert.ok(views.includes('piRpc.newChat'));
  assert.ok(views.includes('piRpc.resumeChat'));
  assert.ok(views.includes('piRpc.currentChat'));

  const advancedMode = await vscode.commands.executeCommand('piRpc.toggleAdvancedMode');
  assert.equal(advancedMode, 'advanced');
  const simpleMode = await vscode.commands.executeCommand('piRpc.toggleAdvancedMode');
  assert.equal(simpleMode, 'simple');

  const helpUri = await vscode.commands.executeCommand('piRpcInternal.showHelp');
  assert.ok(String(helpUri).endsWith('/README.md'));

  const themeResult = await vscode.commands.executeCommand('piRpc.extensionUiLocal.setTheme');
  assert.equal(themeResult.success, false);

  const toolsExpanded = await vscode.commands.executeCommand(
    'piRpc.extensionUiLocal.getToolsExpanded'
  );
  assert.equal(toolsExpanded, false);

  const editorText = await vscode.commands.executeCommand('piRpc.extensionUiLocal.getEditorText');
  assert.equal(editorText, '');
}

module.exports = { run };
