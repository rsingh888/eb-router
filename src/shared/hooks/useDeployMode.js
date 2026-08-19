"use client";

import { useEffect, useState } from "react";

export function useDeployMode() {
  const [saas, setSaas] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // /api/health is public and does not touch the DB (auth/status can 500 if Postgres is down).
    fetch("/api/health", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setSaas(data?.saas === true || data?.deployMode === "saas");
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { saas, onPrem: !saas, ready };
}
