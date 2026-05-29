import React from "react";
import ReactDOM from "react-dom/client";
import { CaptureView } from "./CaptureView";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CaptureView />
  </React.StrictMode>,
);
