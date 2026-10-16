// German / English for the viewer: every UI text lives here. The characters' speech lines are
// in sim.js and sim-extra.js (LINES and LINES_EN); a drawn thing's own lines may be a plain array
// (German) or { de: [...], en: [...] } — pickLines() takes either.
// The choice is kept in localStorage; without one the page is German.

const KEY = 'kritzelLang';
let cur = (() => {
  try { const v = localStorage.getItem(KEY); if (v === 'de' || v === 'en') return v; } catch {}
  return 'de';                                   // German first; the button switches
})();
const listeners = new Set();

export const lang = () => cur;
export function setLang(l) {
  if (l !== 'de' && l !== 'en') return;
  cur = l;
  try { localStorage.setItem(KEY, l); } catch {}
  document.documentElement.lang = l;
  for (const f of listeners) f(l);
}
export const onLang = f => { listeners.add(f); f(cur); };
document.documentElement.lang = cur;

// speech lines of a drawn thing or spot: an array is German; { de, en } is picked by language
export const pickLines = v => Array.isArray(v) ? v : (v && (v[cur] || v.de)) || null;

const S = {
  de: {
    hint: 'Tippe Figuren und Dinge an · lange drücken: mit der Kamera folgen · Esc beendet',
    veil: 'Neue Welt wird gemalt',
    soundOn: '🔇 Ton an', soundOff: '🔊 Ton aus',
    cameraBtn: '📷 Kamera', cameraSelect: 'Kamera', cameraRefresh: 'Neu suchen', cameraImage: 'Kamerabild',
    langBtn: 'EN', langTitle: 'Switch to English',
    camNone: 'Keine Kamera', camHere: 'Dieser Computer', camNetwork: 'Im Netzwerk', camSearching: 'Suche Kameras …',
    camHttps: 'Lokale Kameras nur über https oder localhost.', camNoLocal: 'Keine Kamera an diesem Computer gefunden.',
    camNoRemote: 'Keine Netzwerk-Kamera gefunden (scripts/camera_server.py starten).', camCantOpen: 'Kamera lässt sich nicht öffnen: ',
    activity: { wander: 'läuft herum', swim: 'schwimmt', rest: 'ruht sich aus', idle: 'schaut sich um', eat: 'isst',
      follow: 'folgt jemandem', flee: 'rennt weg', approach: 'geht auf jemanden zu', chase: 'jagt jemanden', warm: 'wärmt sich am Licht' },
    standing: 'steht da',
    mood: { scared: 'ängstlich', tired: 'müde', hungry: 'hungrig', happy: 'fröhlich' },
    likes: n => `♥ ${n}`, afraid: n => `Angst vor ${n}`, dislikes: n => `mag ${n} nicht`,
    building: s => `🎨 wird gebaut… ${s} s`, made: n => `✓ neu: ${n || 'Ding'}`, changed: n => `↻ geändert: ${n || 'Ding'}`,
    removed: 'entfernt', unclear: '✗ nicht erkannt', seen: '✏️ neue Zeichnung erkannt', captureOff: '⚠ Kamera-Beobachter aus',
    cameraOff: 'Kamera aus', noCamera: 'keine Kamera gewählt', moving: '✋ Bewegung…', connected: 'Kamera verbunden',
    watching: '👀 beobachtet das Papier', generatorOff: '⚠ Generator aus', noticed: '✏️ Oh, da tut sich was …', thinking: s => `🤔 Hmm, was ist das wohl? ${s} s`,
    seenList: l => `👀 Was haben wir denn da? ${l} …`, buildingNow: x => `🎨 Ich baue ${x} …`, coming: x => `🎨 Gleich kommt ${x} …`,
    hello: n => `Hallo ${n}!`, notKnown: '🤷 Hm, das kenne ich noch nicht.', nothingNew: '🙂 Ach, doch nichts Neues.', failedSoft: '😕 Das hat nicht geklappt.', modeAdd: '➕ Hinzufügen', modeSwitch: '🔄 Wechseln', modeTitle: 'Was passiert, wenn ein neues Blatt kommt',
    modeNoteAdd: 'Modus: Neues kommt dazu', modeNoteSwitch: 'Modus: Die Welt ist das Blatt', newWorld: '🌍 Neue Welt', sure: 'Sicher? Nochmal tippen',
  },
  en: {
    hint: 'Tap figures and things · press and hold: follow with the camera · Esc stops',
    veil: 'A new world is being drawn',
    soundOn: '🔇 Sound on', soundOff: '🔊 Sound off',
    cameraBtn: '📷 Camera', cameraSelect: 'Camera', cameraRefresh: 'Search again', cameraImage: 'Camera picture',
    langBtn: 'DE', langTitle: 'Auf Deutsch umschalten',
    camNone: 'No camera', camHere: 'This computer', camNetwork: 'On the network', camSearching: 'Looking for cameras …',
    camHttps: 'Local cameras only work over https or localhost.', camNoLocal: 'No camera found on this computer.',
    camNoRemote: 'No network camera found (start scripts/camera_server.py).', camCantOpen: 'Can\'t open the camera: ',
    activity: { wander: 'is walking around', swim: 'is swimming', rest: 'is resting', idle: 'is looking around', eat: 'is eating',
      follow: 'is following someone', flee: 'is running away', approach: 'is going over to someone', chase: 'is chasing someone', warm: 'is warming up by the light' },
    standing: 'is standing there',
    mood: { scared: 'scared', tired: 'tired', hungry: 'hungry', happy: 'happy' },
    likes: n => `♥ ${n}`, afraid: n => `afraid of ${n}`, dislikes: n => `doesn't like ${n}`,
    building: s => `🎨 building… ${s} s`, made: n => `✓ new: ${n || 'thing'}`, changed: n => `↻ changed: ${n || 'thing'}`,
    removed: 'removed', unclear: '✗ not recognised', seen: '✏️ new drawing seen', captureOff: '⚠ camera watcher off',
    cameraOff: 'camera off', noCamera: 'no camera chosen', moving: '✋ movement…', connected: 'camera connected',
    watching: '👀 watching the paper', generatorOff: '⚠ generator off', noticed: '✏️ Oh, something is happening …', thinking: s => `🤔 Hmm, what could that be? ${s} s`,
    seenList: l => `👀 What have we got here? ${l} …`, buildingNow: x => `🎨 I'm making ${x} …`, coming: x => `🎨 Here comes ${x} …`,
    hello: n => `Hello ${n}!`, notKnown: '🤷 Hm, I don\'t know that one yet.', nothingNew: '🙂 Oh, nothing new after all.', failedSoft: '😕 That didn\'t work.', modeAdd: '➕ Add', modeSwitch: '🔄 Switch', modeTitle: 'What happens when a new sheet comes',
    modeNoteAdd: 'Mode: new drawings are added', modeNoteSwitch: 'Mode: the world is the sheet', newWorld: '🌍 New world', sure: 'Sure? Tap again',
  },
};

// t('hint'), t('building', 7), t('activity').rest — falls back to German, then to the key
export function t(key, ...args) {
  const v = S[cur][key] ?? S.de[key];
  return typeof v === 'function' ? v(...args) : v ?? key;
}
