export {};

declare global {
  interface Window {
    desktop: {
      platform: string;
      writeClipboard: (text: string) => void;
      readClipboard: () => string;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      onMenuAction: (listener: (action: string) => void) => () => void;
    };
  }
}
