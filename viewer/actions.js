// Action mode's local half: change this world from a typed command returned by POST /api/action.
// The command vocabulary is closed (API.md): a goal, the weather, day/night, or unknown.
const WEATHER = {
  rain: [{ kind: 'rain' }],
  snow: [{ kind: 'snow' }],
  storm: [{ kind: 'rain' }, { kind: 'lightning' }],
  rainbow: [{ kind: 'rainbow' }],
  clear: [],
};

export function createActions({ brain, mood }) {
  const note = text => { try { window.__status?.note?.(text); } catch {} };

  function apply(cmd) {
    if (!cmd || typeof cmd !== 'object') return false;
    if (cmd.kind === 'goal') {
      const ok = brain()?.action?.(cmd);
      if (!ok) note('Diese Figur ist gerade nicht da.');
      return !!ok;
    }
    if (cmd.kind === 'weather' && WEATHER[cmd.value]) {
      mood?.setWeather?.('action', WEATHER[cmd.value]);
      return true;
    }
    if (cmd.kind === 'time' && (cmd.value === 'day' || cmd.value === 'night')) {
      mood?.setTime?.(cmd.value);
      return true;
    }
    note(cmd.why || 'Das kann ich noch nicht.');
    return false;
  }

  // one round trip for callers that have not posted the instruction themselves
  async function run(text, things = null) {
    try {
      const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kritzel': '1' },
        body: JSON.stringify({ text, ...(things ? { things } : {}) }) });
      const j = await r.json();
      if (!j.ok) { note(j.error || 'Das habe ich nicht verstanden.'); return null; }
      apply(j.command);
      return j.command;
    } catch {
      note('Gerade nicht erreichbar.');
      return null;
    }
  }

  return { apply, run };
}
