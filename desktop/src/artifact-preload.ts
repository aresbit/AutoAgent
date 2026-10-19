import { contextBridge } from 'electron'

/**
 * Minimal preload for the artifact child window.
 *
 * Deliberately exposes no IPC, filesystem, exec or main-bridge surface.  The
 * artifact document is untrusted; it only gets a read-only version marker so
 * pages can detect the desktop host.
 */
const api = Object.freeze({ version: 1 as const })

contextBridge.exposeInMainWorld('autoagentArtifact', api)

export type AutoAgentArtifactApi = typeof api
