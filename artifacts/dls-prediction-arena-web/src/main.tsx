import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import './index.css';

import { setBaseUrl } from "@workspace/api-client-react";
setBaseUrl(import.meta.env.VITE_API_URL || "https://dls-prediction-arena.onrender.com");

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
