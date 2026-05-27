"use client";

/**
 * TranscriptPanel — live interview transcript with AssemblyAI realtime transcription.
 *
 * Transcription strategy (in priority order):
 *
 *  1. AssemblyAI realtime mode  — when an embedded LiveKit room is active
 *     (detected via LiveKitContext), audio is captured from the room's
 *     MediaStreamTrack objects using the Web Audio API (AudioContext +
 *     ScriptProcessorNode) and streamed as raw PCM16 to AssemblyAI's
 *     realtime WebSocket API.  This approach:
 *     - Works despite Chrome's WebRTC AEC (no MediaRecorder → Whisper
 *       round-trips with 4-second latency).
 *     - Captures BOTH the interviewer's local audio track AND the
 *       candidate's remote audio track(s), giving full bilateral
 *       transcription with proper speaker labels.
 *     - Uses short-lived session tokens (issued by AIRIS backend) so the
 *       raw AssemblyAI API key is never exposed to the browser.
 *     - Delivers interim (partial) transcripts within ~200 ms and final
 *       confirmed segments in 1–2 seconds.
 *
 *  2. Web Speech API fallback — used when no LiveKit room is present (e.g.
 *     external Google Meet / Zoom meeting, or a deployment without LiveKit).
 *     Captures the local microphone only via SpeechRecognition.
 *
 * Real-time updates:
 *   Both modes call `add_transcript_segment` on the backend, which
 *   broadcasts a `transcript_added` WebSocket event.  TranscriptPanel
 *   maintains its own WS connection to the copilot channel and appends new
 *   segments as they arrive, avoiding full re-fetches on every chunk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BotMessageSquare,
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  Radio,
  WifiOff,
} from "lucide-react";
import {
  addTranscriptSegment,
  getAssemblyAIToken,
  getTranscript,
  openCopilotWs,
  sendWsPing,
  startCopilotSession,
} from "@/lib/api/copilot";
import { useLiveKitRoom } from "@/contexts/LiveKitContext";
import { useAuthStore } from "@/store/auth-store";
import type { CopilotWsEvent, TranscriptSegment } from "@/lib/api/types";
import { Track, RoomEvent } from "livekit-client";
import type {
  LocalTrackPublication,
  RemoteTrackPublication,
  TrackPublication,
} from "livekit-client";

// ── Web Speech API type shims ─────────────────────────────────────────────
// The Web Speech API DOM types are not bundled in Next.js's default TS config.
// Declare minimal interfaces here rather than fighting tsconfig for a feature
// we only use as a non-LiveKit fallback.

interface SpeechRecognitionResultAlternative {
  readonly transcript: string;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionResultAlternative;
  [index: number]: SpeechRecognitionResultAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

// ── Speaker presentation ───────────────────────────────────────────────────

const SPEAKER_COLORS: Record<string, string> = {
  interviewer: "text-blue-700",
  candidate: "text-green-700",
  unknown: "text-gray-500",
};

const SPEAKER_LABELS: Record<string, string> = {
  interviewer: "Interviewer",
  candidate: "Candidate",
  unknown: "—",
};

// ── AssemblyAI track connection ────────────────────────────────────────────

/** Connection lifecycle for one AssemblyAI realtime WebSocket. */
type TrackConnection = {
  /** AudioContext driving the PCM capture pipeline. */
  audioCtx: AudioContext;
  /** Active WebSocket to AssemblyAI realtime endpoint. */
  ws: WebSocket;
};

/**
 * Aggregate transcription connection state (derived from all per-track WS states).
 *
 * connecting  — token fetch or WS handshake in progress
 * connected   — at least one track WS is open; waiting for speech
 * transcribing — partial transcript arrived (speaker is talking)
 * retrying    — unexpected WS close; reconnect is scheduled
 * disconnected — all tracks are gone / stopped intentionally
 */
type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "transcribing"
  | "retrying"
  | "disconnected";

