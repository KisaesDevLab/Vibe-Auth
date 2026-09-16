import { useEffect, useState } from "react";
import { authClient, type AuthStatusDto, type ClientOptions } from "./api.js";

/** Polls GET /auth/status once; returns { status, error, reload }. */
export function useAuthStatus(o: ClientOptions = {}) {
  const [status, setStatus] = useState<AuthStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    authClient(o)
      .status()
      .then((s) => alive && setStatus(s))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.basePath, tick]);
  return { status, error, reload: () => setTick((t) => t + 1) };
}
