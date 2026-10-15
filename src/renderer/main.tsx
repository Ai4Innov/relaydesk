import React from "react";
import { createRoot } from "react-dom/client";
import { App, ErrorBoundary } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
);