/** Max auto-reconnect attempts per track before giving up. */
const MAX_RECONNECT_ATTEMPTS = 5;
/** Base delay (ms) for exponential backoff. Doubles each attempt, capped at 30 s. */
const RECONNECT_BASE_MS = 1_500;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a Float32Array of audio samples (range −1..+1) to an Int16Array
 * of PCM16 samples (range −32768..+32767) suitable for AssemblyAI's binary
 * WebSocket frames.
 */
function float32ToPcm16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

// ── Component ──────────────────────────────────────────────────────────────

export function TranscriptPanel({ interviewId }: { interviewId: string }) {
  const token = useAuthStore((s) => s.token);
  const liveKitRoomRef = useLiveKitRoom();

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notAvailable, setNotAvailable] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // "livekit" | "speech" | null  — which backend is currently active
  const [activeMode, setActiveMode] = useState<"livekit" | "speech" | null>(null);
  // Partial/interim transcript text from AssemblyAI (shown while speaker is talking)
  const [interimText, setInterimText] = useState<string>("");
  // Aggregate connection state derived from all per-track WS states
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");

  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Ref-based state so event handlers always see the latest value
  const micOnRef = useRef(false);
  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  // Tracks segment IDs we've already displayed to prevent WS / API duplicates
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Map of trackSid → TrackConnection — one AssemblyAI session per LiveKit track
  const trackConnectionsRef = useRef<Map<string, TrackConnection>>(new Map());

  // Per-track reconnect attempt counters
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());

  // Cleanup functions registered per track for LiveKit event handlers
  const liveKitCleanupRef = useRef<(() => void) | null>(null);

  // Web Speech API recognition instance (typed with local shim)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // WebSocket for real-time "transcript_added" push events from AIRIS backend
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Add segment helper (deduplicates by ID) ───────────────────────────

  const addSegment = useCallback((seg: TranscriptSegment) => {
    if (seenIdsRef.current.has(seg.id)) return;
    seenIdsRef.current.add(seg.id);
    setSegments((prev) => [...prev, seg]);
  }, []);

  // ── Load initial transcript ──────────────────────────────────────────

  const loadTranscript = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      else setRefreshing(true);
      try {
        await startCopilotSession(interviewId);
        const data = await getTranscript(interviewId, 200);
        // Replace full list (manual refresh or initial load) — reset seen IDs
        seenIdsRef.current = new Set(data.map((s) => s.id));
        setSegments(data);
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        if (status === 503 || status === 404 || status === 403) {
          setNotAvailable(true);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [interviewId]
  );

  useEffect(() => {
    void loadTranscript();
  }, [loadTranscript]);

  // Auto-scroll when new segments arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments]);

  // ── WebSocket for real-time updates from AIRIS backend ────────────────
  //
  // Connects after the session is confirmed ready.  Listens for
  // `transcript_added` events broadcast whenever a new segment is saved.
  // The segment data is embedded in the event so no re-fetch is needed.

  useEffect(() => {
    if (!token || notAvailable || loading) return;

    const ws = openCopilotWs(interviewId, token, {
      onOpen: () => {
        pingIntervalRef.current = setInterval(() => sendWsPing(ws), 25_000);
      },
      onEvent: (evt: CopilotWsEvent) => {
        if (evt.type === "transcript_added" && evt.data) {
          const seg = evt.data as unknown as TranscriptSegment;
          if (seg?.id && seg.content) {
            addSegment(seg);
          }
        }
      },
      onClose: () => {
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      },
      onError: () => {
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      },
    });
    wsRef.current = ws;

    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      ws.close();
      wsRef.current = null;
    };
  }, [token, interviewId, notAvailable, loading, addSegment]);

  // ── Stop all transcription on unmount ────────────────────────────────

  useEffect(() => {
    return () => {
      liveKitCleanupRef.current?.();
      recognitionRef.current?.stop();
    };
  }, []);

  // ── Connection status helpers ─────────────────────────────────────────

  /** Recompute aggregate status based on live track count. */
  const refreshConnectionStatus = useCallback(
    (override?: ConnectionStatus) => {
      if (override) {
        setConnectionStatus(override);
        return;
      }
      const count = trackConnectionsRef.current.size;
      setConnectionStatus(count > 0 ? "connected" : "disconnected");
    },
    []
  );

  // ── AssemblyAI PCM capture for a single LiveKit track ─────────────────
  //
  // Opens one AssemblyAI realtime WebSocket per audio track.
  //
  // Audio pipeline:
  //   MediaStreamTrack → AudioContext (16 kHz) → MediaStreamSource
  //     → ScriptProcessorNode (4096 frames ≈ 256 ms)
  //     → float32ToPcm16() → ArrayBuffer
  //     → AssemblyAI WS (binary)
  //
  // The ScriptProcessor is connected to a silent MediaStreamDestination so
  // no audio plays through the system speakers and no feedback occurs.
  //
  // Auto-reconnect: on unexpected WS close, we wait for an exponentially
  // increasing delay (up to MAX_RECONNECT_ATTEMPTS) before re-opening.
  //
  // Returns a cleanup function that closes the WS and AudioContext.

  const startTrackTranscription = useCallback(
    async (
      mediaStreamTrack: MediaStreamTrack,
      speaker: "interviewer" | "candidate",
      trackSid: string,
    ): Promise<(() => void) | null> => {
      if (trackConnectionsRef.current.has(trackSid)) return null;

      // Guard flag — set to true by the cleanup return function to prevent
      // double-cleanup: the onclose handler won't run teardown logic or
      // attempt reconnect after an intentional stop.
      let tornDown = false;

      // Mark as connecting so the status bar updates immediately
      setConnectionStatus("connecting");

      // ── 1. Get session token from AIRIS backend ───────────────────────
      let sessionToken: string;
      try {
        const result = await getAssemblyAIToken(interviewId);
        sessionToken = result.token;
      } catch {
        // Non-fatal per track — fall back to "disconnected"
        refreshConnectionStatus();
        return null;
      }

      // If transcription was stopped while we were awaiting the token, abort.
      if (!micOnRef.current) return null;
      // If the track is already being handled (race condition), abort.
      if (trackConnectionsRef.current.has(trackSid)) return null;

      // ── 2. Create AudioContext at 16 kHz (AssemblyAI requirement) ─────
      let audioCtx: AudioContext;
      try {
        audioCtx = new AudioContext({ sampleRate: 16_000 });
      } catch {
        refreshConnectionStatus();
        return null; // Browser doesn't support custom sample rates (very rare)
      }

      const stream = new MediaStream([mediaStreamTrack]);
      const source = audioCtx.createMediaStreamSource(stream);

      // ScriptProcessor: 4096 frames, 1 input channel, 1 output channel.
      // Deprecated but universally supported; AudioWorklet needs a Worker file.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      // Connect to a silent destination — keeps the graph active without
      // sending audio to system speakers (prevents echo / double-playback).
      const silentDest = audioCtx.createMediaStreamDestination();
      source.connect(processor);
      processor.connect(silentDest);

      // ── 3. Open AssemblyAI Universal Streaming v3 WebSocket ──────────
      // Endpoint: wss://streaming.assemblyai.com/v3/ws
      // Auth:     ?token=API_KEY  (browsers cannot set custom WS headers)
      // Format:   pcm_s16le at 16 kHz, sent as binary ArrayBuffer frames.
      const assemblyWs = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate_hertz=16000&encoding=pcm_s16le&token=${encodeURIComponent(sessionToken)}`
      );

      const conn: TrackConnection = { audioCtx, ws: assemblyWs };
      trackConnectionsRef.current.set(trackSid, conn);

      // ── 4. Stream PCM16 to AssemblyAI ─────────────────────────────────
      processor.onaudioprocess = (e) => {
        if (!micOnRef.current) return;
        if (assemblyWs.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const pcm16 = float32ToPcm16(float32);
        assemblyWs.send(pcm16.buffer);
      };

      // ── 5. Handle transcript events from AssemblyAI v3 ──────────────
      //
      // v3 Universal Streaming protocol:
      //   {"type":"Begin", ...}                    — session ready
      //   {"type":"Turn", "transcript":"...",
      //    "end_of_turn":false, ...}               — partial (speaker still talking)
      //   {"type":"Turn", "transcript":"...",
      //    "end_of_turn":true, ...}                — final (silence detected)
      //   {"type":"Termination", ...}              — session closed

      assemblyWs.onopen = () => {
        reconnectAttemptsRef.current.set(trackSid, 0);
        refreshConnectionStatus();
      };

      assemblyWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            transcript?: string;
            end_of_turn?: boolean;
          };

          if (msg.type === "Turn") {
            const text = (msg.transcript ?? "").trim();
            if (!text) return;

            if (!msg.end_of_turn) {
              // Partial — show while the speaker is still talking
              setInterimText(text);
              setConnectionStatus("transcribing");
            } else {
              // Final — save to backend and clear interim bar
              setInterimText("");
              setConnectionStatus(
                trackConnectionsRef.current.size > 0 ? "connected" : "disconnected"
              );

              // Persist to AIRIS backend → DB + WS broadcast → copilot context
              void (async () => {
                try {
                  const seg = await addTranscriptSegment(interviewId, {
                    speaker,
                    content: text,
                    source: "assemblyai",
                  });
                  addSegment(seg);
                } catch {
                  // Non-fatal: copilot WS broadcast will still deliver the segment
                }
              })();
            }
          }
          // type === "Begin"       → session ready, status already set in onopen
          // type === "Termination" → graceful shutdown, handled in onclose
        } catch {
          // Ignore malformed frames
        }
      };

      assemblyWs.onerror = () => {
        // Handled in onclose — onerror always precedes onclose
      };

      assemblyWs.onclose = (event) => {
        trackConnectionsRef.current.delete(trackSid);

        // Guard: skip teardown if the cleanup return function already ran.
        // tornDown=true means we nulled this handler, but be defensive.
        if (tornDown) {
          refreshConnectionStatus();
          return;
        }

        // Close AudioContext, guarding against already-closed state
        if (audioCtx.state !== "closed") {
          void audioCtx.close();
        }

        // Intentional close — nothing to do
        if (!micOnRef.current || event.code === 1000 || event.code === 1001) {
          refreshConnectionStatus();
          return;
        }

        // ── Unexpected disconnect: schedule reconnect with backoff ────────
        const attempts = reconnectAttemptsRef.current.get(trackSid) ?? 0;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(
            `[TranscriptPanel] AssemblyAI WS for track ${trackSid} failed after ` +
            `${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Giving up.`
          );
          setMicError(
            `Track lost connection (${speaker}) after ${MAX_RECONNECT_ATTEMPTS} retries. ` +
            "Stop and restart transcription to try again."
          );
          refreshConnectionStatus();
          return;
        }

        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, attempts),
          30_000
        );
        reconnectAttemptsRef.current.set(trackSid, attempts + 1);
        setConnectionStatus("retrying");
        console.info(
          `[TranscriptPanel] AssemblyAI WS for ${speaker} closed (code ${event.code}). ` +
          `Reconnecting in ${delay}ms (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})…`
        );

        setTimeout(() => {
          if (!micOnRef.current) return; // stopped while waiting
          void startTrackTranscription(mediaStreamTrack, speaker, trackSid);
        }, delay);
      };

      // ── 6. Return cleanup for this track ──────────────────────────────
      return () => {
        // Signal the onclose handler to skip teardown and reconnect logic.
        // This is an intentional stop, not an unexpected disconnect.
        tornDown = true;

        processor.disconnect();
        source.disconnect();

        // v3: send Terminate before closing so AssemblyAI can flush the last
        // partial turn and finalize it before the session ends.
        if (assemblyWs.readyState === WebSocket.OPEN) {
          try { assemblyWs.send(JSON.stringify({ type: "Terminate" })); } catch { /* ignore */ }
        }

        // Null out onclose BEFORE calling close() so the handler can't fire
        // and double-close the AudioContext or trigger a spurious reconnect.
        assemblyWs.onclose = null;

        // Guard: only close if the WS isn't already closed or closing
        if (
          assemblyWs.readyState === WebSocket.OPEN ||
          assemblyWs.readyState === WebSocket.CONNECTING
        ) {
          assemblyWs.close(1000, "transcription_stopped");
        }

        // Guard: only close AudioContext if it hasn't been closed already
        if (audioCtx.state !== "closed") {
          void audioCtx.close();
        }

        trackConnectionsRef.current.delete(trackSid);
        reconnectAttemptsRef.current.delete(trackSid);
      };
    },
    [interviewId, addSegment, refreshConnectionStatus]
  );

  // ── LiveKit AssemblyAI transcription (all participants) ───────────────
  //
  // Iterates existing tracks and attaches AssemblyAI sessions, then listens
  // for tracks that join/leave AFTER transcription starts.

  const startLiveKitTranscription = useCallback(async () => {
    const room = liveKitRoomRef.current;
    if (!room) {
      setMicError("Meeting room is not connected yet. Join the meeting first.");
      return;
    }

    setMicOn(true);
    setActiveMode("livekit");
    setMicError(null);

    // Track-level cleanup functions stored so we can tear everything down
    const trackCleanups = new Map<string, () => void>();

    const attachTrack = async (
      mediaStreamTrack: MediaStreamTrack,
      speaker: "interviewer" | "candidate",
      trackSid: string,
    ) => {
      const cleanup = await startTrackTranscription(
        mediaStreamTrack,
        speaker,
        trackSid,
      );
      if (cleanup) trackCleanups.set(trackSid, cleanup);
    };

    const detachTrack = (trackSid: string) => {
      trackCleanups.get(trackSid)?.();
      trackCleanups.delete(trackSid);
    };

    // Attach to tracks already present when transcription starts
    room.localParticipant.audioTrackPublications.forEach(
      (pub: LocalTrackPublication) => {
        if (pub.track?.mediaStreamTrack) {
          void attachTrack(
            pub.track.mediaStreamTrack,
            "interviewer",
            pub.trackSid,
          );
        }
      }
    );
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach(
        (pub: RemoteTrackPublication) => {
          if (pub.track?.mediaStreamTrack) {
            void attachTrack(
              pub.track.mediaStreamTrack,
              "candidate",
              pub.trackSid,
            );
          }
        }
      );
    });

    // ── Event handlers for tracks that arrive AFTER transcription starts ──

    const onTrackSubscribed = (_track: unknown, pub: TrackPublication) => {
      const t = pub.track;
      if (t?.kind === Track.Kind.Audio && t.mediaStreamTrack) {
        void attachTrack(t.mediaStreamTrack, "candidate", pub.trackSid);
      }
    };

    const onLocalTrackPublished = (pub: LocalTrackPublication) => {
      if (pub.track?.kind === Track.Kind.Audio && pub.track.mediaStreamTrack) {
        void attachTrack(
          pub.track.mediaStreamTrack,
          "interviewer",
          pub.trackSid,
        );
      }
    };

    const onTrackUnsubscribed = (_track: unknown, pub: TrackPublication) => {
      detachTrack(pub.trackSid);
    };

    const onLocalTrackUnpublished = (pub: LocalTrackPublication) => {
      detachTrack(pub.trackSid);
    };

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);

    // Store global cleanup so toggleMic can call it when stopping
    liveKitCleanupRef.current = () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      for (const cleanup of trackCleanups.values()) {
        cleanup();
      }
      trackCleanups.clear();
      setInterimText("");
    };
  }, [liveKitRoomRef, startTrackTranscription]);

  // ── Web Speech API fallback transcription ─────────────────────────────
  //
  // Used when no LiveKit room is present (external meeting mode).  Captures
  // the interviewer's local microphone via the browser's built-in STT engine.

  const startSpeechRecognition = useCallback(() => {
    const Ctor: SpeechRecognitionCtor | undefined =
      (typeof window !== "undefined" &&
        ((window as unknown as { SpeechRecognition?: SpeechRecognitionCtor })
          .SpeechRecognition ??
          (
            window as unknown as {
              webkitSpeechRecognition?: SpeechRecognitionCtor;
            }
          ).webkitSpeechRecognition)) ||
      undefined;

    if (!Ctor) {
      setMicError("Auto-transcription requires Chrome or Edge.");
      return;
    }

    setMicError(null);
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (!text) continue;
          void (async () => {
            try {
              const seg = await addTranscriptSegment(interviewId, {
                speaker: "interviewer",
                content: text,
                source: "speech",
              });
              addSegment(seg);
            } catch {
              // transcript still shown locally if WS event arrives
            }
          })();
        }
      }
    };

    r.onerror = (event) => {
      if (event.error === "no-speech") return;
      setMicOn(false);
      micOnRef.current = false;
      recognitionRef.current = null;
      setActiveMode(null);
      setMicError(
        event.error === "not-allowed"
          ? "Mic permission denied. Allow access and try again."
          : `Speech error: ${event.error}`
      );
    };

    r.onend = () => {
      if (micOnRef.current && recognitionRef.current) {
        // Small delay prevents rapid start/stop loops in some browser versions
        setTimeout(() => {
          try {
            r.start();
          } catch {
            /* already running or page hidden */
          }
        }, 150);
      }
    };

    r.start();
    recognitionRef.current = r;
    setActiveMode("speech");
    setMicOn(true);
  }, [interviewId, addSegment]);

  // ── Mic toggle ────────────────────────────────────────────────────────

  function toggleMic() {
    if (micOn) {
      // Stop all transcription
      liveKitCleanupRef.current?.();
      liveKitCleanupRef.current = null;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setMicOn(false);
      setActiveMode(null);
      setMicError(null);
      setInterimText("");
      setConnectionStatus("idle");
      reconnectAttemptsRef.current.clear();
      return;
    }

    // Prefer AssemblyAI realtime via LiveKit when the room is available
    if (liveKitRoomRef.current) {
      void startLiveKitTranscription();
    } else {
      startSpeechRecognition();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (notAvailable) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 py-10 text-center gap-2">
        <BotMessageSquare className="w-8 h-8 text-gray-300" />
        <p className="text-xs text-gray-500">
          AI Copilot is not enabled on this deployment.
        </p>
        <p className="text-[10px] text-gray-400">
          Transcript capture requires the Copilot feature.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-xs">Loading transcript…</span>
      </div>
    );
  }

  // ── Status bar configuration ─────────────────────────────────────────

  type StatusConfig = {
    bg: string;
    border: string;
    text: string;
    icon: React.ReactNode;
    label: string;
  };

  function getStatusConfig(): StatusConfig | null {
    if (micError) {
      return {
        bg: "bg-red-50",
        border: "border-red-200",
        text: "text-red-700",
        icon: <AlertCircle className="w-3 h-3 shrink-0" />,
        label: micError,
      };
    }
    if (!micOn) return null;

    if (activeMode === "livekit") {
      switch (connectionStatus) {
        case "connecting":
          return {
            bg: "bg-yellow-50",
            border: "border-yellow-200",
            text: "text-yellow-700",
            icon: <Loader2 className="w-3 h-3 shrink-0 animate-spin" />,
            label: "Connecting to AssemblyAI…",
          };
        case "retrying":
          return {
            bg: "bg-orange-50",
            border: "border-orange-200",
            text: "text-orange-700",
            icon: <RefreshCw className="w-3 h-3 shrink-0 animate-spin" />,
            label: "Connection lost — reconnecting…",
          };
        case "disconnected":
          return {
            bg: "bg-gray-50",
            border: "border-gray-200",
            text: "text-gray-600",
            icon: <WifiOff className="w-3 h-3 shrink-0" />,
            label: "Disconnected — no audio tracks detected",
          };
        case "transcribing":
          return {
            bg: "bg-blue-50",
            border: "border-blue-200",
            text: "text-blue-700",
            icon: <Radio className="w-3 h-3 shrink-0 animate-pulse" />,
            label: "Transcribing…",
          };
        case "connected":
        default:
          return {
            bg: "bg-green-50",
            border: "border-green-200",
            text: "text-green-700",
            icon: (
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
            ),
            label: "Listening (AssemblyAI realtime)",
          };
      }
    }

    // Speech API fallback
    return {
      bg: "bg-green-50",
      border: "border-green-200",
      text: "text-green-700",
      icon: (
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
      ),
      label: "Recording — your words will appear below automatically",
    };
  }

  const statusConfig = getStatusConfig();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-white">
        <span className="text-xs font-semibold text-gray-700">
          Live Transcript
          {segments.length > 0 && (
            <span className="ml-1.5 text-[10px] font-normal text-gray-400">
              ({segments.length} segment{segments.length !== 1 ? "s" : ""})
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          {/* Refresh */}
          <button
            onClick={() => void loadTranscript(true)}
            disabled={refreshing}
            title="Refresh transcript"
            className="p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-40 rounded"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            disabled={connectionStatus === "connecting"}
            title={
              micOn
                ? "Stop transcription"
                : liveKitRoomRef.current
                  ? "Start realtime transcription via AssemblyAI"
                  : "Start transcription (captures your microphone)"
            }
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
              micOn
                ? "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                : "bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200"
            }`}
          >
            {micOn ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            {micOn ? "Stop" : "Auto-transcribe"}
          </button>
        </div>
      </div>

      {/* Status / error bar */}
      {statusConfig && (
        <div
          className={`shrink-0 flex items-center gap-1.5 px-4 py-1.5 text-[11px] border-b ${statusConfig.bg} ${statusConfig.border} ${statusConfig.text}`}
        >
          {statusConfig.icon}
          {statusConfig.label}
        </div>
      )}

      {/* Interim (partial) transcript — shown while speaker is mid-sentence */}
      {interimText && (
        <div className="shrink-0 px-4 py-1.5 border-b border-gray-100 bg-amber-50">
          <p className="text-[11px] text-amber-700 italic leading-relaxed truncate">
            {interimText}
          </p>
        </div>
      )}

      {/* Transcript body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {segments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-gray-400">
            <Mic className="w-6 h-6 opacity-30" />
            <p className="text-xs">No transcript yet.</p>
            <p className="text-[10px] text-gray-400 max-w-[200px] leading-relaxed">
              {liveKitRoomRef.current
                ? "Click Auto-transcribe to capture meeting audio from all participants in real time."
                : "Click Auto-transcribe above to capture speech, or add segments from the AI Copilot tab."}
            </p>
          </div>
        ) : (
          segments.map((seg) => (
            <div key={seg.id} className="flex gap-2 text-xs">
              <span
                className={`shrink-0 font-semibold w-20 text-right pt-0.5 text-[10px] uppercase tracking-wide ${
                  SPEAKER_COLORS[seg.speaker] ?? "text-gray-500"
                }`}
              >
                {SPEAKER_LABELS[seg.speaker] ?? seg.speaker}
              </span>
              <span className="flex-1 text-gray-800 leading-relaxed">
                {seg.content}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Footer hint */}
      {segments.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-100 bg-gray-50">
          <p className="text-[10px] text-gray-400 leading-relaxed">
            This transcript is used automatically to generate the AI Summary
            after the interview completes.
          </p>
        </div>
      )}
    </div>
  );
}
