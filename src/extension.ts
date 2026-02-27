import * as vscode from 'vscode';
import { MindmapEditorProvider } from './mindmapEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    MindmapEditorProvider.register(context)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorMindmap.newMindmap', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter mindmap file name',
        placeHolder: 'my-mindmap',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'File name is required';
          }
          return undefined;
        },
      });

      if (!name) {
        return;
      }

      const fileName = name.endsWith('.mindmap.md') ? name : `${name}.mindmap.md`;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);
      const content = Buffer.from('# Central Topic\n', 'utf-8');
      await vscode.workspace.fs.writeFile(uri, content);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'cursorMindmap.mindmapEditor');
    })
  );
}

export function deactivate() {}
