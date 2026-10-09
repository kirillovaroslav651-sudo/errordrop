import React from "react";
import ReactDOM from "react-dom/client";
import WebApp from "@twa-dev/sdk";
import App from "./App";
import "./styles.css";

// Инициализация Telegram WebApp: растягиваем на весь экран, тёмная тема, закрытие кнопки.
WebApp.ready();
WebApp.expand();
WebApp.setHeaderColor("#1c1030");
WebApp.setBackgroundColor("#12081f");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);