import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initLaunchToken } from "./api/client";
import { App } from "./app/App";
import { Providers } from "./app/providers";
import "./styles/index.css";

initLaunchToken();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
