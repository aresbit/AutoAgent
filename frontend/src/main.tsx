import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ensureSessionCookie, initLaunchToken } from "./api/client";
import { App } from "./app/App";
import { Providers } from "./app/providers";
import "./styles/index.css";

initLaunchToken();
void ensureSessionCookie().catch(() => undefined);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
