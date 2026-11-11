import { useState } from "preact/hooks";
import type { Store } from "./state.js";
import type { SkillSummary } from "./bridge.js";

function SkillCard({ skill, store }: { skill: SkillSummary; store: Store }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(skill.body);
  return (
    <div class="card">
      <div class="card-title">
        <b>{skill.id}</b>
        <span class={`badge src-${skill.source}`}>{skill.source}</span>
        {skill.edited ? <span class="badge">edited</span> : null}
        {skill.updateAvailable ? <span class="badge warn" title="Shipped version changed since your edit">update available</span> : null}
        <span class="summary">{skill.description}</span>
        <span class="spacer" />
        {skill.source !== "shipped" ? <button class="small deny" onClick={() => store.resetSkill(skill.id)}>Reset</button> : null}
        <button class="small" onClick={() => store.openSkill(skill.id)}>Open file</button>
        <button class="small" onClick={() => { setBody(skill.body); setEditing(!editing); }}>{editing ? "Cancel" : "Edit"}</button>
      </div>
      {editing ? (
        <div class="form">
          <textarea rows={8} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          <button class="send" onClick={() => { store.saveSkill(skill.id, body, skill.description); setEditing(false); }}>Save</button>
        </div>
      ) : null}
    </div>
  );
}

type SkillDraft = { id: string; description: string; body: string };
const EMPTY_SKILL_DRAFT: SkillDraft = { id: "", description: "", body: "" };

function NewSkillForm({ draft, clean, clash, onPatch, onCreate }: {
  draft: SkillDraft;
  clean: string;
  clash: boolean;
  onPatch(p: Partial<SkillDraft>): void;
  onCreate(): void;
}) {
  return (
    <div class="form">
      <label class="field">
        <span>id</span>
        <input value={draft.id} placeholder="my-skill" onInput={(e) => onPatch({ id: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="field">
        <span>description</span>
        <input value={draft.description} onInput={(e) => onPatch({ description: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="field">
        <span>body</span>
        <textarea rows={8} value={draft.body} onInput={(e) => onPatch({ body: (e.target as HTMLTextAreaElement).value })} />
      </label>
      {clash ? <p class="fail">skill '{clean}' already exists</p> : null}
      <button class="send" disabled={!clean || clash} onClick={onCreate}>
        Create
      </button>
    </div>
  );
}

function NewSkill({ store, existing }: { store: Store; existing: string[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_SKILL_DRAFT);
  const clean = draft.id.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  const clash = existing.includes(clean);
  const create = () => {
    store.saveSkill(clean, draft.body, draft.description);
    setOpen(false);
    setDraft(EMPTY_SKILL_DRAFT);
  };
  return (
    <div class="card">
      <div class="card-title">
        <b>New skill</b>
        <span class="spacer" />
        <button class="small" onClick={() => setOpen(!open)}>{open ? "Cancel" : "+ New"}</button>
      </div>
      {open ? (
        <NewSkillForm
          draft={draft}
          clean={clean}
          clash={clash}
          onPatch={(p) => setDraft((d) => ({ ...d, ...p }))}
          onCreate={create}
        />
      ) : null}
    </div>
  );
}

export function SkillsSection({ store, skills }: { store: Store; skills: SkillSummary[] }) {
  return (
    <section>
      <h3>Skills</h3>
      <NewSkill store={store} existing={skills.map((s) => s.id)} />
      {skills.map((s) => <SkillCard key={s.id} skill={s} store={store} />)}
      {!skills.length ? <p class="hint">No skills found.</p> : null}
    </section>
  );
}
