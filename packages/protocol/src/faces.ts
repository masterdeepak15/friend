/**
 * Two faces count as the same person at or above this cosine similarity of their 128 numbers (SFace). OpenCV publishes 0.363, but on
 * our photos two different older men reached 0.367 while one person scored 0.75 to 0.80, so it is set well above: a wrong name is
 * worse than a missed one. Used by the browser (for the check on its own) and by the server (the match that counts).
 */
export const FACE_SIMILARITY_THRESHOLD = 0.55;
