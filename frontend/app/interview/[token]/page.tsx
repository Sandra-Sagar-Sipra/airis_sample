"use client";

/**
 * AI Screening Interview — Candidate Room
 *
 * Full flow:
 *  1. Load session via GET /api/v1/ai-screenings/live/join/:token
 *  2. Show camera/mic preview + "Join Interview" button
 *  3. After join:
 *     a. Connect to LiveKit room (camera + mic)
 *     b. Connect to backend WebSocket: /api/v1/ai-screenings/ws/:id
 *     c. Get AssemblyAI realtime token from backend
 *     d. Connect to AssemblyAI streaming WebSocket for STT
 *  4. AI speaks first question via Web Speech API (window.speechSynthesis)
 *  5. Candidate speaks → AssemblyAI transcribes → transcript chunks sent to WS
 *  6. "Done answering" pressed → send end_answer → backend Groq → next question
 *  7. AI speaks next question aloud → repeat
 *  8. On interview_end received → show completion screen with summary
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Volume2,
  VolumeX,
  Send,
  Phone,
  PhoneOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  getLiveInterviewByToken,
  getAssemblyAIToken,
  type LiveInterview,
  type LiveInterviewMessage,
} from "@/lib/api/ai_screening";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState =
  | "loading"      // fetching session
  | "lobby"        // show camera/mic preview + Join button
  | "connecting"   // setting up WS + STT
  | "live"         // interview in progress
  | "ai_thinking"  // Groq generating next question
  | "completed"    // interview ended
  | "error";

// Scores/recommendations are shown only to recruiters — never to the candidate.
interface InterviewSummary {
  duration_seconds?: number | null;
}

// Per-question timing and recording data collected live in the browser.
interface QuestionSegment {
  question_number: number;
  question_text: string;
  transcript: string;
  question_start_seconds: number;
  answer_start_seconds: number | null;
  answer_end_seconds: number | null;
  duration_seconds: number | null;
  video_base64?: string; // base64-encoded WebM clip for this answer
}

// ── TTS speech gate ───────────────────────────────────────────────────────────
// When the AI speaks through the browser's speech synthesis API, the speaker
// output can bleed back into the microphone and be transcribed as candidate
// speech.  This module-level flag is checked in `onaudioprocess` — while the
// AI is speaking no audio is forwarded to AssemblyAI or the browser STT engine.

// Module-level flag — accessible by all functions in this file.
// Do NOT export: Next.js page files reject unexpected named exports.
let _aiSpeaking = false;

// ── Web Speech API TTS helper ─────────────────────────────────────────────────

function speak(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel(); // stop any current speech

  _aiSpeaking = true;   // gate microphone transcription

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.92;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  // Prefer a high-quality English voice
  const voices = synth.getVoices();
  const preferred = voices.find(
    (v) =>
      v.lang.startsWith("en") &&
      (v.name.includes("Google") || v.name.includes("Natural") || v.name.includes("Samantha"))
  );
  if (preferred) utterance.voice = preferred;

  utterance.onend = () => {
    // Wait 500 ms for echo tail to dissipate before re-enabling transcription
    setTimeout(() => { _aiSpeaking = false; }, 500);
    onEnd?.();
  };
  utterance.onerror = () => { _aiSpeaking = false; onEnd?.(); };

  // Safety fallback: Chrome sometimes never fires onend for long utterances.
  // Auto-release the gate after (text.length / 10) seconds max, capped at 30 s.
  const maxMs = Math.min(30_000, Math.max(5_000, text.length * 100));
  setTimeout(() => { _aiSpeaking = false; }, maxMs);

  synth.speak(utterance);
}

function stopSpeaking(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  _aiSpeaking = false;
}

// ── AssemblyAI realtime STT hook ──────────────────────────────────────────────

function useAssemblyAI(options: {
  token: string | null;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  active: boolean;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksSentRef = useRef(0);

  // FIX Bug 2 + Bug 3: accept token and wsUrl as explicit parameters so callers
  // can pass the live values from refs — options.token is always the value from
  // the render cycle when this callback was last created, which may be null.
  const start = useCallback(
    async (stream: MediaStream, tokenOverride?: string | null, wsUrlOverride?: string) => {
      // Use the explicitly passed token first; options.token is a stale render-time snapshot.
      const tok = tokenOverride ?? options.token;

      console.log("[AAI] start() called", {
        tokenProvided: !!tok,
        tokenLength: tok?.length ?? 0,
        wsAlreadyOpen: wsRef.current?.readyState === WebSocket.OPEN,
        streamId: stream.id,
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
        audioEnabled: stream.getAudioTracks()[0]?.enabled,
      });

      if (!tok || wsRef.current?.readyState === WebSocket.OPEN) {
        console.warn("[AAI] start() bailed early — no token or WS already open", { tok: !!tok });
        return;
      }

      // ── URL construction ──────────────────────────────────────────────────────
      // AssemblyAI v3 streaming requires ALL of these params in the query string:
      //   token        — temporary credential from the backend
      //   sample_rate  — MUST match the AudioContext sampleRate (16000)
      //   encoding     — MUST be pcm_s16le to match the Int16Array we send
      //
      // Without sample_rate and encoding the server uses its own defaults;
      // when the incoming audio doesn't match those defaults it closes with
      // code 3006 ("Message not accepted in current state" / format mismatch).
      //
      // The previous code only appended ?token=<tok> and omitted the other two
      // params — that was the root cause of every 3006 close.
      let finalUrl: string;
      if (wsUrlOverride) {
        // v3 base URL from backend has no query params — add all three here.
        finalUrl = `${wsUrlOverride}?token=${tok}&sample_rate=16000&encoding=pcm_s16le`;
      } else {
        // v2 legacy fallback — all params go in the URL, no begin message needed.
        finalUrl = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&encoding=pcm_s16le&token=${tok}`;
      }

      console.log("Creating AssemblyAI websocket", finalUrl.replace(/token=[^&]+/, "token=REDACTED"));
      console.log("Opening websocket");

      const aaiWs = new WebSocket(finalUrl);
      wsRef.current = aaiWs;
      chunksSentRef.current = 0;

      // sessionReady gates onaudioprocess so audio is never sent before the
      // server finishes its session setup and sends session_began.
      // Sending audio before session_began causes close code 3006.
      let sessionReady = false;

      aaiWs.onopen = () => {
        try {
          console.log("Websocket connected");
          // Do NOT send a begin/configure message for v3.
          //
          // The previous code sent {"type":"begin","encoding":"pcm_s16le","sample_rate":16000}
          // immediately in onopen. The v3 protocol does not have a client-initiated
          // begin message — audio format is declared in the URL query string.
          // Sending an unexpected text frame before session_began puts the server
          // into an error state and can also cause close code 3006.

          // ── AudioContext ───────────────────────────────────────────────────
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ACtx = window.AudioContext ?? (window as any).webkitAudioContext;
          if (!ACtx) {
            console.error("[AAI] AudioContext not available in this browser");
            return;
          }
          const ctx: AudioContext = new ACtx({ sampleRate: 16000 });
          console.log("[AAI] AudioContext created, state:", ctx.state, "sampleRate:", ctx.sampleRate);

          if (ctx.state !== "running") {
            ctx.resume().catch((err) => console.error("[AAI] ctx.resume() rejected:", err));
          }
          audioCtxRef.current = ctx;

          // ── Microphone source ──────────────────────────────────────────────
          console.log("Microphone stream acquired", stream.id);
          console.log("Audio tracks", stream.getAudioTracks().length,
            stream.getAudioTracks().map(t => ({ label: t.label, state: t.readyState, enabled: t.enabled })));

          const micTrack = stream.getAudioTracks()[0];
          if (!micTrack || micTrack.readyState !== "live") {
            console.error("[AAI] mic track not live", micTrack?.readyState);
            return;
          }

          const src = ctx.createMediaStreamSource(stream);
          sourceRef.current = src;

          const processor = ctx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            // Issue 1 fix: drop audio frames while AI TTS is active.
            // speechSynthesis plays through speakers; without this gate the mic
            // captures AI speech and AssemblyAI transcribes it as candidate text.
            if (_aiSpeaking) return;

            if (!sessionReady || aaiWs.readyState !== WebSocket.OPEN) {
              return;
            }

            const float32 = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
            }
            aaiWs.send(int16.buffer);
            chunksSentRef.current += 1;
            if (chunksSentRef.current === 1 || chunksSentRef.current % 20 === 0) {
              console.log("Audio chunk sent", int16.byteLength, "bytes  chunk#", chunksSentRef.current);
            }
          };

          src.connect(processor);
          processor.connect(ctx.destination);
          console.log("[AAI] audio pipeline armed — waiting for session_began");

        } catch (err) {
          console.error("[AAI] onopen error — audio pipeline NOT set up:", err);
        }
      };

      aaiWs.onmessage = (event) => {
        // ── RAW: log the exact bytes AssemblyAI sends before any processing ──
        // This is the ground truth — if the text here contains "PartialTranscript"
        // or "FinalTranscript" but the UI doesn't update, the bug is in parsing.
        // If no transcript text appears here at all, AssemblyAI is not recognising
        // the audio (wrong format, silence, etc.).
        console.log("[AAI RAW MESSAGE]", event.data);

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          console.warn("[AAI] received non-JSON frame:", event.data);
          return;
        }

        // ── PARSED: full pretty-printed payload ───────────────────────────────
        console.log("[AAI PARSED]", JSON.stringify(data, null, 2));

        // ── Session ready: unlock the audio gate ──────────────────────────────
        // AssemblyAI v3 sends {"type":"Begin"}.
        if (
          data.type === "Begin"
          || data.type === "session_began"
          || data.type === "SessionBegins"
          || data.message_type === "SessionBegins"
        ) {
          sessionReady = true;
          console.log("[AAI] session ready (type=" + String(data.type) + ") — audio gate OPEN");
          return;
        }

        // ── Error ─────────────────────────────────────────────────────────────
        if (data.type === "Error" || data.message_type === "Error") {
          console.error("[AAI FULL ERROR]", JSON.stringify(data, null, 2));
          return;
        }

        // ── AssemblyAI v3 transcript (Turn) ───────────────────────────────────
        // v3 sends {"type":"Turn","transcript":"...","end_of_turn":true|false}
        // v2 sent  {"message_type":"PartialTranscript","text":"..."}
        // The previous handler only checked message_type — every v3 frame was
        // silently ignored, so setLiveTranscript/setFinalTranscripts were never
        // called and the UI stayed empty even though audio was flowing.
        if (data.type === "Turn") {
          const text = typeof data.transcript === "string"
            ? data.transcript
            : typeof data.utterance === "string"
              ? data.utterance
              : "";

          if (!text.trim()) return;

          if (data.end_of_turn) {
            console.log("Final transcript", text);
            options.onFinal(text);
          } else {
            console.log("Partial transcript", text);
            options.onPartial(text);
          }
          return;
        }

        // ── AssemblyAI v2 transcript (kept for fallback) ───────────────────────
        const text = typeof data.text === "string" ? data.text : "";
        if (data.message_type === "PartialTranscript" && text) {
          console.log("Partial transcript", text);
          options.onPartial(text);
        } else if (data.message_type === "FinalTranscript" && text) {
          console.log("Final transcript", text);
          options.onFinal(text);
        }
      };

      aaiWs.onerror = (e) => console.error("Websocket error", e);
      aaiWs.onclose = (e) => console.log("Websocket closed", { code: e.code, reason: e.reason, wasClean: e.wasClean });
    },
    [options]
  );

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ terminate_session: true }));
        }
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, []);

  return { start, stop };
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CandidateInterviewPage() {
  const { token } = useParams<{ token: string }>();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [session, setSession] = useState<LiveInterview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Media
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [aiVoiceEnabled, setAiVoiceEnabled] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Interview state
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [questionNumber, setQuestionNumber] = useState(1);
  const [isFollowup, setIsFollowup] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [finalTranscripts, setFinalTranscripts] = useState<string[]>([]);
  const [history, setHistory] = useState<LiveInterviewMessage[]>([]);
  const [summary, setSummary] = useState<InterviewSummary | null>(null);

  // Backend WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const aaiTokenRef = useRef<string | null>(null);
  // Stores the AssemblyAI streaming WS URL returned by the backend token endpoint.
  // The backend may return v3 (streaming.assemblyai.com/v3/ws); do not hardcode v2.
  const aaiWsUrlRef = useRef<string | undefined>(undefined);

  // Browser SpeechRecognition (fallback when AssemblyAI token is unavailable).
  // Using a ref so it survives re-renders without being captured in stale closures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechRecRef = useRef<any>(null);

  // Full-interview video recording (one continuous MediaRecorder)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Per-question segment recording
  const segmentRecorderRef = useRef<MediaRecorder | null>(null);
  const segmentChunksRef = useRef<Blob[]>([]);

  // Timing and segment data
  const interviewStartMsRef = useRef<number>(0);     // Date.now() when interview starts
  const segmentsRef = useRef<QuestionSegment[]>([]);  // accumulated per-question data
  const activeSegmentRef = useRef<QuestionSegment | null>(null); // the current in-progress question

  // Upload state (shown on completion screen)
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");

  // Mark answer_start_seconds on the active segment when speaking begins.
  const _markAnswerStart = useCallback(() => {
    const seg = activeSegmentRef.current;
    if (seg && seg.answer_start_seconds === null && interviewStartMsRef.current) {
      seg.answer_start_seconds = (Date.now() - interviewStartMsRef.current) / 1000;
    }
  }, []);

  // AssemblyAI hook
  const { start: startSTT, stop: stopSTT } = useAssemblyAI({
    token: aaiTokenRef.current,
    active: pageState === "live",
    onPartial: (text) => {
      _markAnswerStart();
      setLiveTranscript(text);
    },
    onFinal: (text) => {
      _markAnswerStart();
      setFinalTranscripts((prev) => [...prev, text]);
      wsRef.current?.send(
        JSON.stringify({ type: "transcript", transcript: text })
      );
    },
  });

  // ── Load session ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return;
    getLiveInterviewByToken(token)
      .then((data) => {
        setSession(data);
        if (data.status === "completed") {
          setSummary({ duration_seconds: data.duration_seconds });
          setPageState("completed");
        } else {
          setPageState("lobby");
        }
      })
      .catch(() => {
        setErrorMsg("This interview link is invalid or has expired.");
        setPageState("error");
      });
  }, [token]);

  // ── Camera preview (lobby) ──────────────────────────────────────────────────

  useEffect(() => {
    if (pageState !== "lobby") return;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((s) => {
        // Log stream details so we can confirm tracks are alive before join.
        console.log("[media] getUserMedia success", {
          streamId: s.id,
          audioTracks: s.getAudioTracks().length,
          videoTracks: s.getVideoTracks().length,
          audioEnabled: s.getAudioTracks()[0]?.enabled,
          videoEnabled: s.getVideoTracks()[0]?.enabled,
          audioState: s.getAudioTracks()[0]?.readyState,
          videoState: s.getVideoTracks()[0]?.readyState,
        });
        streamRef.current = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          console.log("[media] videoRef.srcObject assigned in lobby", {
            srcObjectSet: !!videoRef.current.srcObject,
          });
        }
      })
      .catch((err) => {
        console.error("[media] getUserMedia failed", err);
        setErrorMsg(
          "Camera or microphone access denied. Please allow access and reload."
        );
        setPageState("error");
      });
    // FIX Bug 1: Do NOT stop tracks here. This cleanup runs whenever pageState
    // changes (e.g. lobby → connecting), which kills tracks before ws.onopen
    // fires and leaves the video element pointing at a dead stream → black screen.
    // The unmount cleanup effect below is the sole owner of track teardown.
  }, [pageState]);

  // ── Toggle mic / cam ────────────────────────────────────────────────────────

  const toggleMic = () => {
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setMicEnabled((p) => !p);
  };

  const toggleCam = () => {
    streamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setCamEnabled((p) => !p);
  };

  // ── Browser SpeechRecognition (fallback when AssemblyAI token is unavailable) ─
  //
  // Called from ws.onopen when aaiTokenRef.current is null.
  // Uses the same setLiveTranscript / setFinalTranscripts state as the AAI path.
  // Does NOT require any API key. Works in Chrome, Edge, Safari 14.1+.

  const _startBrowserSTT = useCallback(() => {
    if (speechRecRef.current) return; // already running

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR: (new () => any) | undefined = w.SpeechRecognition ?? w.webkitSpeechRecognition;

    if (!SR) {
      console.error("[STT] SpeechRecognition not supported in this browser — transcription unavailable");
      return;
    }

    console.log("Realtime client created", "browser SpeechRecognition");

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    speechRecRef.current = rec;

    rec.onstart = () => {
      console.log("Realtime connection opened", "browser SpeechRecognition active");
      console.log("Microphone stream acquired", "via SpeechRecognition API");
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      // Issue 1 fix: ignore results while AI is speaking through speakers
      if (_aiSpeaking) return;

      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += t + " ";
          // Proxy "audio chunk sent" — each final result represents a spoken segment.
          console.log("Audio chunk sent", t.length);
        } else {
          interim += t;
        }
      }
      if (interim) {
        _markAnswerStart();
        console.log("Partial transcript", interim);
        setLiveTranscript(interim);
      }
      if (final.trim()) {
        _markAnswerStart();
        const f = final.trim();
        console.log("Final transcript", f);
        setFinalTranscripts((prev) => [...prev, f]);
        wsRef.current?.send(JSON.stringify({ type: "transcript", transcript: f }));
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (event: any) => {
      // "no-speech" and "aborted" are expected — don't log as errors.
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.error("[STT] SpeechRecognition error", event.error, event.message);
    };

    rec.onend = () => {
      // Auto-restart so transcription is continuous across pauses.
      // speechRecRef is cleared by _stopBrowserSTT before it reaches here on
      // intentional stop, so this guard prevents restart after cleanup.
      if (speechRecRef.current) {
        try { speechRecRef.current.start(); } catch { /* already started */ }
      }
    };

    rec.start();
  }, [setLiveTranscript, setFinalTranscripts, wsRef, _markAnswerStart]);

  const _stopBrowserSTT = useCallback(() => {
    if (!speechRecRef.current) return;
    const rec = speechRecRef.current;
    speechRecRef.current = null; // clear first so onend does not restart
    rec.onend = null;
    try { rec.stop(); } catch { /* ignore */ }
    console.log("[STT] SpeechRecognition stopped");
  }, []);

  // ── Join interview ──────────────────────────────────────────────────────────

  const joinInterview = useCallback(async () => {
    if (!session) return;
    setPageState("connecting");

    // 1. Get AssemblyAI token from backend.
    // FIX Bug 2: also capture ws_url — the backend may return v3 endpoint.
    // FIX Bug 3: store in refs so ws.onopen can read the live values; the
    //   startSTT closure captured at render time has options.token = null.
    try {
      if (session.session_token) {
        const aaiResp = await getAssemblyAIToken(session.id, session.session_token);
        // "Token received" — log the ACTUAL token presence, not just HTTP status.
        // The endpoint always returns HTTP 200 even when token is null (API key not
        // configured). If hasToken is false here, AssemblyAI path is dead and we
        // fall back to browser SpeechRecognition below.
        console.log("AssemblyAI token received", aaiResp.token?.slice(0, 20));
        console.log("Token received", {
          available: aaiResp.available,
          hasToken: !!aaiResp.token,
          tokenLength: aaiResp.token?.length ?? 0,
          wsUrl: aaiResp.ws_url ?? "(none)",
        });
        aaiTokenRef.current = aaiResp.token;
        aaiWsUrlRef.current = aaiResp.ws_url;
      }
    } catch (err) {
      console.warn("[join] AssemblyAI token fetch failed — using browser STT fallback", err);
    }

    // 2. Log stream state at join time — tracks must still be live.
    const stream = streamRef.current;
    console.log("[join] stream at join time", {
      streamExists: !!stream,
      streamId: stream?.id,
      audioTracks: stream?.getAudioTracks().length,
      videoTracks: stream?.getVideoTracks().length,
      audioState: stream?.getAudioTracks()[0]?.readyState,
      videoState: stream?.getVideoTracks()[0]?.readyState,
      videoSrcObject: !!videoRef.current?.srcObject,
    });

    // 3. Connect to backend WebSocket.
    const apiBase =
      process.env.NEXT_PUBLIC_API_BACKEND_URL?.replace(/^https?/, "ws")?.replace(
        "/api/v1",
        ""
      ) ?? "ws://127.0.0.1:8000";
    const backendWsUrl = `${apiBase}/api/v1/ai-screenings/ws/${session.id}`;
    console.log("[join] opening backend WebSocket", { url: backendWsUrl });
    const ws = new WebSocket(backendWsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[join] backend WebSocket open", {
        aaiToken: !!aaiTokenRef.current,
        aaiWsUrl: aaiWsUrlRef.current,
        streamAlive: !!streamRef.current,
        audioState: streamRef.current?.getAudioTracks()[0]?.readyState,
      });

      setPageState("live");
      interviewStartMsRef.current = Date.now();

      if (aaiTokenRef.current && streamRef.current) {
        // ── Path A: AssemblyAI realtime STT ─────────────────────────────────
        startSTT(streamRef.current, aaiTokenRef.current, aaiWsUrlRef.current);
      } else {
        // ── Path B: Browser SpeechRecognition fallback ───────────────────────
        // ROOT CAUSE: backend returns {token: null, available: false} (HTTP 200)
        // when ASSEMBLYAI_API_KEY is not configured or the AssemblyAI API call
        // fails. aaiTokenRef.current is null → startSTT is never called →
        // no WebSocket to AssemblyAI → no transcript. This fallback ensures
        // transcription always works using the browser's built-in engine.
        console.warn("[join] AssemblyAI token absent — using browser SpeechRecognition");
        _startBrowserSTT();
      }

      // Start video recording (best-effort).
      if (streamRef.current) {
        try {
          const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm";
          const mr = new MediaRecorder(streamRef.current, { mimeType });
          recordedChunksRef.current = [];
          mr.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunksRef.current.push(e.data);
          };
          mr.start(5000);
          mediaRecorderRef.current = mr;
          console.log("[CANDIDATE] recording started", { mimeType, state: mr.state });
        } catch (err) {
          console.error("[CANDIDATE] recording failed to start", err);
        }
      } else {
        console.warn("[CANDIDATE] no stream — recording will not be available");
      }
    };

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data as string));
      } catch {
        /* ignore */
      }
    };

    ws.onerror = (e) => {
      console.error("[join] backend WebSocket error", e);
      setErrorMsg("Lost connection to interview server. Please reload.");
      setPageState("error");
    };

    ws.onclose = (e) => {
      console.log("[join] backend WebSocket closed", { code: e.code, reason: e.reason });
      stopSTT();
      _stopBrowserSTT();
    };
  }, [session, startSTT, stopSTT, _startBrowserSTT]);

  useEffect(
    () => () => {
      stopSTT();
      _stopBrowserSTT();
      stopSpeaking();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [stopSTT, _stopBrowserSTT]
  );

  // ── Handle WebSocket messages ───────────────────────────────────────────────

  // ── Per-question segment recorder helpers ────────────────────────────────────

  const _startSegmentRecorder = useCallback(() => {
    if (!streamRef.current) return;
    try {
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";
      const mr = new MediaRecorder(streamRef.current, { mimeType });
      segmentChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) segmentChunksRef.current.push(e.data);
      };
      mr.start(1000);
      segmentRecorderRef.current = mr;
    } catch {
      segmentRecorderRef.current = null;
    }
  }, []);

  const _stopSegmentRecorder = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      const mr = segmentRecorderRef.current;
      if (!mr || mr.state === "inactive") { resolve(null); return; }
      mr.onstop = async () => {
        const blob = new Blob(segmentChunksRef.current, { type: "video/webm" });
        if (blob.size === 0) { resolve(null); return; }
        try {
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let b64 = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            b64 += String.fromCharCode(...bytes.slice(i, i + chunkSize));
          }
          resolve(btoa(b64));
        } catch {
          resolve(null);
        }
      };
      segmentRecorderRef.current = null;
      mr.stop();
    });
  }, []);

  // ── Upload completed recording to backend ─────────────────────────────────

  const _uploadRecording = useCallback(async (
    screeningId: string,
    sessionToken: string,
    fullVideoBlob: Blob | null,
    segments: QuestionSegment[],
    transcript: object[],
  ) => {
    setUploadState("uploading");

    console.log("[CANDIDATE] upload started", {
      screeningId,
      hasVideo: !!fullVideoBlob,
      videoSize: fullVideoBlob?.size ?? 0,
      segmentCount: segments.length,
      transcriptLength: transcript.length,
    });

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_BACKEND_URL ?? "http://127.0.0.1:8000/api/v1";
      const url = `${apiBase}/ai-screenings/live/${screeningId}/upload-recording?token=${encodeURIComponent(sessionToken)}`;

      const form = new FormData();

      if (fullVideoBlob && fullVideoBlob.size > 0) {
        form.append("video", fullVideoBlob, "interview.webm");
        console.log("[CANDIDATE] blob size", fullVideoBlob.size);
      } else {
        console.warn("[CANDIDATE] blob is null or empty — video field not appended");
      }

      // Strip video_base64 before sending as a Form text field.
      //
      // ROOT CAUSE OF 400: each QuestionSegment carries video_base64 (the
      // base64-encoded WebM clip for that answer).  For a 5-question interview
      // this makes segments_json 10–50 MB of base64 text.  Starlette's multipart
      // parser holds text Form() fields entirely in memory and has a hard internal
      // max_field_size limit; exceeding it causes the parser to reject the body
      // with HTTP 400 before the endpoint function ever runs.
      //
      // Segment video clips are derivable from the full interview.webm using
      // the timing metadata (question_start_seconds / answer_end_seconds) that
      // is already stored in ai_screening_segments.  Sending base64 here is
      // redundant AND breaks the upload.  Strip it out.
      const segmentsMetaOnly = segments.map(({ video_base64: _drop, ...rest }) => rest);
      console.log("[CANDIDATE] segments_json size (metadata only)",
        JSON.stringify(segmentsMetaOnly).length, "bytes");

      form.append("segments_json", JSON.stringify(segmentsMetaOnly));
      form.append("transcript_json", JSON.stringify(transcript));

      const resp = await fetch(url, { method: "POST", body: form });
      const result = await resp.json().catch(() => ({}));
      console.log("[CANDIDATE] upload success", result);
      setUploadState("done");
    } catch (err) {
      console.error("[CANDIDATE] upload failed", err);
      setUploadState("error");
    }
  }, []);

  // ── Handle WebSocket messages ─────────────────────────────────────────────

  const handleWsMessage = useCallback(
    (msg: {
      type: string;
      text?: string;
      number?: number;
      followup?: boolean;
      summary?: InterviewSummary & Record<string, unknown>;
      message?: string;
    }) => {
      if (msg.type === "question") {
        const q = msg.text ?? "";
        const qNum = msg.number ?? 1;
        const nowMs = Date.now();
        const elapsedSec = interviewStartMsRef.current
          ? (nowMs - interviewStartMsRef.current) / 1000
          : 0;

        // Close out the previous segment (will be finalised in submitAnswer)
        // Start a new per-question MediaRecorder clip
        _startSegmentRecorder();

        // Create the active segment record for this question
        activeSegmentRef.current = {
          question_number: qNum,
          question_text: q,
          transcript: "",
          question_start_seconds: elapsedSec,
          answer_start_seconds: null,
          answer_end_seconds: null,
          duration_seconds: null,
        };

        setCurrentQuestion(q);
        setQuestionNumber(qNum);
        setIsFollowup(msg.followup ?? false);
        setLiveTranscript("");
        setFinalTranscripts([]);
        setPageState("live");
        if (aiVoiceEnabled) speak(q);
        setHistory((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "interviewer",
            content: q,
            sequence_number: prev.length + 1,
            question_number: qNum,
            is_followup: msg.followup ?? false,
            created_at: new Date().toISOString(),
          },
        ]);

      } else if (msg.type === "thinking") {
        setPageState("ai_thinking");
        stopSpeaking();

      } else if (msg.type === "interview_end") {
        setSummary({ duration_seconds: msg.summary?.duration_seconds as number ?? null });
        stopSTT();
        _stopBrowserSTT();
        stopSpeaking();
        setPageState("completed");
        wsRef.current?.close?.();

        // ── Upload flow ────────────────────────────────────────────────────
        // 1. Stop the full-interview recorder and get the complete blob
        // 2. Stop the current segment recorder and finalise last segment
        // 3. Upload everything to backend (no browser download)

        const sessionId = session?.id ?? "";
        const sessionToken = session?.session_token ?? "";
        const fullTranscript = history.map((m) => ({
          role: m.role,
          content: m.content,
          question_number: m.question_number,
          created_at: m.created_at,
        }));

        // Finalise last segment before stopping full recorder
        const lastSeg = activeSegmentRef.current;
        const nowMs = Date.now();
        const elapsedSec = interviewStartMsRef.current
          ? (nowMs - interviewStartMsRef.current) / 1000
          : 0;

        _stopSegmentRecorder().then((lastB64) => {
          if (lastSeg) {
            lastSeg.answer_end_seconds = lastSeg.answer_end_seconds ?? elapsedSec;
            lastSeg.duration_seconds = lastSeg.answer_end_seconds - (lastSeg.answer_start_seconds ?? lastSeg.question_start_seconds);
            if (lastB64) lastSeg.video_base64 = lastB64;
            segmentsRef.current.push(lastSeg);
            activeSegmentRef.current = null;
          }

          // Stop full recorder and upload
          const mr = mediaRecorderRef.current;
          console.log("[CANDIDATE] recorder state at interview_end", {
            recorderExists: !!mr,
            state: mr?.state,
            chunksAccumulated: recordedChunksRef.current.length,
          });

          if (mr && mr.state !== "inactive") {
            mr.onstop = () => {
              const fullBlob = new Blob(recordedChunksRef.current, { type: "video/webm" });
              console.log("[CANDIDATE] recording stopped, blob size:", fullBlob.size);
              _uploadRecording(sessionId, sessionToken, fullBlob, segmentsRef.current, fullTranscript);
            };
            mr.stop();
            console.log("[CANDIDATE] mr.stop() called");
          } else {
            console.warn("[CANDIDATE] MediaRecorder inactive/null — uploading without full video",
              { state: mr?.state });
            _uploadRecording(sessionId, sessionToken, null, segmentsRef.current, fullTranscript);
          }
        });

      } else if (msg.type === "error") {
        console.error("[WS Error]", msg.message);
      }
    },
    [aiVoiceEnabled, stopSTT, _stopBrowserSTT, _startSegmentRecorder,
     _stopSegmentRecorder, _uploadRecording, session, history]
  );

  // ── Submit answer ───────────────────────────────────────────────────────────

  const submitAnswer = () => {
    const fullAnswer = [...finalTranscripts, liveTranscript]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!fullAnswer || !wsRef.current) return;

    // Record answer_end timestamp and stop this question's segment recorder
    const nowMs = Date.now();
    const elapsedSec = interviewStartMsRef.current
      ? (nowMs - interviewStartMsRef.current) / 1000
      : 0;

    const seg = activeSegmentRef.current;
    if (seg) {
      seg.transcript = fullAnswer;
      seg.answer_end_seconds = elapsedSec;
      seg.duration_seconds =
        elapsedSec - (seg.answer_start_seconds ?? seg.question_start_seconds);
    }

    // Stop the current segment recorder and save the blob asynchronously
    _stopSegmentRecorder().then((b64) => {
      if (seg) {
        if (b64) seg.video_base64 = b64;
        segmentsRef.current.push({ ...seg });
        activeSegmentRef.current = null;
      }
    });

    setHistory((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "candidate",
        content: fullAnswer,
        sequence_number: prev.length + 1,
        question_number: questionNumber,
        is_followup: false,
        created_at: new Date().toISOString(),
      },
    ]);

    stopSpeaking();
    wsRef.current.send(JSON.stringify({ type: "end_answer" }));
    setPageState("ai_thinking");
    setLiveTranscript("");
    setFinalTranscripts([]);
  };

  // ── Manual end ──────────────────────────────────────────────────────────────

  const endInterview = () => {
    stopSpeaking();
    wsRef.current?.send(JSON.stringify({ type: "end_interview" }));
    setPageState("ai_thinking");
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (pageState === "loading") {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
      </div>
    );
  }

  if (pageState === "error") {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <Card className="max-w-md w-full bg-slate-900 border-red-800">
          <CardContent className="p-8 text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-red-400 mx-auto" />
            <p className="text-white font-medium">{errorMsg}</p>
            <Button
              variant="outline"
              className="border-slate-600 text-slate-300"
              onClick={() => window.location.reload()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (pageState === "completed") {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <Card className="max-w-md w-full bg-slate-900 border-slate-700">
          <CardContent className="p-10 text-center space-y-6">
            <CheckCircle2 className="h-16 w-16 text-emerald-400 mx-auto" />
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-white">Interview Complete</h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-xs mx-auto">
                Thank you for completing your AI screening interview.
                Your recruiter will review your responses and be in touch soon.
              </p>
            </div>

            {/* Upload status */}
            {uploadState === "uploading" && (
              <div className="flex items-center justify-center gap-2 text-slate-400 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving your recording…
              </div>
            )}
            {uploadState === "done" && (
              <p className="text-xs text-emerald-500">Recording saved successfully.</p>
            )}
            {uploadState === "error" && (
              <p className="text-xs text-amber-400">
                Recording could not be saved — your responses are still stored.
              </p>
            )}

            <Button
              className="w-full bg-orange-500 hover:bg-orange-600 text-white"
              onClick={() => window.close()}
            >
              Close
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isLive = pageState === "live" || pageState === "ai_thinking";

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-orange-500 flex items-center justify-center">
            <Video className="h-4 w-4 text-white" />
          </div>
          <span className="text-white font-semibold text-sm">AIRIS Screening</span>
          {session?.job_title_snapshot && (
            <Badge className="bg-slate-800 text-slate-300 border-0 text-xs hidden sm:inline-flex">
              {session.job_title_snapshot}
            </Badge>
          )}
        </div>
        {isLive && (
          <div className="flex items-center gap-3">
            <Badge
              className={cn(
                "text-xs border",
                pageState === "live"
                  ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
                  : "border-amber-500/50 text-amber-400 bg-amber-500/10"
              )}
            >
              {pageState === "live" ? `Q ${questionNumber}` : "Thinking…"}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="text-slate-500 hover:text-red-400 text-xs"
              onClick={endInterview}
            >
              <PhoneOff className="h-3.5 w-3.5 mr-1" />
              End
            </Button>
          </div>
        )}
      </div>

      {/* ── Main grid ── */}
      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Camera panel */}
        <div
          className={cn(
            "relative bg-black",
            isLive ? "lg:w-2/5 min-h-[260px]" : "w-full max-h-[50vh] lg:max-h-none lg:w-1/2"
          )}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
          {!camEnabled && (
            <div className="absolute inset-0 bg-slate-900 flex items-center justify-center">
              <VideoOff className="h-14 w-14 text-slate-700" />
            </div>
          )}

          {/* Media controls overlay */}
          <div className="absolute bottom-4 inset-x-0 flex justify-center gap-3">
            <button
              onClick={toggleMic}
              className={cn(
                "w-11 h-11 rounded-full flex items-center justify-center transition-colors",
                micEnabled ? "bg-slate-700/80 hover:bg-slate-600" : "bg-red-600 hover:bg-red-700"
              )}
            >
              {micEnabled ? (
                <Mic className="h-5 w-5 text-white" />
              ) : (
                <MicOff className="h-5 w-5 text-white" />
              )}
            </button>
            <button
              onClick={toggleCam}
              className={cn(
                "w-11 h-11 rounded-full flex items-center justify-center transition-colors",
                camEnabled ? "bg-slate-700/80 hover:bg-slate-600" : "bg-red-600 hover:bg-red-700"
              )}
            >
              {camEnabled ? (
                <Video className="h-5 w-5 text-white" />
              ) : (
                <VideoOff className="h-5 w-5 text-white" />
              )}
            </button>
            {isLive && (
              <button
                onClick={() => {
                  setAiVoiceEnabled((p) => {
                    if (p) stopSpeaking();
                    return !p;
                  });
                }}
                className={cn(
                  "w-11 h-11 rounded-full flex items-center justify-center transition-colors",
                  aiVoiceEnabled
                    ? "bg-orange-600/80 hover:bg-orange-600"
                    : "bg-slate-700/80 hover:bg-slate-600"
                )}
                title="Toggle AI voice"
              >
                {aiVoiceEnabled ? (
                  <Volume2 className="h-5 w-5 text-white" />
                ) : (
                  <VolumeX className="h-5 w-5 text-white" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="flex-1 flex flex-col bg-slate-950 p-5 gap-4 min-h-0">
          {/* ── LOBBY ── */}
          {(pageState === "lobby" || pageState === "connecting") && (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
              <div className="w-16 h-16 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
                <Volume2 className="h-8 w-8 text-orange-400" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-bold text-white">
                  {session?.candidate_name_snapshot
                    ? `Hello${session.candidate_name_snapshot ? `, ${session.candidate_name_snapshot.split(" ")[0]}` : ""}!`
                    : "Ready to begin?"}
                </h2>
                <p className="text-slate-400 text-sm max-w-sm mx-auto">
                  The AI will ask you recruiter-style questions about your experience,
                  projects and career goals. Speak naturally — take your time.
                </p>
              </div>

              {/* Expiry warning */}
              {session?.expires_at && (() => {
                const exp = new Date(session.expires_at);
                const hoursLeft = Math.round((exp.getTime() - Date.now()) / 3600000);
                if (hoursLeft < 24) {
                  return (
                    <p className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-lg px-3 py-2">
                      Expires in ~{hoursLeft} hour{hoursLeft !== 1 ? "s" : ""}
                    </p>
                  );
                }
                return null;
              })()}

              <ul className="space-y-2 text-left text-sm text-slate-400 max-w-xs w-full">
                {[
                  "Speak clearly into your microphone",
                  "Answer fully before clicking Done",
                  `~${session?.interview_duration_minutes ?? 20} minute interview, ${session?.max_questions ?? 12} questions`,
                  "AI voice reads each question aloud",
                  "No technical coding questions",
                ].map((tip) => (
                  <li key={tip} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                    {tip}
                  </li>
                ))}
              </ul>

              <Button
                size="lg"
                className="bg-orange-500 hover:bg-orange-600 text-white px-10 gap-2"
                disabled={pageState === "connecting"}
                onClick={joinInterview}
              >
                {pageState === "connecting" ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <Phone className="h-5 w-5" />
                    Join Interview
                  </>
                )}
              </Button>
            </div>
          )}

          {/* ── LIVE ── */}
          {isLive && (
            <div className="flex-1 flex flex-col gap-4 min-h-0">
              {/* AI Question bubble */}
              <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center flex-shrink-0">
                    <Volume2 className="h-3.5 w-3.5 text-white" />
                  </div>
                  <span className="text-xs text-slate-400">
                    AI Interviewer
                    {isFollowup && (
                      <span className="ml-2 text-orange-400">· follow-up</span>
                    )}
                  </span>
                </div>
                {pageState === "ai_thinking" ? (
                  <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm italic">Thinking…</span>
                  </div>
                ) : (
                  <p className="text-white text-base leading-relaxed font-medium">
                    {currentQuestion}
                  </p>
                )}
              </div>

              {/* Live transcript */}
              {pageState === "live" && (
                <div className="flex-1 flex flex-col gap-3 min-h-0">
                  <div className="relative flex-1 min-h-[120px]">
                    <textarea
                      className="w-full h-full min-h-[120px] bg-slate-900 border border-slate-700 rounded-xl p-4 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder:text-slate-600"
                      placeholder={
                        aaiTokenRef.current
                          ? "Listening… your speech will appear here automatically."
                          : "Type your answer here (or speak — microphone transcription appears automatically)…"
                      }
                      value={
                        [...finalTranscripts, liveTranscript]
                          .filter(Boolean)
                          .join(" ")
                          .trim()
                      }
                      onChange={(e) => {
                        // Allow manual editing when STT is not active
                        setFinalTranscripts([e.target.value]);
                        setLiveTranscript("");
                      }}
                    />
                    {micEnabled && (
                      <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    )}
                  </div>
                  <div className="flex justify-between items-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-slate-500 text-xs"
                      onClick={() => {
                        setFinalTranscripts([]);
                        setLiveTranscript("");
                      }}
                    >
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
                      disabled={
                        ![...finalTranscripts, liveTranscript]
                          .filter(Boolean)
                          .join(" ")
                          .trim()
                      }
                      onClick={submitAnswer}
                    >
                      <Send className="h-4 w-4" />
                      Done Answering
                    </Button>
                  </div>
                </div>
              )}

              {/* Q&A history (last 2) */}
              {history.length > 1 && (
                <div className="border-t border-slate-800 pt-3">
                  <p className="text-xs text-slate-600 mb-2">Previous exchanges</p>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {history.slice(-4).map((m, i) => (
                      <div key={i} className="text-xs bg-slate-900/60 rounded-lg p-2.5">
                        <span
                          className={cn(
                            "font-medium mr-1",
                            m.role === "interviewer"
                              ? "text-orange-400"
                              : "text-blue-400"
                          )}
                        >
                          {m.role === "interviewer" ? "AI:" : "You:"}
                        </span>
                        <span className="text-slate-400 line-clamp-1">{m.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
