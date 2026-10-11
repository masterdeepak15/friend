/** What to tell the owner when Spotify's sign-in sends them back to Friend (`/?music=connected` or `/?music=failed`), or null for any other address. */
export function musicReturnNotice(search: string): { level: "info" | "warn"; text: string } | null {
  const v = new URLSearchParams(search).get("music");
  if (v === "connected") return { level: "info", text: "Spotify is connected. Ask Friend to play something." };
  if (v === "failed") return { level: "warn", text: "Spotify did not connect. Open Plugins, Spotify and press Connect again." };
  return null;
}
