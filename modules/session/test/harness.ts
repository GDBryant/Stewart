import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import { settingsFile } from "@stewart/config";
import { counterIds, fakeHost, systemClock, type HostPort } from "@stewart/kernel";
import { Interaction } from "@stewart/interaction";
import { Permissions } from "@stewart/permissions";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { RunEvent } from "@stewart/protocol";
import { SessionService, type SessionDeps } from "../src/api.js";

export function fakeChannel(turns: ChatEvent[][]): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {
      for (const ev of turns[Math.min(i++, turns.length - 1)]) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

/** Engine that replays a script of steps; each step may inspect the turn before yielding events. */
export function scriptedEngine(steps: ((turn: EngineTurn) => AsyncGenerator<EngineEvent, void>)[]): Engine {
  let n = 0;
  return {
    id: "native-loop",
    run(turn: EngineTurn) {
      const step = steps[Math.min(n++, steps.length - 1)];
      return step(turn);
    },
  };
}

export function makeConfig(over: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    channels: [{ id: "c", type: "fake", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 1 } } } } }],
    agents: [{ id: "a", channel: "c", model: "m", effort: "medium" }],
    roles: [{ id: "lead", enabled: true, prompt: "You are lead.", skills: ["sk1"], tools: [], writePaths: [], turnBudget: 5 }],
    settings: settingsFile.parse({}),
    skills: [{ id: "sk1", description: "a skill", defaultRoles: [], version: 1, body: "SKILL BODY", source: "shipped", edited: false, updateAvailable: false }],
    errors: [],
    ...over,
  };
}

export interface Harness {
  svc: SessionService;
  events: RunEvent[];
  host: HostPort;
  files: Record<string, string>;
  interaction: Interaction;
  config: EffectiveConfig;
  channel: ManagedChannel;
  waitFor(kind: RunEvent["kind"], timeoutMs?: number): Promise<RunEvent>;
  setProcHandler: ReturnType<typeof fakeHost>["setProcHandler"];
  procs: ReturnType<typeof fakeHost>["procs"];
}

export function harness(over: { config?: EffectiveConfig; channel?: ManagedChannel; engine?: Engine; files?: Record<string, string> } = {}): Harness {
  const { host, files, setProcHandler, procs } = fakeHost(over.files ?? {});
  const events: RunEvent[] = [];
  const waiters: { kind: string; res: (e: RunEvent) => void }[] = [];
  const bus = {
    emit(ev: RunEvent) {
      events.push(ev);
      const i = waiters.findIndex((w) => w.kind === ev.kind);
      if (i >= 0) waiters.splice(i, 1)[0].res(ev);
    },
  };
  const ids = counterIds();
  const interaction = new Interaction({ ids, clock: systemClock, bus });
  const config = over.config ?? makeConfig();
  const channel = over.channel ?? fakeChannel([[{ kind: "text", text: "hi" }, { kind: "done" }]]);
  const deps: SessionDeps = {
    host,
    bus,
    ids,
    clock: systemClock,
    interaction,
    permissions: new Permissions(interaction),
    channelFor: () => channel,
    config: () => config,
    engineFor: over.engine ? () => over.engine! : undefined,
  };
  const svc = new SessionService(deps);
  const waitFor = (kind: RunEvent["kind"], timeoutMs = 2000): Promise<RunEvent> => {
    const from = events.length;
    return new Promise((res, rej) => {
      const check = () => events.slice(from).find((e) => e.kind === kind);
      const seen = check();
      if (seen) return res(seen);
      waiters.push({ kind, res: (e) => res(e) });
      setTimeout(() => rej(new Error(`timeout waiting for ${kind}; got ${events.map((e) => e.kind).join(",")}`)), timeoutMs);
    });
  };
  return { svc, events, host, files, interaction, config, channel, waitFor, setProcHandler, procs };
}

