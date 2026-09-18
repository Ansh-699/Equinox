"use client";

import { useSyncExternalStore } from "react";
import { getLastSignature, subscribeLastSignature, type LastSignatureRecord } from "./last-signature";

export function useLastSignature(): LastSignatureRecord | null {
  return useSyncExternalStore(subscribeLastSignature, getLastSignature, () => null);
}
