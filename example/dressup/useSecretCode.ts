import { useEffect, useState } from "react";

/**
 * Cheat-code listener. Buffer every printable key typed anywhere on the page;
 * when the tail of the buffer spells the secret phrase, the mode unlocks.
 * Escape closes it. Typing the phrase makes the character run around and jump
 * (W, A, space...) — that is not a bug, that is the ritual.
 */
export function useSecretCode(phrase: string) {
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const target = phrase.toLowerCase();
    let buffer = "";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setUnlocked(false);
        buffer = "";
        return;
      }
      if (e.key.length !== 1) return; // printable keys only
      buffer = (buffer + e.key.toLowerCase()).slice(-target.length);
      if (buffer === target) {
        setUnlocked(true);
        buffer = "";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phrase]);

  return [unlocked, setUnlocked] as const;
}
