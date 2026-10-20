import { Radar, type Blip } from "../kit";

/** The sources Friend really knows about: this screen, the PC's agent and the voice. An offline one is dim, never left out or invented. */
export function RadarWidget({ deviceOnline, voiceAvailable, blips }: { deviceOnline: boolean; voiceAvailable: boolean; blips?: Blip[] }) {
  return (
    <svg className="ob-wsvg" viewBox="0 0 250 270">
      <text className="ob-lab" x="20" y="21">DEVICES · RADAR</text>
      <Radar
        frame={{ x: 10, y: 25, w: 240, h: 240 }}
        blips={
          blips ?? [
            { angle: 40, distance: 0.45, label: "This screen" },
            { angle: 150, distance: 0.7, label: "PC", dim: !deviceOnline },
            { angle: 250, distance: 0.6, label: "Voice", dim: !voiceAvailable },
          ]
        }
      />
    </svg>
  );
}