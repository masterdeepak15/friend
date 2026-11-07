import { useEffect, useRef } from "react";
import type { CameraStill } from "../store";

/**
 * Drawn by the client, never by the agent. While the camera is open it shows what the camera sees, live; right after a look it keeps
 * the picture that was taken and what was found in it for a few seconds, so the owner can tell what the assistant saw.
 */
export function CameraIndicator({ stream, still = null }: { stream: MediaStream | null; still?: CameraStill | null }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    void Promise.resolve(el.play?.()).catch(() => {}); // autoplay may be refused; the picture is optional
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  if (!stream && !still) return null;
  return (
    <div className="camera-indicator glass" role="status" style={{ pointerEvents: "none" }}>
      {stream ? <video ref={video} muted playsInline autoPlay aria-hidden="true" /> : <img src={still!.url} alt="The last picture the camera took" />}
      <span>{stream ? "Camera on" : still!.note}</span>
    </div>
  );
}
