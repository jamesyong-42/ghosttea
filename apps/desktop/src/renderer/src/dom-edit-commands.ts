export type DomEditCommand = "copy" | "paste" | "select-all";

interface ClipboardBridge {
  readClipboard: () => string | Promise<string>;
  writeClipboard: (text: string) => void;
}

function isTextControl(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function copyDocumentSelection(clipboard: ClipboardBridge): void {
  const text = window.getSelection()?.toString() ?? "";
  if (text) clipboard.writeClipboard(text);
}

/**
 * Preserve native-looking edit behavior for ordinary DOM controls after the
 * main process has claimed an application edit accelerator. Terminal inputs
 * deliberately opt out because their owning TerminalSurface handles it.
 */
export async function handleDomEditCommand(command: DomEditCommand, clipboard: ClipboardBridge): Promise<void> {
  const active = document.activeElement;
  if (active?.classList.contains("terminal-input")) return;

  if (isTextControl(active)) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start === null || end === null) {
      if (command === "copy") copyDocumentSelection(clipboard);
      return;
    }

    if (command === "copy") {
      const text = active.value.slice(start, end);
      if (text) clipboard.writeClipboard(text);
    } else if (command === "paste") {
      const text = await clipboard.readClipboard();
      if (!text) return;
      active.setRangeText(text, start, end, "end");
      active.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      active.select();
    }
    return;
  }

  if (command === "copy") {
    copyDocumentSelection(clipboard);
  } else if (command === "paste" && active instanceof HTMLElement && active.isContentEditable) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const text = await clipboard.readClipboard();
    if (!text) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  } else if (command === "select-all") {
    const range = document.createRange();
    range.selectNodeContents(active instanceof HTMLElement && active.isContentEditable ? active : document.body);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}
