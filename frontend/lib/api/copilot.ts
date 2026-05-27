import { API_BASE_URL, apiRequest, getWsApiBase } from "@/lib/api/client";
import type { TranscriptSpeaker } from "@/lib/api/types";
import type {
  CopilotWsEvent,
  TranscriptSegment,
  TranscriptSegmentPayload,
} from "@/lib/api/types";

const base = (interviewId: string) =>
  `/interviews/${interviewId}/copilot`;

// ── Session ───────────────────────────────────────────────────────────────────

/** Create or retrieve the copilot session for this interview. */
export async function startCopilotSession(
  interviewId: string
): Promise<{ id: string; status: string }> {
  return apiRequest<{ id: string; status: string }>(`${base(interviewId)}/session`, {
    method: "POST",
  }, 0);
}

/** Get the existing copilot session (throws 404 if not started). */
export async function getCopilotSession(
  interviewId: string
): Promise<{ id: string; status: string }> {
  return apiRequest<{ id: string; status: string }>(`${base(interviewId)}/session`, {}, 0);
}

// ── Transcript ────────────────────────────────────────────────────────────────

export async function addTranscriptSegment(
  interviewId: string,
  payload: TranscriptSegmentPayload
): Promise<TranscriptSegment> {
  return apiRequest<TranscriptSegment>(`${base(interviewId)}/transcript`, {
    method: "POST",
    body: JSON.stringify(payload),
  }, 0);
}

/**
 * POST an audio blob to the backend Whisper transcription endpoint.
 *
 * Returns the saved TranscriptSegment, or null when the audio was too short /
 * silent to produce a transcription or OpenAI is not configured.
 *
 * Uses raw fetch (not apiRequest) because multipart/form-data requires the
 * browser to set the Content-Type boundary automatically — apiRequest force-
 * sets "Content-Type: application/json" which breaks FormData uploads.
 */
export async function transcribeAudioChunk(
  interviewId: string,
  audioBlob: Blob,
  speaker: TranscriptSpeaker | "interviewer" | "candidate" | "unknown",
): Promise<TranscriptSegment | null> {
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("airis_access_token")
      : null;

  // Derive the correct file extension from the blob MIME type so the backend
  // can pass the right filename to Whisper's file parser.
  const ext = audioBlob.type.includes("ogg") ? "ogg" : "webm";

  const formData = new FormData();
  formData.append("audio", audioBlob, `chunk.${ext}`);
  formData.append("speaker", speaker);
  formData.append("language", "en");

  // Build the full URL.  API_BASE_URL is "/api/v1" in the browser (proxied by
  // Next.js) and the direct backend URL during SSR — this function is client-
  // only so we always hit the proxy path.
  const url = `${API_BASE_URL}/interviews/${interviewId}/copilot/transcribe-audio`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      // DO NOT set Content-Type — the browser sets "multipart/form-data; boundary=..."
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
  } catch {
    return null; // network error — caller can retry on the next chunk
  }

  if (!resp.ok) return null;

  const text = await resp.text();
  if (!text || text === "null") return null;

  try {
    return JSON.parse(text) as TranscriptSegment;
  } catch {
    return null;
  }
}

export async function getTranscript(
  interviewId: string,
  limit = 200,
  offset = 0
): Promise<TranscriptSegment[]> {
  return apiRequest<TranscriptSegment[]>(
    `${base(interviewId)}/transcript?limit=${limit}&offset=${offset}`,
    {},
    0
  );
}

// ── AssemblyAI realtime ───────────────────────────────────────────────────────

/**
 * Request the AssemblyAI API token from the AIRIS backend.
 *
 * The backend returns the token so the browser never holds the raw API key
 * in build artefacts or environment variables.
 */
export async function getAssemblyAIToken(
  interviewId: string
): Promise<{ token: string }> {
  return apiRequest<{ token: string }>(
    `${base(interviewId)}/assemblyai-token`,
    {},
    0
  );
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

/**
 * Open a WebSocket connection to the copilot real-time channel.
 *
 * Used by TranscriptPanel to receive `transcript_added` push events so the
 * transcript list updates without polling.
 *
 * Usage:
 *   const ws = openCopilotWs(interviewId, token, {
 *     onEvent: (evt) => { ... },
 *     onClose: () => { ... },
 *   });
 *   // later: ws.close()
 */
export function openCopilotWs(
  interviewId: string,
  token: string,
  handlers: {
    onEvent?: (event: CopilotWsEvent) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (err: Event) => void;
  }
): WebSocket {
  const wsBase = getWsApiBase();
  const url = `${wsBase}/interviews/${interviewId}/copilot/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);

  ws.onopen = () => handlers.onOpen?.();

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string) as CopilotWsEvent;
      handlers.onEvent?.(data);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => handlers.onClose?.();
  ws.onerror = (err) => handlers.onError?.(err);

  return ws;
}

/** Send a ping to keep the WS alive. */
export function sendWsPing(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}
