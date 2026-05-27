"use client";

/**
 * LiveKitRoom
 *
 * Embedded video conference built directly on the livekit-client SDK.
 * No @livekit/components-react dependency — avoids ESM/Webpack resolution
 * issues in Next.js 15 while keeping full LiveKit functionality.
 *
 * What it does:
 *  - Fetches a signed token from the AIRIS backend (POST /interviews/{id}/livekit/token)
 *  - Connects to the LiveKit room server over WebSocket
 *  - Renders remote participant video tiles + local camera preview
 *  - Provides mic / camera / screen-share / leave controls
 *  - Fires onConnected / onDisconnected / onNotConfigured for MeetingContainer
 *
 * No popups. No iframes. No external windows.
 *
 * ── React Strict Mode safety ──────────────────────────────────────────────────
 * React 18 (used by Next.js 15) double-invokes effects in development to help
 * detect side-effect bugs. The naïve pattern of calling an async `connect()`
 * inside a useEffect creates TWO Room instances: cleanup from the first invocation
 * disconnects a room that may still be mid-connection, which fires a Disconnected
 * event that corrupts parent state and causes a visible connect→disconnect loop.
 *
 * The fix: inline the async logic directly inside useEffect with a local `active`
 * boolean that is set to false by the cleanup function. Every async continuation
 * and every Room event handler checks `active` before touching React state or
 * calling parent callbacks. When Strict Mode's cleanup fires, `active = false`
 * silences the stale Room's events and the second invocation starts clean.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  setLogLevel,
} from "livekit-client";

// Suppress noisy internal LiveKit DataChannel error events.
// These fire from WebRTC's onerror handler on the 'lossy' / 'reliable'
// internal data channels when the connection tears down or receives an
// unrecognisable message — they don't indicate a real application error.
setLogLevel("silent");
import { getLiveKitToken } from "@/lib/api/livekit";
import { useLiveKitRoom } from "@/contexts/LiveKitContext";
import { ApiError } from "@/lib/api/client";
import {
  Loader2,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Video,
  VideoOff,
  WifiOff,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────

type Phase =
  | "idle"
  | "fetching_token"
  | "connecting"
  | "connected"
  | "error";

type VideoTrackEntry = {
  participantSid: string;
  participantName: string;
  trackSid: string;
  track: Track;
  isLocal: boolean;
};

// ── VideoTile — attaches a LiveKit Track to a <video> element ─────────────

function VideoTile({
  entry,
  isMain,
}: {
  entry: VideoTrackEntry;
  isMain: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    entry.track.attach(el);
    return () => { entry.track.detach(el); };
  }, [entry.track]);

  return (
    <div
      className={`relative bg-gray-800 rounded-lg overflow-hidden flex items-center justify-center ${
        isMain ? "col-span-2 row-span-2" : ""
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={entry.isLocal}
        className="w-full h-full object-cover"
      />
      <span className="absolute bottom-2 left-2 text-[10px] font-medium text-white/80 bg-black/40 px-1.5 py-0.5 rounded">
        {entry.isLocal ? "You" : entry.participantName || "Participant"}
      </span>
    </div>
  );
}

// ── AudioAttacher — mounts remote audio tracks to invisible <audio> elements

function AudioTrack({ track }: { track: Track }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
}

// ── Main component ────────────────────────────────────────────────────────

type Props = {
  interviewId: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /**
   * Fired when the backend returns 503 (LiveKit not configured).
   * MeetingContainer uses this to fall back to the external-link panel.
   */
  onNotConfigured?: () => void;
};

