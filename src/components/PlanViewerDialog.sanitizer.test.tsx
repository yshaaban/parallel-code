import { render, screen, waitFor } from '@solidjs/testing-library';
import DOMPurify from 'dompurify';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PlanViewerDialog, resetPlanViewerDialogMermaidStateForTests } from './PlanViewerDialog';

type SanitizerHook = (currentNode: Node) => void;

describe('PlanViewerDialog sanitizer integration', () => {
  let getBBoxDescriptor: PropertyDescriptor | undefined;
  let sanitizerHook: SanitizerHook | undefined;

  beforeEach(() => {
    resetPlanViewerDialogMermaidStateForTests();
    getBBoxDescriptor = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ height: 20, width: 100, x: 0, y: 0 }),
    });
  });

  afterEach(() => {
    if (sanitizerHook) {
      DOMPurify.removeHook('uponSanitizeElement', sanitizerHook);
      sanitizerHook = undefined;
    }

    if (getBBoxDescriptor) {
      Object.defineProperty(SVGElement.prototype, 'getBBox', getBBoxDescriptor);
    } else {
      Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
    }
  });

  it('keeps Markdown safe and invokes the real lazy Mermaid sanitizer for hostile diagram markup', async () => {
    const observedUnsafeAttributes = new Set<string>();
    sanitizerHook = (currentNode) => {
      if (!(currentNode instanceof Element)) {
        return;
      }

      for (const attribute of currentNode.attributes) {
        if (attribute.name.startsWith('on') || /^javascript:/i.test(attribute.value)) {
          observedUnsafeAttributes.add(`${attribute.name}=${attribute.value}`);
        }
      }
    };
    DOMPurify.addHook('uponSanitizeElement', sanitizerHook);

    let setPlanContent!: (content: string) => void;
    render(() => {
      const [planContent, updatePlanContent] = createSignal(
        ['<img src=x onerror=alert(1)>', '', '[unsafe Markdown link](javascript:alert(2))'].join(
          '\n',
        ),
      );
      setPlanContent = updatePlanContent;

      return (
        <PlanViewerDialog
          open
          onClose={() => {}}
          planContent={planContent()}
          planFileName="plan.md"
        />
      );
    });

    expect(await screen.findByText('unsafe Markdown link')).toBeTruthy();

    const planContent = document.querySelector<HTMLElement>('.plan-markdown');
    expect(planContent?.querySelector('img')).toBeNull();
    expect(planContent?.querySelector('a')).toBeNull();
    expect(planContent?.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(observedUnsafeAttributes).toEqual(new Set());

    setPlanContent(
      [
        '```mermaid',
        'flowchart TD',
        '  A["<svg onload=alert(3)><a href=javascript:alert(4)>Safe</a></svg>"] --> B[Done]',
        '```',
      ].join('\n'),
    );

    await waitFor(
      () => {
        expect(
          document.querySelector('.plan-mermaid-block[data-mermaid-rendered="true"]'),
        ).not.toBeNull();
      },
      { timeout: 15_000 },
    );

    const mermaidBlock = document.querySelector<HTMLElement>(
      '.plan-mermaid-block[data-mermaid-rendered="true"]',
    );
    expect(observedUnsafeAttributes).toContain('onload=alert(3)');
    expect(observedUnsafeAttributes).toContain('href=javascript:alert(4)');
    expect(mermaidBlock?.textContent).toContain('Safe');
    expect(mermaidBlock?.innerHTML).not.toMatch(/onload\s*=|javascript:/i);
  }, 20_000);
});
