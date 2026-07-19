import type { ExtensionUiRequest } from '../rpc/protocol';
import type { SessionController } from '../sessions/sessionController';

export interface UnsupportedThemeResult {
  success: false;
  error: string;
}

export const LOCAL_THEME = Object.freeze({
  name: 'pi-rpc-local',
  mode: 'rpc',
});

export class LocalExtensionUiContext {
  public onTerminalInput(): { dispose(): void } {
    return { dispose() {} };
  }

  public setWorkingMessage(): void {}
  public setWorkingVisible(): void {}
  public setWorkingIndicator(): void {}
  public setHiddenThinkingLabel(): void {}
  public setFooter(): void {}
  public setHeader(): void {}
  public addAutocompleteProvider(): void {}
  public setEditorComponent(): void {}
  public setToolsExpanded(): void {}

  public async custom(): Promise<undefined> {
    return undefined;
  }

  public pasteToEditor(controller: SessionController, text: string): ExtensionUiRequest {
    const request: ExtensionUiRequest = {
      type: 'extension_ui_request',
      id: `local-paste-${Date.now()}`,
      method: 'set_editor_text',
      text,
    };
    controller.applyExtensionUiRequest(request);
    return request;
  }

  public getEditorText(): string {
    return '';
  }

  public getEditorComponent(): undefined {
    return undefined;
  }

  public get theme() {
    return LOCAL_THEME;
  }

  public getAllThemes(): [] {
    return [];
  }

  public getTheme(): undefined {
    return undefined;
  }

  public setTheme(): UnsupportedThemeResult {
    return {
      success: false,
      error: 'Themes are not switchable through Pi RPC VS Code compatibility mode.',
    };
  }

  public getToolsExpanded(): false {
    return false;
  }
}
