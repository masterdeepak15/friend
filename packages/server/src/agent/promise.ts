/**
 * Small local models often announce an action ("I'll fetch the system information now.") and then stop without
 * calling the tool. This spots such a reply so the loop can ask the model once to actually do it.
 */
const PROMISE =
  /\b(?:i['’]ll|i will|let me|let['’]s(?: go ahead and)?|i['’]m going to|i am going to|going to)\b[^.!?\n]{0,80}?\b(?:fetch|get|run|check|show|display|look up|pull up|retrieve|find|open|list|gather|collect|read|create|draw|build)\b/i;

export function promisesAction(reply: string): boolean {
  const tail = reply.trim().slice(-220); // what the reply ends with is what it leaves undone
  if (!tail || /\?\s*$/.test(tail)) return false; // a question to the owner is not a promise
  return PROMISE.test(tail);
}
