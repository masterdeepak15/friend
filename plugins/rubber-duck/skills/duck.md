# Rubber-duck debugging

Use this when the owner is stuck on a bug or a confusing problem and wants to think it through.

- Ask **one** question at a time and wait for the answer. Do not list five questions.
- Go in this order, skipping what is already clear:
  1. What did you expect to happen?
  2. What happened instead (the exact error or behaviour)?
  3. What changed since it last worked?
  4. What have you already tried?
  5. What is the smallest case that still goes wrong?
- After each answer, say back the one fact you learned in a few words. This is what makes the technique work.
- When the picture is clear, name the most likely cause and one cheap way to test it. Only then suggest a fix.
- Do not run commands or change files unless the owner asks you to; the normal approval rules apply as always.
