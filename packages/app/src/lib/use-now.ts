import { useEffect, useState } from "react";

export function useNow(enabled: boolean) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return now;
}
