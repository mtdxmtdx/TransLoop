import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayView } from "./OverlayView";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayView />
  </React.StrictMode>,
);
