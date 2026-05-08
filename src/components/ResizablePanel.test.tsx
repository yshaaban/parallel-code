import { render, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { ResizablePanel, type ResizablePanelHandle } from './ResizablePanel';

describe('ResizablePanel', () => {
  it('clears the programmatic resize handle on unmount', async () => {
    const handles: Array<ResizablePanelHandle | undefined> = [];
    const result = render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        onHandle={(handle) => handles.push(handle)}
        children={[
          {
            id: 'panel-1',
            content: () => <div>Panel</div>,
          },
        ]}
      />
    ));

    await waitFor(() => {
      expect(handles.at(-1)?.resizeAll).toEqual(expect.any(Function));
    });

    result.unmount();

    expect(handles.at(-1)).toBeUndefined();
  });
});
