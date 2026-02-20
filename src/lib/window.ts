// Window management — wraps Electron window IPC calls.

export type Position = { x: number; y: number };
export type Size = { width: number; height: number };

type UnlistenFn = () => void;

class AppWindow {
  async isFocused(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(
      "__window_is_focused"
    ) as Promise<boolean>;
  }

  async isMaximized(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(
      "__window_is_maximized"
    ) as Promise<boolean>;
  }

  async setDecorations(_decorated: boolean): Promise<void> {
    // Set at BrowserWindow creation time in Electron — no-op
  }

  async setTitleBarStyle(_style: string): Promise<void> {
    // Set at BrowserWindow creation time in Electron — no-op
  }

  async minimize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_minimize");
  }

  async toggleMaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_toggle_maximize");
  }

  async maximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_maximize");
  }

  async unmaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_unmaximize");
  }

  async close(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_close");
  }

  async hide(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_hide");
  }

  async setSize(size: Size): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_set_size", {
      width: size.width,
      height: size.height,
    });
  }

  async setPosition(pos: Position): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_set_position", {
      x: pos.x,
      y: pos.y,
    });
  }

  async outerPosition(): Promise<Position> {
    return (await window.electron.ipcRenderer.invoke(
      "__window_get_position"
    )) as Position;
  }

  async outerSize(): Promise<Size> {
    return (await window.electron.ipcRenderer.invoke(
      "__window_get_size"
    )) as Size;
  }

  async startDragging(): Promise<void> {
    // Electron uses CSS -webkit-app-region: drag instead
  }

  async startResizeDragging(_direction: string): Promise<void> {
    // Electron handles resize natively with resizable: true
  }

  async onFocusChanged(
    handler: (event: { payload: boolean }) => void
  ): Promise<UnlistenFn> {
    const off1 = window.electron.ipcRenderer.on("__window_focus", () =>
      handler({ payload: true })
    );
    const off2 = window.electron.ipcRenderer.on("__window_blur", () =>
      handler({ payload: false })
    );
    return () => {
      off1();
      off2();
    };
  }

  async onResized(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_resized", handler);
  }

  async onMoved(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_moved", handler);
  }

  async onCloseRequested(
    handler: (event: { preventDefault: () => void }) => Promise<void> | void
  ): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_close_requested", () => {
      let prevented = false;
      const result = handler({
        preventDefault: () => {
          prevented = true;
        },
      });
      // Handle async handlers
      if (result instanceof Promise) {
        result.then(() => {
          if (!prevented) {
            window.electron.ipcRenderer.invoke("__window_force_close");
          }
        });
      } else if (!prevented) {
        window.electron.ipcRenderer.invoke("__window_force_close");
      }
    });
  }
}

export const appWindow = new AppWindow();
