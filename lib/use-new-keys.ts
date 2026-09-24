import { useEffect, useState } from "react";

export interface NewKeysState { seen: ReadonlySet<string> | null; fresh: ReadonlySet<string> }

/** The first list is only remembered; later arrivals become "fresh" and stay
 * so while listed; departed keys are forgotten. */
export function nextNewKeys(previous: NewKeysState, listed: readonly string[]): NewKeysState {
  if (previous.seen === null) return { seen: new Set(listed), fresh: previous.fresh };
  const arrived = listed.filter((key) => !previous.seen!.has(key));
  const stillListed = new Set(listed);
  const fresh = new Set([...previous.fresh].filter((key) => stillListed.has(key)).concat(arrived));
  if (!arrived.length && fresh.size === previous.fresh.size) return previous;
  return { seen: new Set([...previous.seen, ...arrived].slice(-500)), fresh };
}

/** Keys that arrived after the first render, so only new list items animate
 * in (a page load doesn't shake its whole list). Recorded in an effect: the
 * class lands a frame after mount, which is when its CSS animation starts. */
export function useNewKeys(keys: readonly string[]): ReadonlySet<string> {
  const joined = keys.join("|");
  const [state, setState] = useState<NewKeysState>({ seen: null, fresh: new Set() });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((previous) => nextNewKeys(previous, joined ? joined.split("|") : []));
  }, [joined]);
  return state.fresh;
}
