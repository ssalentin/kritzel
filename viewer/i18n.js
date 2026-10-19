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
    whatsNew: 'Was ist neu',
    hint: 'Tippe Figuren und Dinge an · lange drücken: mit der Kamera folgen · Esc beendet',
    veil: 'Leg los mit dem Malen!',
    soundOn: '🔇 Ton an', soundOff: '🔊 Ton aus',
    cameraBtn: '📷 Kamera', cameraSelect: 'Kamera', cameraRefresh: 'Neu suchen', cameraImage: 'Kamerabild',
    langBtn: 'EN', langTitle: 'Switch to English',
    camNone: 'Keine Kamera', buildWait: '⏳ wartet', buildNow: '✏️ wird gebaut', buildAlmost: '🖍️ fast fertig', buildDone: '✓ fertig', buildFail: '🤷 nicht geklappt', camHold: 'Bitte liegen lassen …', camDone: '✅ Du kannst das Blatt jetzt wegnehmen!', camHere: 'Dieser Computer', camNetwork: 'Im Netzwerk', camSearching: 'Suche Kameras …',
    textThingPlaceholder: 'Etwas hinzufügen … (z. B. eine Laterne)', textThingAdd: 'Etwas hinzufügen', textThingBusy: 'wird gebaut …',
    textThingRejected: 'Das kann ich so nicht bauen.', textThingNoServer: 'Der Server kennt das Textfeld noch nicht — bitte neu starten.',
    textModeNew: 'Neu', textModeFix: 'Korrektur', textModeGroup: 'Neu oder Korrektur', textFixBusy: 'wird geändert …',
    textFixPlaceholder: 'Was stimmt nicht? (z. B. Die Hexe sitzt nicht richtig auf dem Besen)', textTarget: 'Welches Ding?', textNoThings: 'Noch kein Ding da',
    textModeAction: 'Aktion', actionBusy: 'macht …', actionPlaceholder: 'Was soll passieren? (z. B. Es soll schneien / Die Hexe soll zum Mond fliegen)',
    actionGo: (a, b) => `${a} geht zu ${b}`, actionJoin: a => `${a} macht mit`,
    actionWeather: v => ({ rain: 'Es regnet', snow: 'Es schneit', storm: 'Es stürmt', rainbow: 'Ein Regenbogen', clear: 'Es klart auf' })[v] || 'Das Wetter ändert sich',
    actionDay: 'Es wird Tag', actionNight: 'Es wird Nacht', actionDone: 'Gemacht.', actionNo: 'Das kann ich noch nicht.',
    camHttps: 'Lokale Kameras nur über https oder localhost.', camNoLocal: 'Keine Kamera an diesem Computer gefunden.',
    camNoRemote: 'Keine Netzwerk-Kamera gefunden (scripts/camera_server.py starten).', camCantOpen: 'Kamera lässt sich nicht öffnen: ',
    activity: { wander: 'läuft herum', swim: 'schwimmt', rest: 'ruht sich aus', idle: 'schaut sich um', eat: 'isst',
      follow: 'folgt jemandem', flee: 'rennt weg', approach: 'geht auf jemanden zu', chase: 'jagt jemanden', warm: 'wärmt sich am Licht' },
    standing: 'steht da',
    mood: { scared: 'ängstlich', tired: 'müde', hungry: 'hungrig', happy: 'fröhlich' },
    likes: n => `♥ ${n}`, afraid: n => `Angst vor ${n}`, dislikes: n => `mag ${n} nicht`,
    building: s => `🎨 wird gebaut… ${s} s`, made: n => `✓ neu: ${n || 'Ding'}`, changed: n => `↻ geändert: ${n || 'Ding'}`,
    removed: 'entfernt', unclear: '✗ nicht erkannt', seen: '✏️ neue Zeichnung erkannt', captureOff: '⚠ Kamera-Beobachter aus',
    cameraOff: 'Kamera aus', noCamera: 'keine Kamera gewählt', noPaper: '📄 Leg ein Blatt Papier hin', handOnPaper: '✋ Leg die Hand weg, dann geht es weiter', moving: '✋ Bewegung…', connected: 'Kamera verbunden',
    watching: '👀 beobachtet das Papier', generatorOff: '⚠ Generator aus', noticed: '✏️ Oh, da tut sich was …', thinking: s => `🤔 Hmm, was ist das wohl? ${s} s`,
    kind_new: 'Neue Zeichnung', kind_addition: 'Etwas kommt dazu', kind_coloured_in: 'Wird ausgemalt', kind_crossed_out: 'Etwas durchgestrichen', kind_relabel: 'Neue Beschriftung', seenKind: k => `✏️ ${k} …`,
    seenList: l => `👀 Was haben wir denn da? ${l} …`, buildingNow: x => `🎨 Ich baue ${x} …`, coming: x => `🎨 Gleich kommt ${x} …`,
    hello: n => `Hallo ${n}!`, notKnown: '🤷 Hm, das kenne ich noch nicht.', nothingNew: '🙂 Ach, doch nichts Neues.', failedSoft: '😕 Das hat nicht geklappt.', modeAdd: '➕ Hinzufügen', modeSwitch: '🔄 Wechseln', modeTitle: 'Was passiert, wenn ein neues Blatt kommt',
    modeNoteAdd: 'Modus: Neues kommt dazu', modeNoteSwitch: 'Modus: Die Welt ist das Blatt', newWorld: '🌍 Neue Welt', sure: 'Sicher? Nochmal tippen',
    newTurning: 'Blättert um …', newFailed: 'Das Umblättern hat nicht geklappt. Nochmal?',
  },
  en: {
    whatsNew: "What's new",
    hint: 'Tap figures and things · press and hold: follow with the camera · Esc stops',
    veil: 'Start drawing something!',
    soundOn: '🔇 Sound on', soundOff: '🔊 Sound off',
    cameraBtn: '📷 Camera', cameraSelect: 'Camera', cameraRefresh: 'Search again', cameraImage: 'Camera picture',
    langBtn: 'DE', langTitle: 'Auf Deutsch umschalten',
    camNone: 'No camera', buildWait: '⏳ waiting', buildNow: '✏️ being built', buildAlmost: '🖍️ almost', buildDone: '✓ done', buildFail: '🤷 not this time', camHold: 'Keep it still …', camDone: '✅ You can take the paper away now!', camHere: 'This computer', camNetwork: 'On the network', camSearching: 'Looking for cameras …',
    textThingPlaceholder: 'Add something … (e.g. a lantern)', textThingAdd: 'Add something', textThingBusy: 'building …',
    textThingRejected: "I can't build that like that.", textThingNoServer: "This server doesn't know the text field yet — please restart it.",
    textModeNew: 'New', textModeFix: 'Fix', textModeGroup: 'New or fix', textFixBusy: 'changing …',
    textFixPlaceholder: "What's wrong? (e.g. The witch doesn't sit right on the broom)", textTarget: 'Which thing?', textNoThings: 'No thing yet',
    textModeAction: 'Action', actionBusy: 'doing …', actionPlaceholder: 'What should happen? (e.g. Let it snow / The witch should fly to the moon)',
    actionGo: (a, b) => `${a} goes to ${b}`, actionJoin: a => `${a} joins in`,
    actionWeather: v => ({ rain: 'It rains', snow: 'It snows', storm: 'A storm comes', rainbow: 'A rainbow', clear: 'The sky clears' })[v] || 'The weather changes',
    actionDay: 'It becomes day', actionNight: 'It becomes night', actionDone: 'Done.', actionNo: "I can't do that yet.",
    camHttps: 'Local cameras only work over https or localhost.', camNoLocal: 'No camera found on this computer.',
    camNoRemote: 'No network camera found (start scripts/camera_server.py).', camCantOpen: 'Can\'t open the camera: ',
    activity: { wander: 'is walking around', swim: 'is swimming', rest: 'is resting', idle: 'is looking around', eat: 'is eating',
      follow: 'is following someone', flee: 'is running away', approach: 'is going over to someone', chase: 'is chasing someone', warm: 'is warming up by the light' },
    standing: 'is standing there',
    mood: { scared: 'scared', tired: 'tired', hungry: 'hungry', happy: 'happy' },
    likes: n => `♥ ${n}`, afraid: n => `afraid of ${n}`, dislikes: n => `doesn't like ${n}`,
    building: s => `🎨 building… ${s} s`, made: n => `✓ new: ${n || 'thing'}`, changed: n => `↻ changed: ${n || 'thing'}`,
    removed: 'removed', unclear: '✗ not recognised', seen: '✏️ new drawing seen', captureOff: '⚠ camera watcher off',
    cameraOff: 'camera off', noCamera: 'no camera chosen', noPaper: '📄 Put a sheet of paper down', handOnPaper: '✋ Move your hand away and we can carry on', moving: '✋ movement…', connected: 'camera connected',
    watching: '👀 watching the paper', generatorOff: '⚠ generator off', noticed: '✏️ Oh, something is happening …', thinking: s => `🤔 Hmm, what could that be? ${s} s`,
    kind_new: 'New drawing', kind_addition: 'Something added', kind_coloured_in: 'Colouring in', kind_crossed_out: 'Crossed out', kind_relabel: 'New label', seenKind: k => `✏️ ${k} …`,
    seenList: l => `👀 What have we got here? ${l} …`, buildingNow: x => `🎨 I'm making ${x} …`, coming: x => `🎨 Here comes ${x} …`,
    hello: n => `Hello ${n}!`, notKnown: '🤷 Hm, I don\'t know that one yet.', nothingNew: '🙂 Oh, nothing new after all.', failedSoft: '😕 That didn\'t work.', modeAdd: '➕ Add', modeSwitch: '🔄 Switch', modeTitle: 'What happens when a new sheet comes',
    modeNoteAdd: 'Mode: new drawings are added', modeNoteSwitch: 'Mode: the world is the sheet', newWorld: '🌍 New world', sure: 'Sure? Tap again',
    newTurning: 'Turning the page …', newFailed: 'Turning the page did not work. Try again?',
  },
};

// t('hint'), t('building', 7), t('activity').rest — falls back to German, then to the key
export function t(key, ...args) {
  const v = S[cur][key] ?? S.de[key];
  return typeof v === 'function' ? v(...args) : v ?? key;
}
