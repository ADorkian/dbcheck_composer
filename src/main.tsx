import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { clearWorkspaceState } from './lib/storage';
import './styles.css';

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  resetWorkspace = () => {
    clearWorkspaceState();
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <main className="app-error-boundary">
          <section>
            <span>DbCheck Composer stopped before rendering</span>
            <h1>Recovered from a UI crash</h1>
            <p>{this.state.error.message || 'Unknown frontend error.'}</p>
            <div className="button-row">
              <button type="button" onClick={() => window.location.reload()}>Reload app</button>
              <button type="button" className="secondary" onClick={this.resetWorkspace}>Reset local workspace</button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
