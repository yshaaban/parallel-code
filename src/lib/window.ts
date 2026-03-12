import { IPC } from '../../electron/ipc/channels';
import type { Position, Size } from '../domain/renderer-invoke';
import { invoke, isElectronRuntime, listen } from './ipc';

type UnlistenFn = () => void;

function browserPosition(): Position {
  return {
    x: window.screenX,
    y: window.screenY,
  };
}

function browserSize(): Size {
  return {
    width: window.outerWidth,
    height: window.outerHeight,
  };
}

class AppWindow {
  async isFocused(): Promise<boolean> {
    if (isElectronRuntime()) return invoke(IPC.WindowIsFocused);
    return document.hasFocus();
  }

  async isMaximized(): Promise<boolean> {
    if (isElectronRuntime()) return invoke(IPC.WindowIsMaximized);
    return (
      window.outerWidth >= window.screen.availWidth &&
      window.outerHeight >= window.screen.availHeight
    );
  }

  async setDecorations(_decorated: boolean): Promise<void> {}

  async setTitleBarStyle(_style: string): Promise<void> {}

  async minimize(): Promise<void> {
    if (isElectronRuntime()) await invoke(IPC.WindowMinimize);
  }

  async toggleMaximize(): Promise<void> {
    if (isElectronRuntime()) await invoke(IPC.WindowToggleMaximize);
  }

  async maximize(): Promise<void> {
    if (isElectronRuntime()) await invoke(IPC.WindowMaximize);
  }

  async unmaximize(): Promise<void> {
    if (isElectronRuntime()) await invoke(IPC.WindowUnmaximize);
  }

  async close(): Promise<void> {
    if (isElectronRuntime()) {
      await invoke(IPC.WindowClose);
      return;
    }
    window.close();
  }

  async hide(): Promise<void> {
    if (isElectronRuntime()) await invoke(IPC.WindowHide);
  }

  async setSize(size: Size): Promise<void> {
    if (isElectronRuntime()) {
      await invoke(IPC.WindowSetSize, {
        width: size.width,
        height: size.height,
      });
    }
  }

  async setPosition(pos: Position): Promise<void> {
    if (isElectronRuntime()) {
      await invoke(IPC.WindowSetPosition, {
        x: pos.x,
        y: pos.y,
      });
    }
  }

  async outerPosition(): Promise<Position> {
    if (isElectronRuntime()) return invoke(IPC.WindowGetPosition);
    return browserPosition();
  }

  async outerSize(): Promise<Size> {
    if (isElectronRuntime()) return invoke(IPC.WindowGetSize);
    return browserSize();
  }

  async startDragging(): Promise<void> {}

  async startResizeDragging(_direction: string): Promise<void> {}

  async onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<UnlistenFn> {
    if (isElectronRuntime()) {
      const offFocus = listen(IPC.WindowFocus, () => handler({ payload: true }));
      const offBlur = listen(IPC.WindowBlur, () => handler({ payload: false }));
      return () => {
        offFocus();
        offBlur();
      };
    }

    const onFocus = () => handler({ payload: true });
    const onBlur = () => handler({ payload: false });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }

  async onResized(handler: () => void): Promise<UnlistenFn> {
    if (isElectronRuntime()) return listen(IPC.WindowResized, handler);

    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('resize', handler);
    };
  }

  async onMoved(handler: () => void): Promise<UnlistenFn> {
    if (isElectronRuntime()) return listen(IPC.WindowMoved, handler);
    return () => {
      void handler;
    };
  }

  async onCloseRequested(
    handler: (event: { preventDefault: () => void }) => Promise<void> | void,
  ): Promise<UnlistenFn> {
    if (isElectronRuntime()) {
      return listen(IPC.WindowCloseRequested, () => {
        let prevented = false;
        const result = handler({
          preventDefault: () => {
            prevented = true;
          },
        });

        if (result instanceof Promise) {
          result
            .then(() => {
              if (!prevented) void invoke(IPC.WindowForceClose);
            })
            .catch((error) => {
              console.error('Close handler failed, force-closing:', error);
              void invoke(IPC.WindowForceClose);
            });
        } else if (!prevented) {
          void invoke(IPC.WindowForceClose);
        }
      });
    }

    return () => {
      void handler;
    };
  }
}

export const appWindow = new AppWindow();
