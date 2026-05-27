"use client";

/**
 * LiveKitContext
 *
 * Shares the active LiveKit Room instance (via a stable MutableRefObject)
 * between the video call component (LiveKitRoom) and the Transcript panel.
 *
 * Using a ref — not state — is intentional: we only need the Room for
 * imperative operations (subscribing to audio tracks), not for rendering.
 * Storing it in state would trigger unnecessary re-renders every time the
 * Room connects or disconnects.
 *
 * Usage:
 *   1. Wrap the interview workspace with <LiveKitProvider>.
 *   2. LiveKitRoom.tsx stores the connected Room in the ref.
 *   3. TranscriptPanel.tsx reads the ref when transcription starts.
 */

import { createContext, useContext, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Room } from "livekit-client";

// ── Context type ──────────────────────────────────────────────────────────────

type LiveKitContextValue = {
  /** Holds the active LiveKit Room, or null when no room is connected. */
  roomRef: MutableRefObject<Room | null>;
};

// Default value: a stable ref initialised to null.
// Using a plain object here avoids the need for a separate defaultRef variable.
const LiveKitContext = createContext<LiveKitContextValue>({
  // This default is only used when <LiveKitProvider> is absent from the tree.
  // In that case, roomRef.current remains null and TranscriptPanel falls back
  // to the Web Speech API.
  roomRef: { current: null },
});

// ── Provider ──────────────────────────────────────────────────────────────────

export function LiveKitProvider({ children }: { children: React.ReactNode }) {
  const roomRef = useRef<Room | null>(null);
  return (
    <LiveKitContext.Provider value={{ roomRef }}>
      {children}
    </LiveKitContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

/**
 * Returns a stable MutableRefObject<Room | null>.
 *
 * Read `.current` imperatively when you need the Room (e.g. inside a click
 * handler or a useEffect body).  Do NOT destructure `.current` in a render
 * expression — it won't trigger re-renders when the Room changes.
 */
export function useLiveKitRoom(): MutableRefObject<Room | null> {
  return useContext(LiveKitContext).roomRef;
}
