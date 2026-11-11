export function WelcomeStep({ onStart }: { onStart(): void }) {
  return (
    <div class="form">
      <p>Stewart needs at least one <b>model source</b> to work. This wizard sets that up in a few minutes:</p>
      <ul>
        <li><b>Channel</b> — where models come from (Ollama on your machine, an OpenAI-compatible service with an API key, or the Claude CLI).</li>
        <li><b>Agent</b> — one model on one channel.</li>
        <li><b>Role</b> — a job (orchestrator, planner, code-writer…). Each role is given the best-suited agent.</li>
      </ul>
      <p class="hint">You can re-run this any time from Settings → Run setup. Prefer to configure by hand? Close this and use the tabs below.</p>
      <div class="row"><button class="send" onClick={onStart}>Start</button></div>
    </div>
  );
}
