import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeOnceMock } = vi.hoisted(() => ({ invokeOnceMock: vi.fn() }));

vi.mock('../lib/ipc', () => ({ invokeOnce: invokeOnceMock }));

beforeEach(() => {
  invokeOnceMock.mockReset();
  vi.resetModules();
});

describe('desktop task-notes capability advertisement', () => {
  it('shares and retains one valid immutable composition projection', async () => {
    invokeOnceMock.mockResolvedValue({ read: true, write: true });
    const { loadDesktopTaskNotesCapability } = await import('./desktop-task-notes-capability');

    const [first, second] = await Promise.all([
      loadDesktopTaskNotesCapability(),
      loadDesktopTaskNotesCapability(),
    ]);

    expect(first).toEqual({ read: true, write: true });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(invokeOnceMock).toHaveBeenCalledOnce();
    expect(await loadDesktopTaskNotesCapability()).toBe(first);
    expect(invokeOnceMock).toHaveBeenCalledOnce();
  });

  it('fails dark on transport or shape errors and permits a later retry', async () => {
    invokeOnceMock
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce({ read: true, write: true, forged: true })
      .mockResolvedValueOnce({ read: false, write: true })
      .mockResolvedValueOnce({ read: true, write: false });
    const { loadDesktopTaskNotesCapability } = await import('./desktop-task-notes-capability');

    await expect(loadDesktopTaskNotesCapability()).resolves.toEqual({ read: false, write: false });
    await expect(loadDesktopTaskNotesCapability()).resolves.toEqual({ read: false, write: false });
    await expect(loadDesktopTaskNotesCapability()).resolves.toEqual({ read: false, write: false });
    const readOnly = await loadDesktopTaskNotesCapability();
    expect(readOnly).toEqual({ read: true, write: false });
    expect(await loadDesktopTaskNotesCapability()).toBe(readOnly);
    expect(invokeOnceMock).toHaveBeenCalledTimes(4);
  });
});
