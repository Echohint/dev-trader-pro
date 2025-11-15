import React from 'react';
import ReactDOM from 'react-dom/client';
import MainApp from './App.jsx'; // Import the default export
import './index.css'; // Make sure this file exists (Vite creates it)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MainApp />
  </React.StrictMode>,
);