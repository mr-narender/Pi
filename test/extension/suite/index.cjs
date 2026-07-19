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
    'piRpc.extensionUi.setTitle',
    'piRpc.extensionUiLocal.setTheme',
  ]) {
    assert.ok(commands.includes(id), `missing registered command ${id}`);
  }

  const all = extension.packageJSON.contributes.commands.map((command) => command.command);
  assert.ok(all.includes('piRpc.prompt'));
  assert.ok(all.includes('piRpc.extensionUiLocal.setTheme'));

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
