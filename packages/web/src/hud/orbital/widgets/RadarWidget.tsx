import { Radar } from "../kit";

/** The sources Friend really knows about: this screen, the PC's agent and the voice. An offline one is dim, never left out or invented. */
export function RadarWidget({ deviceOnline, voiceAvailable }: { deviceOnline: boolean; voiceAvailable: boolean }) {
  return (
    <Radar
      blips={[
        { angle: 40, distance: 0.45, label: "This screen" },
        { angle: 150, distance: 0.7, label: "PC", dim: !deviceOnline },
        { angle: 250, distance: 0.6, label: "Voice", dim: !voiceAvailable },
      ]}
    />
  );
}