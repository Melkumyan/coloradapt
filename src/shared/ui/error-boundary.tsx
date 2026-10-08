import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

/**
 * The last line of defense of an extension page (popup, options, developer audit): a render or effect error
 * must leave a readable message, not a blank page. Only the error's name is logged (a diagnostic code), never
 * its message or the state of the page, which can hold what the audited page contained.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error('[ColorAdapt] diagnostic: ui-crashed', error.name);
  }

  override render(): JSX.Element | ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <h1>ColorAdapt</h1>
        <p role="alert">
          This page ran into a problem and stopped. Close it and open it again. Your settings are
          not affected.
        </p>
      </main>
    );
  }
}
