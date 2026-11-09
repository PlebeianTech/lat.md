import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { UsageApp } from './usage-app';
import './usage.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UsageApp />
  </StrictMode>,
);
