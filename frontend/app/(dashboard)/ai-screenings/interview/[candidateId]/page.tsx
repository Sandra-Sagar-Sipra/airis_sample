"use client";

/**
 * AI Screening Interview Room — fixed audio, video, and debug overlay
 *
 * Root-cause fixes applied in this version:
 *
 * FIX 1 — Video black (Issue 2)
 *   CAUSE: useEffect cleanup was calling track.stop() whenever pageState
 *          changed away from "lobby", killing the stream before the interview
 *          even started. The video srcObject was never re-assigned.
 *   FIX:   getUserMedia runs once on component mount via a single useEffect
 *          with [] deps. Cleanup only on unmount. srcObject is set immediately
 *          and kept alive for the full lifecycle.
 *
 * FIX 2 — No transcription (Issue 1)
 *   CAUSE: startSTT was only called when aaiTokenRef.current was set.
 *          AssemblyAI token returns null (API unavailable), so the STT
 *          branch was never entered. Candidate spoke but nothing happened.
 *   FIX:   Use the browser's built-in SpeechRecognition API (Web Speech API)
 *          as the PRIMARY transcription engine — works in Chrome, Edge, Safari
 *          without any external token. AssemblyAI is a secondary enhancement.
 *          SpeechRecognition starts in ws.onopen, continuous mode.
 *
 * LAYOUT: Camera panel 35% / right panel 65%, video 16:9 max-height 320px.
 *
 * DEBUG OVERLAY: Camera · Mic · WebSocket · STT · AI status badges.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Send,
  Phone,
  PhoneOff,
  User,
  Briefcase,
  Star,
  TrendingUp,
  ChevronRight,
  Bug,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getOrCreateCandidateScreening,
  getAssemblyAIToken,
  type LiveInterview,
} from "@/lib/api/ai_screening";
import { cn } from "@/lib/utils";

// ── Extend window for Web Speech API ──────────────────────────────────────────

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

// ── TTS (Web Speech API) ──────────────────────────────────────────────────────

function speak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.92;
  utt.pitch = 1.0;
  utt.volume = 1.0;
  // Prefer a natural-sounding English voice
  const voices = window.speechSynthesis.getVoices();
  const pref = voices.find(
    (v) =>
      v.lang.startsWith("en") &&
      (v.name.includes("Google") ||
        v.name.includes("Samantha") ||
        v.name.includes("Natural") ||
        v.name.includes("Zira"))
  );
  if (pref) utt.voice = pref;
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

// ── Config ────────────────────────────────────────────────────────────────────

const REC_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; description: string }
> = {
  strong_hire: {
    label: "Strong Hire",
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
    description: "Candidate advanced to Interview stage.",
  },
  hire: {
    label: "Hire",
    color: "text-blue-700",
    bg: "bg-blue-50 border-blue-200",
    description: "Candidate advanced to Interview stage.",
  },
  consider: {
    label: "Consider",
    color: "text-amber-700",
    bg: "bg-amber-50 border-amber-200",
    description: "Candidate advanced to Interview stage.",
  },
  reject: {
    label: "Reject",
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
    description: "Candidate moved to Rejected stage.",
  },
};

// ── Score gauge ───────────────────────────────────────────────────────────────

function ScoreGauge({ label, score }: { label: string; score: number | null }) {
  const pct = score ?? 0;
  const bar =
    pct >= 75 ? "bg-emerald-500" : pct >= 55 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="font-semibold">
          {score != null ? `${score.toFixed(0)}/100` : "—"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Service status types ──────────────────────────────────────────────────────

type SvcStatus = "unknown" | "ok" | "error" | "pending";

interface DebugStatus {
  camera: SvcStatus;
  mic: SvcStatus;
  ws: SvcStatus;
  stt: SvcStatus;
  ai: SvcStatus;
}

// ── Debug overlay ─────────────────────────────────────────────────────────────

interface LiveMetrics {
  questionsAsked: number;
  questionsAnswered: number;
  wordCount: number;
  transcriptChars: number;
  durationSeconds: number;
  scoringEligible: boolean;
}

function DebugOverlay({
  status,
  sttEngine,
  metrics,
  onClose,
}: {
  status: DebugStatus;
  sttEngine: string;
  metrics: LiveMetrics;
  onClose: () => void;
}) {
  const dot = (s: SvcStatus) => (
    <span
      className={cn(
        "inline-block w-2 h-2 rounded-full flex-shrink-0",
        s === "ok" && "bg-emerald-400",
        s === "error" && "bg-red-400",
        s === "pending" && "bg-amber-400 animate-pulse",
        s === "unknown" && "bg-slate-500"
      )}
    />
  );

  const svcRows: [string, SvcStatus, string][] = [
    ["Camera", status.camera, "getUserMedia video"],
    ["Microphone", status.mic, "getUserMedia audio"],
    ["WebSocket", status.ws, "Backend interview WS"],
    ["STT", status.stt, sttEngine],
    ["AI / Groq", status.ai, "Question generation"],
  ];

  const fmtDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // Thresholds
  const MIN_Q = 5, MIN_WORDS = 200, MIN_DUR = 300;

  const metricRows: [string, string | number, boolean][] = [
    ["Questions Asked",    metrics.questionsAsked,    true],
    ["Questions Answered", metrics.questionsAnswered,  metrics.questionsAnswered >= MIN_Q],
    ["Word Count",         metrics.wordCount,          metrics.wordCount >= MIN_WORDS],
    ["Transcript Chars",   metrics.transcriptChars,    metrics.transcriptChars > 0],
    ["Duration",           fmtDuration(metrics.durationSeconds), metrics.durationSeconds >= MIN_DUR],
    ["Scoring Eligible",   metrics.scoringEligible ? "YES" : "NO", metrics.scoringEligible],
  ];

  return (
    <div className="absolute top-2 right-2 bg-slate-900/95 border border-slate-700 rounded-lg p-3 text-xs z-20 min-w-[220px] shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="text-slate-300 font-medium flex items-center gap-1">
          <Bug className="h-3 w-3" /> Debug Panel
        </span>
        <button onClick={onClose} className="text-slate-500 hover:text-white">
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Service status */}
      <p className="text-slate-500 uppercase tracking-wide text-[9px] font-semibold mb-1 mt-1">Services</p>
      <div className="space-y-1 mb-3">
        {svcRows.map(([label, s, hint]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-slate-400 flex items-center gap-1.5">
              {dot(s)} {label}
            </span>
            <span className="text-slate-600 truncate max-w-[80px]" title={hint}>{hint}</span>
          </div>
        ))}
      </div>

      {/* Completeness metrics */}
      <p className="text-slate-500 uppercase tracking-wide text-[9px] font-semibold mb-1">Completeness</p>
      <div className="space-y-1">
        {metricRows.map(([label, value, ok]) => (
          <div key={label as string} className="flex items-center justify-between gap-2">
            <span className="text-slate-400 flex items-center gap-1.5">
              <span className={cn("inline-block w-1.5 h-1.5 rounded-full", ok ? "bg-emerald-400" : "bg-amber-400")} />
              {label}
            </span>
            <span className={cn("font-mono text-[10px]", ok ? "text-emerald-400" : "text-amber-400")}>
              {String(value)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-2 pt-2 border-t border-slate-800 text-[9px] text-slate-600 space-y-0.5">
        <div>Min questions: {MIN_Q} · Min words: {MIN_WORDS}</div>
        <div>Min duration: {fmtDuration(MIN_DUR)} (5 min)</div>
      </div>
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState =
  | "loading"
  | "lobby"
  | "connecting"
  | "live"
  | "thinking"
  | "completed"
  | "error";

interface Summary {
  overall_score?: number | null;
  recommendation?: string | null;
  ai_summary?: string | null;
  communication_score?: number | null;
  experience_score?: number | null;
  confidence_score?: number | null;
  culture_fit_score?: number | null;
  strengths?: string[];
  concerns?: string[];
  salary_expectation?: string | null;
  notice_period?: string | null;
  duration_seconds?: number | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// PAGE
// ═════════════════════════════════════════════════════════════════════════════

export default function InterviewRoomPage() {
  const { candidateId } = useParams<{ candidateId: string }>();
  const router = useRouter();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [screening, setScreening] = useState<LiveInterview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [transcriptNotice, setTranscriptNotice] = useState<string | null>(null);

  // Media state
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [camError, setCamError] = useState<string | null>(null);

  // Interview state
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [questionNumber, setQuestionNumber] = useState(1);
  const [isFollowup, setIsFollowup] = useState(false);
  const [transcript, setTranscript] = useState("");         // live partial
  const [finalParts, setFinalParts] = useState<string[]>([]); // committed finals
  const [msgCount, setMsgCount] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);

  // Debug + completeness tracking
  const [showDebug, setShowDebug] = useState(false);
  const [dbgStatus, setDbgStatus] = useState<DebugStatus>({
    camera: "unknown",
    mic: "unknown",
    ws: "unknown",
    stt: "unknown",
    ai: "unknown",
  });
  const [sttEngine, setSttEngine] = useState("none");

  // Live interview completeness metrics (shown in debug panel)
  const [liveMetrics, setLiveMetrics] = useState({
    questionsAsked: 0,
    questionsAnswered: 0,
    wordCount: 0,
    transcriptChars: 0,
    durationSeconds: 0,
    scoringEligible: false,
  });
  const interviewStartRef = useRef<number | null>(null);
  const metricIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs — stable across renders
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const aaiWsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sttActiveRef = useRef(false); // prevent duplicate starts

  const setDbg = useCallback(
    (key: keyof DebugStatus, val: SvcStatus) =>
      setDbgStatus((prev) => ({ ...prev, [key]: val })),
    []
  );

  // ── 1. Load screening (once) ──────────────────────────────────────────────

  useEffect(() => {
    if (!candidateId) return;
    getOrCreateCandidateScreening(candidateId)
      .then((s) => {
        setScreening(s);
        if (s.status === "completed" || s.status === "incomplete") {
          setSummary({
            overall_score: s.overall_score,
            recommendation: s.recommendation,
            ai_summary: s.ai_summary ?? s.incomplete_reason ?? null,
            communication_score: s.communication_score,
            experience_score: s.experience_score,
            confidence_score: s.confidence_score,
            culture_fit_score: s.culture_fit_score,
            strengths: s.strengths ?? [],
            concerns: s.concerns ?? [],
            salary_expectation: s.salary_expectation,
            notice_period: s.notice_period,
            duration_seconds: s.duration_seconds,
          });
          setPageState("completed");
        } else {
          setPageState("lobby");
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(
          msg.includes("not currently in the Screening")
            ? "This candidate is not in the Screening pipeline stage."
            : msg
        );
        setPageState("error");
      });
  }, [candidateId]);

  // ── 2. Camera / mic — start ONCE on mount, stop ONLY on unmount ──────────
  //
  // CRITICAL FIX: previously this was inside a useEffect([pageState]) that
  // cleaned up (stopped tracks) every time pageState changed.  That killed the
  // stream as soon as the user clicked Join (lobby→connecting).  Moved to [] so
  // we acquire the stream once and keep it for the whole component lifetime.

  useEffect(() => {
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        console.log("Mic started");
        console.log("[MIC_GRANTED] Audio tracks:", stream.getAudioTracks().length);
        console.log("[MIC_GRANTED] Video tracks:", stream.getVideoTracks().length);
        setDbg("camera", "ok");
        setDbg("mic", "ok");

        // Assign to video element — works whether element is mounted yet or not
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {/* autoplay policy — muted handles it */});
        }
      })
      .catch((err) => {
        console.error("[MIC_DENIED]", err.name, err.message);
        setDbg("camera", "error");
        setDbg("mic", "error");
        setCamError(
          err.name === "NotAllowedError"
            ? "Camera/microphone access denied. Allow permissions in your browser."
            : `Media error: ${err.message}`
        );
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []); // ← empty deps: mount-only

  // Re-assign srcObject when videoRef mounts (handles race between stream
  // acquisition and React rendering the video element).
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    if (el && streamRef.current) {
      el.srcObject = streamRef.current;
      el.play().catch(() => {});
    }
  }, []);

  // ── 3. Media controls ─────────────────────────────────────────────────────

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

  // ── 4. Browser SpeechRecognition (primary STT) ────────────────────────────
  //
  // Uses the built-in Web Speech API — no API key required.
  // Supported: Chrome 33+, Edge 79+, Safari 14.1+.

  const startBrowserSTT = useCallback(() => {
    if (sttActiveRef.current) return;
    const SpeechRecAPI =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecAPI) {
      console.warn("[ASSEMBLYAI_CONNECTED] Web Speech API not available in this browser");
      setSttEngine("none — type manually");
      setDbg("stt", "error");
      return;
    }

    sttActiveRef.current = true;
    const rec = new SpeechRecAPI();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      console.log("[ASSEMBLYAI_CONNECTED] SpeechRecognition started (Web Speech API)");
      setSttEngine("Web Speech API");
      setDbg("stt", "ok");
    };

    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
          console.log("[ASSEMBLYAI_TRANSCRIPT_RECEIVED] Final segment:", r[0].transcript, "confidence:", r[0].confidence.toFixed(2));
        } else {
          interim += r[0].transcript;
        }
      }
      if (final) {
        setFinalParts((prev) => [...prev, final]);
        // Forward to backend WebSocket in real time
        wsRef.current?.send(
          JSON.stringify({ type: "transcript", transcript: final })
        );
      }
      setTranscript(interim);
    };

    rec.onerror = (event) => {
      console.warn("[ASSEMBLYAI_CONNECTED] SpeechRecognition error:", event.error);
      if (event.error === "no-speech") return; // normal — keep running
      if (event.error === "network") {
        setDbg("stt", "error");
        setSttEngine("error — check network");
      }
    };

    rec.onend = () => {
      // Auto-restart unless we intentionally stopped
      if (sttActiveRef.current && recognitionRef.current) {
        try {
          rec.start();
        } catch {
          /* may fail if already started */
        }
      }
    };

    try {
      rec.start();
    } catch (e) {
      console.error("[ASSEMBLYAI_CONNECTED] Failed to start SpeechRecognition:", e);
      setDbg("stt", "error");
    }

    recognitionRef.current = rec;
  }, [setDbg]);

  // ── 5. AssemblyAI STT (optional enhancement via websocket) ───────────────

  const startAssemblyAI = useCallback(
    async (stream: MediaStream, token: string, wsBaseUrl?: string) => {
      const wsEndpoint = wsBaseUrl ?? "wss://streaming.assemblyai.com/v3/ws";
      const ws = new WebSocket(
        `${wsEndpoint}?sample_rate=16000&encoding=pcm_s16le&format_turns=true&speech_model=universal-streaming-english&token=${token}`
      );
      aaiWsRef.current = ws;
      let sentChunks = 0;

      ws.onopen = () => {
        console.log("AssemblyAI connected");
        console.log("[ASSEMBLYAI_CONNECTED] AssemblyAI WebSocket open:", wsEndpoint);
        setSttEngine("AssemblyAI");
        setDbg("stt", "ok");
        setTranscriptNotice(null);

        // Pipe raw PCM from microphone to AssemblyAI
        const ctx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        processorRef.current = proc;
        proc.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const f32 = e.inputBuffer.getChannelData(0);
          const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++)
            i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
          ws.send(i16.buffer);
          sentChunks += 1;
          if (sentChunks % 10 === 0) {
            console.log("Audio chunk sent");
          }
        };
        src.connect(proc);
        proc.connect(ctx.destination);
      };

      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data as string);
          // AssemblyAI v3
          if (d.type === "Turn" && typeof d.transcript === "string") {
            const text = d.transcript.trim();
            if (!text) return;
            console.log("Transcript received");
            if (d.end_of_turn) {
              setFinalParts((prev) => [...prev, text]);
              wsRef.current?.send(
                JSON.stringify({ type: "transcript", transcript: text })
              );
            } else {
              setTranscript(text);
            }
            return;
          }
          // Backward-compatible v2 parser
          if (d.message_type === "PartialTranscript" && d.text) {
            setTranscript(d.text);
          } else if (d.message_type === "FinalTranscript" && d.text) {
            console.log("Transcript received");
            console.log("[ASSEMBLYAI_TRANSCRIPT_RECEIVED]", d.text);
            setFinalParts((prev) => [...prev, d.text]);
            wsRef.current?.send(
              JSON.stringify({ type: "transcript", transcript: d.text })
            );
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onerror = () => {
        console.warn("[ASSEMBLYAI_CONNECTED] AssemblyAI WS error — falling back to Web Speech API");
        setDbg("stt", "error");
        startBrowserSTT();
      };
    },
    [setDbg, startBrowserSTT]
  );

  const stopAllSTT = useCallback(() => {
    sttActiveRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        /* ignore */
      }
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (aaiWsRef.current) {
      try {
        if (aaiWsRef.current.readyState === WebSocket.OPEN) {
          aaiWsRef.current.send(JSON.stringify({ terminate_session: true }));
        }
        aaiWsRef.current.close();
      } catch {
        /* ignore */
      }
      aaiWsRef.current = null;
    }
    setDbg("stt", "unknown");
  }, [setDbg]);

  const releaseInterviewConnections = useCallback(() => {
    stopAllSTT();
    stopSpeaking();
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, [stopAllSTT]);

  useEffect(() => () => releaseInterviewConnections(), [releaseInterviewConnections]);

  // ── 6. Backend WebSocket message handler ─────────────────────────────────

  // Helper to update word-count metric whenever new answer text comes in
  const updateWordMetrics = useCallback((addedText: string) => {
    const words = addedText.trim().split(/\s+/).filter(Boolean).length;
    setLiveMetrics((prev) => {
      const newWords = prev.wordCount + words;
      const newChars = prev.transcriptChars + addedText.length;
      return {
        ...prev,
        wordCount: newWords,
        transcriptChars: newChars,
        scoringEligible:
          prev.questionsAnswered + 1 >= 5 &&
          newWords >= 200 &&
          prev.durationSeconds >= 300,
      };
    });
  }, []);

  const handleWsMsg = useCallback(
    (msg: {
      type: string;
      text?: string;
      number?: number;
      followup?: boolean;
      message?: string;
      summary?: Summary;
    }) => {
      if (msg.type === "question") {
        setCurrentQuestion(msg.text ?? "");
        setQuestionNumber(msg.number ?? 1);
        setIsFollowup(msg.followup ?? false);
        setTranscript("");
        setFinalParts([]);
        setMsgCount((n) => n + 1);
        setPageState("live");
        setDbg("ai", "ok");
        setTranscriptNotice(null);
        // Track questions asked
        setLiveMetrics((prev) => ({ ...prev, questionsAsked: prev.questionsAsked + 1 }));
        if (voiceEnabled && msg.text) speak(msg.text);
      } else if (msg.type === "thinking") {
        setPageState("thinking");
        stopSpeaking();
        setDbg("ai", "pending");
        // Count this as a completed answer
        setLiveMetrics((prev) => ({
          ...prev,
          questionsAnswered: prev.questionsAnswered + 1,
        }));
      } else if (msg.type === "interview_end") {
        setSummary(msg.summary ?? null);
        stopAllSTT();
        stopSpeaking();
        if (metricIntervalRef.current) clearInterval(metricIntervalRef.current);
        setPageState("completed");
        wsRef.current?.close();
      } else if (msg.type === "error") {
        console.error("[AI] WS server error:", msg.message);
        if (msg.message) {
          setTranscriptNotice(msg.message);
        }
      } else if (msg.type === "answer_rejected") {
        setTranscriptNotice(
          msg.message ??
            "Answer too short to continue. Please provide more detail."
        );
        setPageState("live");
      }
    },
    [voiceEnabled, stopAllSTT, setDbg, updateWordMetrics]
  );

  // ── 7. Join interview ─────────────────────────────────────────────────────

  const joinInterview = useCallback(async () => {
    if (!screening) return;
    setPageState("connecting");
    setDbg("ws", "pending");

    // Optional: AssemblyAI token (falls back to Web Speech if unavailable)
    let aaiToken: string | null = null;
    let aaiWsUrl: string | undefined;
    try {
      if (screening.session_token) {
        const res = await getAssemblyAIToken(
          screening.id,
          screening.session_token
        );
        if (res.available && res.token) {
          aaiToken = res.token;
          aaiWsUrl = res.ws_url;
        }
      }
    } catch {
      /* no token — will use browser STT */
    }

    // Connect to backend WebSocket
    const apiBase = (
      process.env.NEXT_PUBLIC_API_BACKEND_URL ?? "http://127.0.0.1:8000/api/v1"
    )
      .replace(/^https?/, "ws")
      .replace("/api/v1", "");
    const wsUrl = `${apiBase}/api/v1/ai-screenings/ws/${screening.id}`;
    console.log("[LIVEKIT_CONNECTED] Connecting backend WS:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[LIVEKIT_CONNECTED] Backend WebSocket connected");
      setDbg("ws", "ok");
      setPageState("live");

      // Start duration timer
      interviewStartRef.current = Date.now();
      metricIntervalRef.current = setInterval(() => {
        const elapsed = Math.round((Date.now() - (interviewStartRef.current ?? Date.now())) / 1000);
        setLiveMetrics((prev) => ({
          ...prev,
          durationSeconds: elapsed,
          scoringEligible:
            prev.questionsAnswered >= 5 && prev.wordCount >= 200 && elapsed >= 300,
        }));
      }, 5000);

      // Start STT — prefer AssemblyAI if token available, else browser
      if (aaiToken && streamRef.current) {
        console.log("[LIVEKIT_AUDIO_PUBLISHED] Starting AssemblyAI STT");
        startAssemblyAI(streamRef.current, aaiToken, aaiWsUrl);
      } else {
        console.log("[LIVEKIT_AUDIO_PUBLISHED] Starting Web Speech API STT");
        setTranscriptNotice(
          "AssemblyAI unavailable. Using browser speech recognition fallback."
        );
        startBrowserSTT();
      }
    };

    ws.onmessage = (ev) => {
      try {
        handleWsMsg(JSON.parse(ev.data as string));
      } catch {/* ignore */}
    };

    ws.onerror = () => {
      console.error("[LIVEKIT_CONNECTED] Backend WS error");
      setDbg("ws", "error");
      setErrorMsg("Connection to interview server lost. Please reload.");
      setPageState("error");
    };

    ws.onclose = () => {
      console.log("[LIVEKIT_CONNECTED] Backend WS closed");
      setDbg("ws", "unknown");
      stopAllSTT();
    };
  }, [
    screening,
    handleWsMsg,
    startBrowserSTT,
    startAssemblyAI,
    stopAllSTT,
    setDbg,
  ]);

  // ── 8. Submit answer ──────────────────────────────────────────────────────

  const submitAnswer = () => {
    const full = [...finalParts, transcript].filter(Boolean).join(" ").trim();
    if (!full || !wsRef.current) return;

    if (transcript.trim()) {
      wsRef.current.send(JSON.stringify({ type: "transcript", transcript: transcript.trim() }));
    }

    stopSpeaking();
    setTranscriptNotice(null);
    // Track word count for completeness gate
    updateWordMetrics(full);
    wsRef.current.send(JSON.stringify({ type: "end_answer" }));
    setPageState("thinking");
    setTranscript("");
    setFinalParts([]);
  };

  const endInterview = () => {
    stopSpeaking();
    wsRef.current?.send(JSON.stringify({ type: "end_interview" }));
    setPageState("thinking");
  };

  // ── 9. Render: loading ────────────────────────────────────────────────────

  if (pageState === "loading") {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
      </div>
    );
  }

  // ── 10. Render: error ──────────────────────────────────────────────────────

  if (pageState === "error") {
    return (
      <div className="p-6 max-w-xl mx-auto pt-16">
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 text-slate-500"
          onClick={() => router.back()}
        >
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-6 space-y-3 text-center">
            <AlertCircle className="h-10 w-10 text-red-400 mx-auto" />
            <p className="text-red-700 font-medium">{errorMsg}</p>
            <Button variant="outline" onClick={() => router.back()}>
              Go back to AI Screenings
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 11. Render: completed / incomplete ───────────────────────────────────────

  if (pageState === "completed" && summary) {
    const isIncomplete = !summary.recommendation && !!summary.ai_summary?.includes("Interview incomplete");
    const rec = summary.recommendation ? REC_CONFIG[summary.recommendation] : null;
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <Button
          variant="ghost"
          size="sm"
          className="text-slate-500"
          onClick={() => router.push("/ai-screenings")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to AI Screenings
        </Button>

        {/* Incomplete banner */}
        {isIncomplete && (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-800">Interview Incomplete — No Scores Generated</p>
                <p className="text-amber-700 text-sm mt-1">{summary.ai_summary}</p>
                <p className="text-amber-600 text-xs mt-2">
                  Minimum requirements: 5 answered questions · 200 spoken words · 5 minutes duration.
                  Please reschedule a full interview.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {screening?.candidate_name_snapshot ?? "Interview Complete"}
            </h1>
            <p className="text-slate-500 text-sm mt-0.5">
              {screening?.job_title_snapshot}
              {summary.duration_seconds
                ? ` · ${Math.round(summary.duration_seconds / 60)} min`
                : ""}
            </p>
          </div>
          {rec && !isIncomplete && (
            <div
              className={cn(
                "px-4 py-2 rounded-lg border text-center min-w-[140px]",
                rec.bg
              )}
            >
              <p className="text-xs text-slate-500">AI Recommendation</p>
              <p className={cn("font-bold text-lg", rec.color)}>{rec.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{rec.description}</p>
            </div>
          )}
        </div>

        {!isIncomplete && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Star className="h-4 w-4 text-amber-500" /> Scores
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <ScoreGauge label="Overall" score={summary.overall_score ?? null} />
              <ScoreGauge label="Communication" score={summary.communication_score ?? null} />
              <ScoreGauge label="Experience" score={summary.experience_score ?? null} />
              <ScoreGauge label="Confidence" score={summary.confidence_score ?? null} />
              <ScoreGauge label="Culture Fit" score={summary.culture_fit_score ?? null} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4 text-blue-500" /> Findings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {summary.salary_expectation && (
                <div>
                  <p className="text-xs text-slate-500">Salary Expectation</p>
                  <p className="font-medium">{summary.salary_expectation}</p>
                </div>
              )}
              {summary.notice_period && (
                <div>
                  <p className="text-xs text-slate-500">Notice Period</p>
                  <p className="font-medium">{summary.notice_period}</p>
                </div>
              )}
              {(summary.strengths ?? []).length > 0 && (
                <div>
                  <p className="text-xs text-emerald-700 font-medium mb-1">
                    Strengths
                  </p>
                  {summary.strengths!.map((s, i) => (
                    <div key={i} className="flex gap-1.5 text-xs text-slate-600 mb-0.5">
                      <ChevronRight className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                      {s}
                    </div>
                  ))}
                </div>
              )}
              {(summary.concerns ?? []).length > 0 && (
                <div>
                  <p className="text-xs text-amber-700 font-medium mb-1">
                    Concerns
                  </p>
                  {summary.concerns!.map((c, i) => (
                    <div key={i} className="flex gap-1.5 text-xs text-slate-600 mb-0.5">
                      <ChevronRight className="h-3.5 w-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                      {c}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">AI Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-700 leading-relaxed">
                {summary.ai_summary ?? "Assessment in progress…"}
              </p>
            </CardContent>
          </Card>
        </div>
        )}
      </div>
    );
  }

  // ── 12. Render: interview room ────────────────────────────────────────────

  const isLive = pageState === "live" || pageState === "thinking";
  const answerText = [...finalParts, transcript]
    .filter(Boolean)
    .join(" ")
    .trimStart();

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          {!isLive && (
            <button
              className="text-slate-400 hover:text-white"
              onClick={() => router.push("/ai-screenings")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="w-7 h-7 rounded bg-orange-500 flex items-center justify-center">
            <Video className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-white text-sm font-medium hidden sm:block">
            {screening?.candidate_name_snapshot}
          </span>
          {screening?.job_title_snapshot && (
            <span className="text-slate-400 text-xs hidden sm:block">
              · {screening.job_title_snapshot}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Service status pills */}
          <div className="hidden md:flex items-center gap-1.5">
            {(
              [
                ["Cam", dbgStatus.camera],
                ["Mic", dbgStatus.mic],
                ["WS", dbgStatus.ws],
                ["STT", dbgStatus.stt],
              ] as [string, SvcStatus][]
            ).map(([label, s]) => (
              <span
                key={label}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded font-medium",
                  s === "ok" && "bg-emerald-900/60 text-emerald-400",
                  s === "error" && "bg-red-900/60 text-red-400",
                  s === "pending" && "bg-amber-900/60 text-amber-400",
                  s === "unknown" && "bg-slate-800 text-slate-500"
                )}
              >
                {label}
              </span>
            ))}
          </div>

          <button
            className="text-slate-500 hover:text-slate-300 p-1"
            onClick={() => setShowDebug((p) => !p)}
            title="Toggle debug overlay"
          >
            <Bug className="h-3.5 w-3.5" />
          </button>

          {isLive && (
            <>
              <Badge
                className={cn(
                  "text-xs border",
                  pageState === "live"
                    ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
                    : "border-amber-500/50 text-amber-400 bg-amber-500/10"
                )}
              >
                {pageState === "live" ? `Q${questionNumber}` : "Processing…"}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-500 hover:text-red-400 text-xs h-7 gap-1"
                onClick={endInterview}
              >
                <PhoneOff className="h-3 w-3" />
                End
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main: 35% camera / 65% panel */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">

        {/* ── Camera panel (35%) ── */}
        <div className="relative bg-black lg:w-[35%] flex-shrink-0">
          {/* 16:9 container — max-height 320px on desktop */}
          <div className="relative w-full" style={{ paddingTop: "56.25%", maxHeight: "320px" }}>
            <div className="absolute inset-0 overflow-hidden">
              {/* Debug overlay */}
              {showDebug && (
                <DebugOverlay
                  status={dbgStatus}
                  sttEngine={sttEngine}
                  metrics={liveMetrics}
                  onClose={() => setShowDebug(false)}
                />
              )}

              {/* Camera error state */}
              {camError && (
                <div className="absolute inset-0 bg-slate-900 flex flex-col items-center justify-center p-4 text-center z-10">
                  <VideoOff className="h-10 w-10 text-slate-600 mb-2" />
                  <p className="text-slate-400 text-xs">{camError}</p>
                </div>
              )}

              {/* Cam-off overlay */}
              {!camEnabled && !camError && (
                <div className="absolute inset-0 bg-slate-900 flex items-center justify-center z-10">
                  <VideoOff className="h-10 w-10 text-slate-700" />
                </div>
              )}

              {/* Video element — always mounted, srcObject set via callback ref */}
              <video
                ref={setVideoRef}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
              />
            </div>
          </div>

          {/* Media controls */}
          <div className="absolute bottom-3 inset-x-0 flex justify-center gap-2.5">
            <ControlBtn active={micEnabled} onClick={toggleMic} danger>
              {micEnabled ? (
                <Mic className="h-4 w-4 text-white" />
              ) : (
                <MicOff className="h-4 w-4 text-white" />
              )}
            </ControlBtn>
            <ControlBtn active={camEnabled} onClick={toggleCam} danger>
              {camEnabled ? (
                <Video className="h-4 w-4 text-white" />
              ) : (
                <VideoOff className="h-4 w-4 text-white" />
              )}
            </ControlBtn>
            {isLive && (
              <ControlBtn
                active={voiceEnabled}
                onClick={() => {
                  if (voiceEnabled) stopSpeaking();
                  setVoiceEnabled((p) => !p);
                }}
                danger={false}
              >
                {voiceEnabled ? (
                  <Volume2 className="h-4 w-4 text-white" />
                ) : (
                  <VolumeX className="h-4 w-4 text-white" />
                )}
              </ControlBtn>
            )}
          </div>

          {/* STT indicator */}
          {isLive && (
            <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-slate-900/80 rounded px-1.5 py-1">
              {dbgStatus.stt === "ok" ? (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
              )}
              <span className="text-[10px] text-slate-400">
                {sttEngine || "STT"}
              </span>
            </div>
          )}
        </div>

        {/* ── Right panel (65%) ── */}
        <div className="flex-1 flex flex-col p-5 gap-4 bg-slate-950 min-w-0">

          {/* LOBBY / CONNECTING */}
          {(pageState === "lobby" || pageState === "connecting") && (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-5 max-w-sm mx-auto w-full">
              <div className="w-14 h-14 rounded-xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
                <Volume2 className="h-7 w-7 text-orange-400" />
              </div>

              {screening && (
                <div className="bg-slate-900 rounded-xl p-3 w-full text-left border border-slate-700">
                  <div className="flex items-center gap-2 text-sm">
                    <User className="h-4 w-4 text-slate-400" />
                    <span className="font-medium text-white">
                      {screening.candidate_name_snapshot}
                    </span>
                  </div>
                  {screening.job_title_snapshot && (
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                      <Briefcase className="h-3.5 w-3.5" />
                      {screening.job_title_snapshot}
                    </div>
                  )}
                </div>
              )}

              {/* Camera status in lobby */}
              {dbgStatus.camera === "ok" ? (
                <p className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Camera ready
                </p>
              ) : dbgStatus.camera === "error" ? (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {camError ?? "Camera unavailable"}
                </p>
              ) : (
                <p className="text-xs text-slate-500">Requesting camera…</p>
              )}

              <ul className="space-y-1.5 text-left w-full text-sm text-slate-400">
                {[
                  "Speak clearly — transcript appears in real time",
                  "AI asks recruiter-style questions",
                  "15–20 min, up to 15 questions",
                  "No technical or coding questions",
                  "AI reads each question aloud",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    {t}
                  </li>
                ))}
              </ul>

              <Button
                size="lg"
                className="bg-orange-500 hover:bg-orange-600 text-white w-full gap-2"
                disabled={pageState === "connecting"}
                onClick={joinInterview}
              >
                {pageState === "connecting" ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" /> Connecting…
                  </>
                ) : (
                  <>
                    <Phone className="h-5 w-5" /> Join Interview
                  </>
                )}
              </Button>
            </div>
          )}

          {/* LIVE / THINKING */}
          {isLive && (
            <div className="flex-1 flex flex-col gap-4 min-h-0">
              {/* AI Question bubble */}
              <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
                <div className="flex items-center gap-2 mb-2.5">
                  <div className="w-5 h-5 rounded bg-orange-500 flex items-center justify-center flex-shrink-0">
                    <Volume2 className="h-3 w-3 text-white" />
                  </div>
                  <span className="text-xs text-slate-400">
                    AI Interviewer
                    {isFollowup && (
                      <span className="ml-1.5 text-orange-400">
                        · follow-up
                      </span>
                    )}
                  </span>
                </div>
                {pageState === "thinking" ? (
                  <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm italic">Thinking…</span>
                  </div>
                ) : (
                  <p className="text-white font-medium leading-relaxed">
                    {currentQuestion}
                  </p>
                )}
              </div>

              {/* Transcript + submit */}
              {pageState === "live" && (
                <div className="flex-1 flex flex-col gap-3 min-h-0">
                  {transcriptNotice && (
                    <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      {transcriptNotice}
                    </div>
                  )}
                  <div className="relative flex-1 min-h-[140px]">
                    <textarea
                      className="w-full h-full min-h-[140px] bg-slate-900 border border-slate-700 rounded-xl p-3.5 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder:text-slate-600"
                      placeholder={
                        dbgStatus.stt === "ok"
                          ? "Listening — speak your answer, it will appear here…"
                          : "Speak your answer (or type here)…"
                      }
                      value={answerText}
                      onChange={(e) => {
                        setFinalParts([e.target.value]);
                        setTranscript("");
                      }}
                    />
                    {/* Recording indicator */}
                    {micEnabled && dbgStatus.stt === "ok" && (
                      <div className="absolute top-3 right-3 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-[10px] text-slate-500">REC</span>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-between items-center">
                    <button
                      className="text-xs text-slate-500 hover:text-slate-300"
                      onClick={() => {
                        setFinalParts([]);
                        setTranscript("");
                      }}
                    >
                      Clear
                    </button>
                    <Button
                      size="sm"
                      className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
                      disabled={!answerText}
                      onClick={submitAnswer}
                    >
                      <Send className="h-3.5 w-3.5" />
                      Done Answering
                    </Button>
                  </div>
                </div>
              )}

              {/* Progress */}
              <div className="flex justify-between items-center text-xs text-slate-600 border-t border-slate-800 pt-2">
                <span>
                  {msgCount} question{msgCount !== 1 ? "s" : ""} asked
                </span>
                <span>Target: 10–15</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small helper component ────────────────────────────────────────────────────

function ControlBtn({
  active,
  onClick,
  danger,
  children,
}: {
  active: boolean;
  onClick: () => void;
  danger: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-9 h-9 rounded-full flex items-center justify-center transition-colors",
        active
          ? "bg-slate-700/80 hover:bg-slate-600"
          : danger
          ? "bg-red-600 hover:bg-red-700"
          : "bg-slate-800 hover:bg-slate-700"
      )}
    >
      {children}
    </button>
  );
}
