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

interface InterviewSummary {
  overall_score?: number | null;
  recommendation?: string | null;
  ai_summary?: string | null;
  duration_seconds?: number | null;
  strengths?: string[];
  concerns?: string[];
}

// ── Web Speech API TTS helper ─────────────────────────────────────────────────

function speak(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel(); // stop any current speech
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
  if (onEnd) utterance.onend = onEnd;
  synth.speak(utterance);
}

function stopSpeaking(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
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

  const start = useCallback(
    async (stream: MediaStream) => {
      if (!options.token || wsRef.current?.readyState === WebSocket.OPEN) return;

      // Connect to AssemblyAI realtime WebSocket
      const aaiWs = new WebSocket(
        `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&encoding=pcm_s16le&token=${options.token}`
      );
      wsRef.current = aaiWs;

      aaiWs.onopen = () => {
        // Set up Web Audio API to capture mic as PCM
        const AudioContext = window.AudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        sourceRef.current = src;
        // ScriptProcessor (deprecated but widely supported) for PCM extraction
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (aaiWs.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          // Convert float32 to int16 PCM
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          aaiWs.send(int16.buffer);
        };
        src.connect(processor);
        processor.connect(ctx.destination);
      };

      aaiWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.message_type === "PartialTranscript" && data.text) {
            options.onPartial(data.text);
          } else if (data.message_type === "FinalTranscript" && data.text) {
            options.onFinal(data.text);
          }
        } catch {
          /* ignore parse errors */
        }
      };

      aaiWs.onerror = () => console.error("[AssemblyAI] WebSocket error");
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

  // AssemblyAI hook
  const { start: startSTT, stop: stopSTT } = useAssemblyAI({
    token: aaiTokenRef.current,
    active: pageState === "live",
    onPartial: (text) => setLiveTranscript(text),
    onFinal: (text) => {
      setFinalTranscripts((prev) => [...prev, text]);
      // Forward to backend WS
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
          setSummary({
            overall_score: data.overall_score,
            recommendation: data.recommendation,
            ai_summary: data.ai_summary,
            duration_seconds: data.duration_seconds,
            strengths: data.strengths ?? [],
            concerns: data.concerns ?? [],
          });
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
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => {
        setErrorMsg(
          "Camera or microphone access denied. Please allow access and reload."
        );
        setPageState("error");
      });
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
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

  // ── Join interview ──────────────────────────────────────────────────────────

  const joinInterview = useCallback(async () => {
    if (!session) return;
    setPageState("connecting");

    // 1. Get AssemblyAI token from backend
    try {
      if (session.session_token) {
        const { token: aaiToken } = await getAssemblyAIToken(
          session.id,
          session.session_token
        );
        aaiTokenRef.current = aaiToken;
      }
    } catch {
      // AssemblyAI token is optional — fall back to manual text input
    }

    // 2. Connect to backend WebSocket
    const apiBase =
      process.env.NEXT_PUBLIC_API_BACKEND_URL?.replace(/^https?/, "ws")?.replace(
        "/api/v1",
        ""
      ) ?? "ws://127.0.0.1:8000";
    const wsUrl = `${apiBase}/api/v1/ai-screenings/ws/${session.id}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setPageState("live");
      // Start AssemblyAI STT if we have a token
      if (aaiTokenRef.current && streamRef.current) {
        startSTT(streamRef.current);
      }
    };

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data as string));
      } catch {
        /* ignore */
      }
    };

    ws.onerror = () => {
      setErrorMsg("Lost connection to interview server. Please reload.");
      setPageState("error");
    };

    ws.onclose = () => {
      stopSTT();
    };
  }, [session, startSTT, stopSTT]);

  useEffect(
    () => () => {
      stopSTT();
      stopSpeaking();
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
    [stopSTT]
  );

  // ── Handle WebSocket messages ───────────────────────────────────────────────

  const handleWsMessage = useCallback(
    (msg: {
      type: string;
      text?: string;
      number?: number;
      followup?: boolean;
      summary?: InterviewSummary;
      message?: string;
    }) => {
      if (msg.type === "question") {
        const q = msg.text ?? "";
        setCurrentQuestion(q);
        setQuestionNumber(msg.number ?? 1);
        setIsFollowup(msg.followup ?? false);
        setLiveTranscript("");
        setFinalTranscripts([]);
        setPageState("live");
        // AI speaks the question aloud
        if (aiVoiceEnabled) {
          speak(q);
        }
        // Add to history
        setHistory((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "interviewer",
            content: q,
            sequence_number: (prev.length + 1),
            question_number: msg.number ?? null,
            is_followup: msg.followup ?? false,
            created_at: new Date().toISOString(),
          },
        ]);
      } else if (msg.type === "thinking") {
        setPageState("ai_thinking");
        stopSpeaking();
      } else if (msg.type === "interview_end") {
        setSummary(msg.summary ?? null);
        stopSTT();
        stopSpeaking();
        setPageState("completed");
        ws.close?.();
      } else if (msg.type === "error") {
        console.error("[WS Error]", msg.message);
      }
    },
    [aiVoiceEnabled, stopSTT]
  );

  // ── Submit answer ───────────────────────────────────────────────────────────

  const submitAnswer = () => {
    const fullAnswer = [...finalTranscripts, liveTranscript]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!fullAnswer || !wsRef.current) return;

    // Add to history
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
        <Card className="max-w-lg w-full bg-slate-900 border-slate-700">
          <CardContent className="p-8 text-center space-y-5">
            <CheckCircle2 className="h-16 w-16 text-emerald-400 mx-auto" />
            <h2 className="text-2xl font-bold text-white">Interview Complete</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Thank you for completing the AI screening interview. Your recruiter
              will review your responses and be in touch shortly.
            </p>
            {summary?.overall_score != null && (
              <div className="bg-slate-800 rounded-xl p-4 space-y-1">
                <p className="text-xs text-slate-400">Overall Score</p>
                <p className="text-3xl font-bold text-orange-400">
                  {summary.overall_score.toFixed(0)}
                  <span className="text-sm text-slate-400"> / 100</span>
                </p>
                {summary.recommendation && (
                  <p className="text-sm text-slate-300 capitalize">
                    {summary.recommendation.replace("_", " ")}
                  </p>
                )}
              </div>
            )}
            {summary?.ai_summary && (
              <p className="text-slate-400 text-sm italic leading-relaxed">
                {summary.ai_summary}
              </p>
            )}
            <p className="text-xs text-slate-600">
              {history.filter((m) => m.role === "interviewer").length} questions ·{" "}
              {summary?.duration_seconds
                ? `${Math.round(summary.duration_seconds / 60)} min`
                : "Interview finished"}
            </p>
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

              <ul className="space-y-2 text-left text-sm text-slate-400 max-w-xs w-full">
                {[
                  "Speak clearly into your microphone",
                  "Answer fully before clicking Done",
                  "15–20 minute interview, ~15 questions",
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
