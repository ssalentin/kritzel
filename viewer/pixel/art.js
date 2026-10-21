// Shared by the build script and the browser: the readable fallback chosen from a thing's meta.
const KEYWORDS = [
  ['witch', /hexe|witch|zauber/i],
  ['eiffel', /eiffel/i],
  ['tower', /wolkenkratzer|skyscraper|turm|tower|haus|house|schloss|castle|gebäude|building|hütte|hut|brücke|bridge/i],
  ['dragon', /drache|dragon|vogel|bird|eule|owl|fledermaus|bat|biene|bee|schmetterling|butterfly/i],
  ['fish', /fisch|fish|wal|whale|hai|shark|ente|duck|pinguin|penguin|krabbe|crab|wassermann/i],
  ['snake', /spinne|spider|schlange|snake|wurm|worm|raupe|caterpillar|schnecke|snail|eidechse/i],
  ['flower', /blume|flower|tulpe|tulip|rose/i],
  ['tree', /baum|tree|blume|flower|pflanze|plant|gras|wiese|pilz|mushroom|blatt/i],
  ['lamp', /lampe|lamp|laterne|lantern|kerze|candle|feuer|fire|sonne|sun|mond|moon|stern|star|licht|light/i],
  ['chest', /stuhl|chair|tisch|table|bett|bed|schrank|cupboard|truhe|chest|sofa|regal|shelf/i],
  ['cloud', /wolke|cloud|regen|rain|schnee|snow|gewitter|storm|regenbogen|rainbow|blitz|lightning/i],
  ['cookie', /apfel|apple|keks|cookie|biscuit|brot|bread|kuchen|cake|eis|ice|banane|banana|karotte|carrot|traube|grape|milch|milk|pizza|nudel|pasta|beere|berry/i],
  ['car', /auto|car|bus|zug|train|boot|boat|schiff|ship|fahrrad|bike|rakete|rocket|flugzeug|plane/i],
  ['person', /person|kind|mensch|mann|frau|vater|mutter|junge|mädchen|maedchen|clown|fee|ritter|prinzessin/i],
  ['mouse', /maus|mouse|hund|katze|cat|bär|baer|bear|pferd|horse|esel|fuchs|wolf|kuh|schaf|tier|animal|giraffe/i],
  ['scribble', /kritzel|scribble|kringel|tangle|loop/i],
];

export function archetype(thing) {
  const text = `${thing.kind || ''} ${thing.name || ''} ${thing.drawing || ''}`;
  for (const [name, re] of KEYWORDS) if (re.test(text)) return name;
  return 'blob';
}
