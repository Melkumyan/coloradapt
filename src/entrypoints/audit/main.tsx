import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@shared/ui';
import { App } from './App';
import './App.css';

const container = document.getElementById('app');
if (!container) throw new Error('Audit root element #app not found');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
