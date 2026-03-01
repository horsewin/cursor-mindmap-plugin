import * as vscode from 'vscode';

export class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'cursorMindmap.mindmapEditor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MindmapEditorProvider(context);

    const registrations = [
      vscode.window.registerCustomEditorProvider(
        MindmapEditorProvider.viewType,
        provider,
        { webviewOptions: { retainContextWhenHidden: true } }
      ),
      vscode.commands.registerCommand('cursorMindmap.exportSvg', () => {
        provider.activeWebview?.postMessage({ type: 'exportSvg' });
      }),
      vscode.commands.registerCommand('cursorMindmap.exportMarkdown', () => {
        provider.activeWebview?.postMessage({ type: 'exportMarkdown' });
      }),
    ];

    return vscode.Disposable.from(...registrations);
  }

  private activeWebview: vscode.Webview | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(document.uri, '..'),
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
    this.activeWebview = webviewPanel.webview;

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activeWebview = webviewPanel.webview;
      }
    });

    const updateWebview = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
      });
    };

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          updateWebview();
        }
      }
    );

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      if (this.activeWebview === webviewPanel.webview) {
        this.activeWebview = undefined;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'save': {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            message.text
          );
          await vscode.workspace.applyEdit(edit);
          break;
        }
        case 'saveSvg': {
          const uri = await vscode.window.showSaveDialog({
            filters: { 'SVG Files': ['svg'] },
            defaultUri: vscode.Uri.file(
              document.uri.fsPath.replace('.mindmap.md', '.svg')
            ),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(
              uri,
              Buffer.from(message.svg, 'utf-8')
            );
            vscode.window.showInformationMessage(`SVG exported to ${uri.fsPath}`);
          }
          break;
        }
        case 'saveMarkdown': {
          const uri = await vscode.window.showSaveDialog({
            filters: { 'Markdown Files': ['md'] },
            defaultUri: vscode.Uri.file(
              document.uri.fsPath.replace('.mindmap.md', '-export.md')
            ),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(
              uri,
              Buffer.from(message.markdown, 'utf-8')
            );
            vscode.window.showInformationMessage(
              `Markdown exported to ${uri.fsPath}`
            );
          }
          break;
        }
        case 'saveImage': {
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const assetsDir = vscode.Uri.joinPath(docDir, 'assets');
          try {
            await vscode.workspace.fs.stat(assetsDir);
          } catch {
            await vscode.workspace.fs.createDirectory(assetsDir);
          }
          const fileName = message.fileName as string;
          const fileUri = vscode.Uri.joinPath(assetsDir, fileName);
          const base64Data = (message.base64 as string).replace(/^data:[^;]+;base64,/, '');
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(base64Data, 'base64'));
          const webviewUri = webviewPanel.webview.asWebviewUri(fileUri).toString();
          webviewPanel.webview.postMessage({
            type: 'imageReady',
            nodeId: message.nodeId,
            relativePath: `assets/${fileName}`,
            webviewUri,
          });
          break;
        }
        case 'getImageUri': {
          const docDir = vscode.Uri.joinPath(document.uri, '..');
          const fileUri = vscode.Uri.joinPath(docDir, message.relativePath);
          const webviewUri = webviewPanel.webview.asWebviewUri(fileUri).toString();
          webviewPanel.webview.postMessage({
            type: 'imageUriResolved',
            relativePath: message.relativePath,
            webviewUri,
          });
          break;
        }
      }
    });

    updateWebview();

    // Send document info for image resolution
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const assetsBaseUri = webviewPanel.webview.asWebviewUri(docDir).toString();
    webviewPanel.webview.postMessage({
      type: 'setDocumentInfo',
      assetsBaseUri,
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const coreScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mindmap-core.js')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mindmap.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mindmap.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Mindmap Editor</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-add-child" title="Add Child (Tab)">+ Child</button>
    <button id="btn-add-sibling" title="Add Sibling (Cmd/Ctrl+Enter)">+ Sibling</button>
    <button id="btn-delete" title="Delete (Delete)">Delete</button>
    <button id="btn-collapse" title="Collapse/Expand (Space)">Collapse</button>
    <span class="separator"></span>
    <button id="btn-zoom-in" title="Zoom In (Ctrl++)">Zoom +</button>
    <button id="btn-zoom-out" title="Zoom Out (Ctrl+-)">Zoom -</button>
    <button id="btn-fit" title="Fit (Ctrl+0)">Fit</button>
    <span class="separator"></span>
    <button id="btn-export-svg" title="Export SVG">Export SVG</button>
    <button id="btn-export-md" title="Export Markdown">Export MD</button>
    <span class="separator"></span>
    <div class="view-toggle">
      <button id="btn-split" class="active" title="Split View (Markdown + Mindmap)">Split</button>
      <button id="btn-preview" title="Mindmap Only">Preview</button>
    </div>
    <button id="btn-lock" title="Lock (prevent editing)">Lock</button>
    <span class="node-count" id="node-count"></span>
  </div>
  <div id="main-content" class="mode-split">
    <div id="markdown-pane">
      <div id="search-bar" style="display:none;">
        <div class="search-row">
          <input id="search-input" type="text" placeholder="Search..." />
          <span id="search-count"></span>
          <button id="search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
          <button id="search-next" title="Next (Enter)">&#x25BC;</button>
          <button id="search-close" title="Close (Esc)">&times;</button>
        </div>
        <div id="replace-row" class="search-row" style="display:none;">
          <input id="replace-input" type="text" placeholder="Replace..." />
          <button id="replace-one" title="Replace">Replace</button>
          <button id="replace-all" title="Replace All">All</button>
        </div>
      </div>
      <div id="editor-wrapper">
        <div id="line-numbers" aria-hidden="true"></div>
        <div id="editor-highlight-area">
          <div id="highlight-backdrop" aria-hidden="true"></div>
          <textarea id="markdown-editor" spellcheck="false"></textarea>
        </div>
      </div>
    </div>
    <div id="divider"></div>
    <div id="canvas-container">
      <svg id="mindmap-svg"></svg>
    </div>
  </div>
  <div id="context-menu" class="context-menu" style="display:none;">
    <div class="context-menu-item" data-action="edit">Edit (F2)</div>
    <div class="context-menu-item" data-action="add-child">+ Child (Tab)</div>
    <div class="context-menu-item" data-action="add-sibling">+ Sibling (Cmd+Enter)</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="collapse">Collapse/Expand (Space)</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="delete">Delete</div>
  </div>
  <script nonce="${nonce}" src="${coreScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
