import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setPricerClient } from './worker/client';
import { WorkerPricerClient } from './worker/realClient';
import './styles/theme.css';
import './styles/app.css';

setPricerClient(new WorkerPricerClient());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
