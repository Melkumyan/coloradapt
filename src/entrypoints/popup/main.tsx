import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './App.css';

const container = document.getElementById('app');
if (!container) throw new Error('Popup root element #app not found');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
