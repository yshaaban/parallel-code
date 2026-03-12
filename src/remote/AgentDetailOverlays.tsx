import { Show, type JSX } from 'solid-js';

interface AgentMissingDialogProps {
  onBack: () => void;
  open: boolean;
}

export function AgentMissingDialog(props: AgentMissingDialogProps): JSX.Element {
  return (
    <Show when={props.open}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Agent not found"
        style={{
          position: 'absolute',
          inset: '4px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          padding: '20px',
          background: 'rgba(11, 15, 20, 0.92)',
          animation: 'fadeIn 0.3s ease-out',
        }}
      >
        <div
          style={{
            width: 'min(100%, 320px)',
            padding: '24px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            'border-radius': '16px',
            color: 'var(--text-primary)',
            'text-align': 'center',
            animation: 'slideUp 0.3s ease-out',
          }}
        >
          <div
            style={{
              width: '40px',
              height: '40px',
              margin: '0 auto 14px',
              'border-radius': '50%',
              background: 'rgba(255, 95, 115, 0.1)',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="8" stroke="var(--danger)" stroke-width="1.5" />
              <path
                d="M7 7l6 6M13 7l-6 6"
                stroke="var(--danger)"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </div>
          <p style={{ 'font-size': '15px', 'font-weight': '600', 'margin-bottom': '8px' }}>
            Agent not found
          </p>
          <p
            style={{
              'font-size': '13px',
              color: 'var(--text-secondary)',
              'line-height': '1.5',
              'margin-bottom': '18px',
            }}
          >
            This agent is no longer available.
          </p>
          <button
            type="button"
            class="accent-btn tap-feedback"
            aria-label="Back to the agent list"
            onClick={() => props.onBack()}
            style={{
              background: 'var(--accent)',
              border: 'none',
              'border-radius': '10px',
              padding: '10px 20px',
              color: '#031018',
              cursor: 'pointer',
              'font-size': '13px',
              'font-weight': '600',
              'touch-action': 'manipulation',
              width: '100%',
            }}
          >
            Back to agents
          </button>
        </div>
      </div>
    </Show>
  );
}

interface AgentKillConfirmDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}

export function AgentKillConfirmDialog(props: AgentKillConfirmDialogProps): JSX.Element {
  return (
    <Show when={props.open}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Kill running agent"
        style={{
          position: 'absolute',
          inset: '4px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          padding: '20px',
          background: 'rgba(11, 15, 20, 0.92)',
          'z-index': '20',
          animation: 'fadeIn 0.2s ease-out',
        }}
      >
        <div
          style={{
            width: 'min(100%, 300px)',
            padding: '24px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            'border-radius': '16px',
            'text-align': 'center',
            animation: 'slideUp 0.2s ease-out',
          }}
        >
          <p
            style={{
              'font-size': '15px',
              'font-weight': '600',
              color: 'var(--text-primary)',
              'margin-bottom': '8px',
            }}
          >
            Kill this agent?
          </p>
          <p
            style={{
              'font-size': '13px',
              color: 'var(--text-secondary)',
              'margin-bottom': '18px',
            }}
          >
            This will terminate the running process.
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              class="surface-btn tap-feedback"
              aria-label="Cancel agent kill"
              onClick={() => props.onCancel()}
              style={{
                flex: '1',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                'border-radius': '10px',
                padding: '10px',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                'font-size': '13px',
                'touch-action': 'manipulation',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="danger-btn tap-feedback"
              aria-label="Confirm kill agent"
              onClick={() => props.onConfirm()}
              style={{
                flex: '1',
                background: 'var(--danger)',
                border: 'none',
                'border-radius': '10px',
                padding: '10px',
                color: '#fff',
                cursor: 'pointer',
                'font-size': '13px',
                'font-weight': '600',
                'touch-action': 'manipulation',
              }}
            >
              Kill
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

interface ScrollToBottomButtonProps {
  onScrollToBottom: () => void;
  open: boolean;
}

export function ScrollToBottomButton(props: ScrollToBottomButtonProps): JSX.Element {
  return (
    <Show when={props.open}>
      <button
        type="button"
        class="icon-btn tap-feedback"
        aria-label="Scroll terminal to the bottom"
        onClick={() => props.onScrollToBottom()}
        style={{
          position: 'absolute',
          bottom: '150px',
          right: '16px',
          width: '44px',
          height: '44px',
          'border-radius': '50%',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          'font-size': '16px',
          cursor: 'pointer',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'z-index': '10',
          'touch-action': 'manipulation',
          'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
          animation: 'fadeIn 0.2s ease-out',
        }}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 3v10M8 13l4-4M8 13l-4-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </Show>
  );
}
