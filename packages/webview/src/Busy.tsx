import { useEffect, useState } from "preact/hooks";

export function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}

export function BusyNote({ label }: { label: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div class="busy" role="status" aria-live="polite">
      <Spinner /> {label}
      {secs >= 2 ? <span class="busy-elapsed" aria-hidden="true"> · {secs}s</span> : null}
    </div>
  );
}
