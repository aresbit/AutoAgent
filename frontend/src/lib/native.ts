export interface NativeFileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileRequest {
  title?: string;
  defaultPath?: string;
  filters?: NativeFileFilter[];
  directory?: boolean;
  multiple?: boolean;
}

export interface SaveFileRequest {
  title?: string;
  defaultPath?: string;
  filters?: NativeFileFilter[];
}

interface NativeBridge {
  dialogs: {
    openFile: (
      request?: OpenFileRequest,
    ) => Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile: (
      request?: SaveFileRequest,
    ) => Promise<{ canceled: boolean; filePath: string | null }>;
  };
  artifact?: {
    open: (artifactId: string, version?: string, title?: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    autoagentNative?: NativeBridge;
  }
}

export function nativeBridge(): NativeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.autoagentNative;
}

export async function chooseSavePath(
  request: SaveFileRequest,
): Promise<string | null> {
  const bridge = nativeBridge();
  if (!bridge) return null;
  const result = await bridge.dialogs.saveFile(request);
  return result.canceled ? null : result.filePath;
}

export async function chooseOpenPath(
  request: OpenFileRequest,
): Promise<string | null> {
  const bridge = nativeBridge();
  if (!bridge) return null;
  const result = await bridge.dialogs.openFile(request);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function openArtifactWindow(
  artifactId: string,
  version?: string,
  title?: string,
): Promise<boolean> | null {
  const bridge = nativeBridge();
  return bridge?.artifact ? bridge.artifact.open(artifactId, version, title) : null;
}