export function LiveKitRoom({ interviewId, onConnected, onDisconnected, onNotConfigured }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Local media toggles
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);

  // Track collections for rendering
  const [videoTracks, setVideoTracks] = useState<VideoTrackEntry[]>([]);
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);

  // Incrementing this causes the connection effect to re-run (manual retry).
  const [reconnectKey, setReconnectKey] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const connectedFiredRef = useRef(false);

  // Publish the Room instance to LiveKitContext so TranscriptPanel can access
  // the audio tracks without requiring props drilling through the whole tree.
  const liveKitContextRoomRef = useLiveKitRoom();

  // ── Stable callback refs ─────────────────────────────────────────────
  // Props stored in refs so the connection effect (which must remain stable)
  // can always call the latest version without being listed as a dep.
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onNotConfiguredRef = useRef(onNotConfigured);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  useEffect(() => { onDisconnectedRef.current = onDisconnected; }, [onDisconnected]);
  useEffect(() => { onNotConfiguredRef.current = onNotConfigured; }, [onNotConfigured]);

  // ── Track state helpers ─────────────────────────────────────────────

  const rebuildTracks = useCallback((room: Room) => {
    const videos: VideoTrackEntry[] = [];
    const audios: Track[] = [];

    // Local participant video
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      if (pub.track && pub.track.kind === Track.Kind.Video) {
        videos.push({
          participantSid: room.localParticipant.sid,
          participantName: room.localParticipant.name ?? "",
          trackSid: pub.trackSid,
          track: pub.track,
          isLocal: true,
        });
      }
    });

    // Remote participants
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (!pub.track) return;
        if (pub.track.kind === Track.Kind.Video) {
          videos.push({
            participantSid: participant.sid,
            participantName: participant.name ?? "",
            trackSid: pub.trackSid,
            track: pub.track,
            isLocal: false,
          });
        } else if (pub.track.kind === Track.Kind.Audio) {
          audios.push(pub.track);
        }
      });
    });

    setVideoTracks(videos);
    setAudioTracks(audios);
  }, []);

  // ── Core connection effect ─────────────────────────────────────────────
  //
  // The `active` flag is the key to React Strict Mode safety.
  //
  // In development, React 18 double-invokes this effect:
  //   1. Setup runs  (active = true)
  //   2. Cleanup runs (active = false, room disconnected)
  //   3. Setup runs again (active = true, fresh connection)
  //
  // Every async continuation and every Room event handler checks `active`
  // before calling setState or parent callbacks, so the stale first-pass
  // Room is completely silenced once its cleanup fires.
  //
  // In production this behaves identically to a normal useEffect: runs once
  // on mount, cleanup on unmount.
  //
  // `reconnectKey` is incremented by the "Try again" button to force a retry.

  useEffect(() => {
    let active = true;

    setPhase("fetching_token");
    setErrorMsg("");
    connectedFiredRef.current = false;

    void (async () => {
      // ── 1. Fetch token ─────────────────────────────────────────────────
      let token: string;
      let wsUrl: string;
      try {
        const data = await getLiveKitToken(interviewId);
        token = data.token;
        wsUrl = data.ws_url;
      } catch (err: unknown) {
        if (!active) return; // cleanup ran while we were waiting — abort
        if (err instanceof ApiError && err.status === 503) {
          onNotConfiguredRef.current?.();
          return;
        }
        setPhase("error");
        setErrorMsg(err instanceof Error ? err.message : "Token request failed.");
        return;
      }

      if (!active) return; // cleanup fired between token fetch and room creation

      // ── 2. Create room and wire events ────────────────────────────────
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      });
      roomRef.current = room;
      // Share with TranscriptPanel (and any other consumer) via context.
      liveKitContextRoomRef.current = room;

      room
        .on(RoomEvent.TrackSubscribed,      () => { if (active) rebuildTracks(room); })
        .on(RoomEvent.TrackUnsubscribed,    () => { if (active) rebuildTracks(room); })
        .on(RoomEvent.LocalTrackPublished,  () => { if (active) rebuildTracks(room); })
        .on(RoomEvent.LocalTrackUnpublished,() => { if (active) rebuildTracks(room); })
        .on(RoomEvent.ParticipantConnected, () => { if (active) rebuildTracks(room); })
        .on(RoomEvent.ParticipantDisconnected, () => { if (active) rebuildTracks(room); })
        .on(RoomEvent.Disconnected, () => {
          if (!active) return; // stale room from Strict Mode first-pass — ignore
          connectedFiredRef.current = false;
          setPhase("idle");
          onDisconnectedRef.current?.();
        })
        .on(RoomEvent.Connected, () => {
          if (!active) return; // stale room — ignore
          if (!connectedFiredRef.current) {
            connectedFiredRef.current = true;
            setPhase("connected");
            rebuildTracks(room);
            onConnectedRef.current?.();
          }
        });

      setPhase("connecting");

      // ── 3. Connect ────────────────────────────────────────────────────
      try {
        await room.connect(wsUrl, token);
      } catch (err: unknown) {
        if (!active) return;
        setPhase("error");
        setErrorMsg(err instanceof Error ? err.message : "Could not connect to meeting room.");
      }
    })();

    // Cleanup: silence this effect's room so its events don't corrupt state,
    // then disconnect it to release the LiveKit server-side participant slot.
    return () => {
      active = false;            // silences all event handlers and async continuations
      const r = roomRef.current;
      roomRef.current = null;    // clear ref before disconnect so leave() doesn't double-disconnect
      liveKitContextRoomRef.current = null; // clear context so TranscriptPanel stops recording
      r?.disconnect();
    };
    // reconnectKey: intentionally included so "Try again" button forces a new connection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId, reconnectKey]);
  // NOTE: rebuildTracks and callback refs are intentionally omitted from deps —
  // rebuildTracks is stable (empty deps), and callbacks live in refs above.

  // ── Media controls ───────────────────────────────────────────────────

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (camOn) {
      room.localParticipant.videoTrackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Camera) {
          void room.localParticipant.unpublishTrack(pub.track!);
        }
      });
      setCamOn(false);
    } else {
      try {
        const track = await createLocalVideoTrack();
        await room.localParticipant.publishTrack(track);
        setCamOn(true);
      } catch {
        // User denied camera access
      }
    }
  }, [camOn]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (micOn) {
      room.localParticipant.audioTrackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Microphone) {
          void room.localParticipant.unpublishTrack(pub.track!);
        }
      });
      setMicOn(false);
    } else {
      try {
        const track = await createLocalAudioTrack();
        await room.localParticipant.publishTrack(track);
        setMicOn(true);
      } catch {
        // User denied mic access
      }
    }
  }, [micOn]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (screenOn) {
      await room.localParticipant.setScreenShareEnabled(false);
      setScreenOn(false);
    } else {
      try {
        await room.localParticipant.setScreenShareEnabled(true);
        setScreenOn(true);
      } catch {
        // User cancelled screen share picker
      }
    }
  }, [screenOn]);

  const leave = useCallback(() => {
    roomRef.current?.disconnect();
  }, []);

  // ── Render ───────────────────────────────────────────────────────────

  if (phase === "idle" || phase === "fetching_token" || phase === "connecting") {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3 text-white/70">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="text-sm">
            {phase === "fetching_token" ? "Preparing room…" : "Connecting…"}
          </p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900 p-6">
        <div className="text-center space-y-4 max-w-xs">
          <WifiOff className="w-10 h-10 text-red-400 mx-auto" />
          <p className="text-sm font-semibold text-white">Could not join meeting room</p>
          <p className="text-xs text-white/50">{errorMsg}</p>
          <button
            onClick={() => setReconnectKey((k) => k + 1)}
            className="text-xs px-4 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // connected
  const hasVideo = videoTracks.length > 0;

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {/* Video grid */}
      <div className="flex-1 min-h-0 p-2">
        {hasVideo ? (
          <div
            className={`h-full grid gap-2 ${
              videoTracks.length === 1
                ? "grid-cols-1"
                : videoTracks.length <= 4
                ? "grid-cols-2"
                : "grid-cols-3"
            }`}
          >
            {videoTracks.map((entry, i) => (
              <VideoTile key={entry.trackSid} entry={entry} isMain={i === 0 && videoTracks.length > 2} />
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2 text-white/40">
              <Video className="w-12 h-12 mx-auto opacity-30" />
              <p className="text-xs">
                {roomRef.current && roomRef.current.remoteParticipants.size > 0
                  ? "Waiting for participants to enable video…"
                  : "Waiting for others to join…"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Hidden audio players for remote participants */}
      {audioTracks.map((track) => (
        <AudioTrack key={track.sid} track={track} />
      ))}

      {/* Control bar */}
      <div className="shrink-0 flex items-center justify-center gap-3 px-4 py-3 bg-gray-800 border-t border-gray-700">
        <button
          onClick={() => void toggleMic()}
          className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors ${
            micOn ? "bg-gray-700 text-white" : "bg-red-500/20 text-red-400"
          }`}
          title={micOn ? "Mute" : "Unmute"}
        >
          {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          <span className="text-[9px]">{micOn ? "Mute" : "Unmuted"}</span>
        </button>

        <button
          onClick={() => void toggleCamera()}
          className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors ${
            camOn ? "bg-gray-700 text-white" : "bg-red-500/20 text-red-400"
          }`}
          title={camOn ? "Stop camera" : "Start camera"}
        >
          {camOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          <span className="text-[9px]">{camOn ? "Camera" : "Camera off"}</span>
        </button>

        <button
          onClick={() => void toggleScreenShare()}
          className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors ${
            screenOn ? "bg-blue-500/30 text-blue-300" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
          title={screenOn ? "Stop sharing" : "Share screen"}
        >
          <Monitor className="w-5 h-5" />
          <span className="text-[9px]">{screenOn ? "Sharing" : "Share"}</span>
        </button>

        <button
          onClick={leave}
          className="flex flex-col items-center gap-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-colors"
          title="Leave meeting"
        >
          <PhoneOff className="w-5 h-5" />
          <span className="text-[9px]">Leave</span>
        </button>
      </div>
    </div>
  );
}
