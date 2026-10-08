import { useEffect, useRef } from "react";

/** Drawn by the client, never by the agent: shown for exactly as long as the camera is open. */
export function CameraIndicator({ stream }: { stream: MediaStream }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    void Promise.resolve(el.play?.()).catch(() => {}); // autoplay may be refused; the thumbnail is optional
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="camera-indicator glass" role="status" style={{ pointerEvents: "none" }}>
      <video ref={video} muted playsInline autoPlay aria-hidden="true" />
      <span>Camera on</span>
    </div>
  );
}
