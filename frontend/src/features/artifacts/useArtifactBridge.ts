import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import {
  ArtifactToolBridge,
  parseFrameMessage,
  sendToFrame,
  type ConsentDecision,
  type FrameRef,
  type ParsedToolCall,
} from "./bridge";

export interface ArtifactBridgeState {
  pendingConsent: ParsedToolCall | null;
  consentBusy: boolean;
  consentError: string | null;
  decideConsent: (decision: ConsentDecision) => void;
}

export interface UseArtifactBridgeOptions {
  /** The main preview frame and, when comparing, both split frames. */
  frames: readonly FrameRef[];
  artifactId: string | null;
  mcpTools: readonly string[];
  allowExternal?: boolean;
  enabled?: boolean;
  /** Reset the 20-call quota when the conversation turn changes. */
  turnKey?: string | null;
}

/**
 * Wire the artifact frames to the local backend. The hook owns consent state
 * and the per-turn quota; `bridge.ts` owns the protocol and validation.
 */
export function useArtifactBridge({
  frames,
  artifactId,
  mcpTools,
  enabled = true,
  turnKey = null,
}: UseArtifactBridgeOptions): ArtifactBridgeState {
  const framesRef = useRef(frames);
  framesRef.current = frames;

  const [pendingConsent, setPendingConsent] = useState<ParsedToolCall | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const pendingRef = useRef<ParsedToolCall | null>(null);
  const resolverRef = useRef<((decision: ConsentDecision) => void) | null>(null);

  const requestConsent = useCallback(
    (request: ParsedToolCall): Promise<ConsentDecision> =>
      new Promise<ConsentDecision>((resolve) => {
        // Only one prompt at a time. A concurrent call is denied rather than
        // silently inheriting the answer to a different request.
        if (pendingRef.current) {
          resolve("deny");
          return;
        }
        pendingRef.current = request;
        resolverRef.current = resolve;
        setConsentError(null);
        setPendingConsent(request);
      }),
    [],
  );

  const callTool = useCallback(
    (input: Parameters<typeof api.artifactToolCall>[1]) =>
      artifactId
        ? api.artifactToolCall(artifactId, input)
        : Promise.reject(new Error("No artifact is open.")),
    [artifactId],
  );

  // Read the allowlist lazily so persisting a capability does not recreate the
  // bridge and lose its quota and in-memory "always allow" grants.
  const mcpToolsRef = useRef(mcpTools);
  mcpToolsRef.current = mcpTools;

  const bridge = useMemo(
    () =>
      new ArtifactToolBridge({
        allowedTools: () => mcpToolsRef.current,
        callTool,
        requestConsent,
      }),
    [callTool, requestConsent],
  );

  useEffect(() => {
    bridge.beginTurn();
  }, [bridge, turnKey]);

  const denyPending = useCallback(() => {
    pendingRef.current = null;
    resolverRef.current?.("deny");
    resolverRef.current = null;
  }, []);

  // A closed/remounted frame must not leave a consent promise dangling.
  useEffect(() => {
    return () => {
      denyPending();
      setPendingConsent(null);
    };
  }, [denyPending, artifactId]);

  // "Always" is a session grant: the bridge keeps it in memory until the panel
  // closes. It does not silently rewrite the artifact's declared capabilities;
  // the allowlist is the artifact's explicit contract.
  const decideConsent = useCallback((decision: ConsentDecision) => {
    if (!pendingRef.current) return;
    pendingRef.current = null;
    resolverRef.current?.(decision);
    resolverRef.current = null;
    setPendingConsent(null);
    setConsentError(null);
    setConsentBusy(false);
  }, []);

  useEffect(() => {
    if (!enabled || !artifactId) return;
    const onMessage = (event: MessageEvent) => {
      const accepted = parseFrameMessage(event, framesRef.current);
      if (!accepted) return;
      void bridge.handle(accepted.request, (message) => {
        sendToFrame(accepted.frameWindow, message);
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifactId, bridge, enabled]);

  return {
    pendingConsent,
    consentBusy,
    consentError,
    decideConsent,
  };
}
