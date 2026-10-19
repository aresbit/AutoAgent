import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ensureSessionCookie, getLaunchToken, initLaunchToken } from "./api/client";
import { setFileAuthToken } from "./features/files/fileClient";
import { App } from "./app/App";
import { Providers } from "./app/providers";
import { signalRendererReady } from "./lib/native";
import "./styles/index.css";

initLaunchToken();
// The file client also accepts the HttpOnly cookie; the explicit token covers
// the query-parameter bootstrap path before the cookie round-trip completes.
setFileAuthToken(getLaunchToken());
void ensureSessionCookie().catch(() => undefined);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
document.getElementById("boot-placeholder")?.remove();

createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);

// First-paint checkpoint for the desktop startup timeline.
requestAnimationFrame(() => signalRendererReady());
