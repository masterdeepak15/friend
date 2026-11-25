/** Where a service sends the owner back after they approve. Built from whoever hosts this Friend, never from a fixed address. */
export function redirectUri(publicUrl: string | null, port: number): string {
  const base = publicUrl ? publicUrl.replace(/\/+$/, "") : `http://127.0.0.1:${port}`;
  return `${base}/api/oauth/callback`;
}
