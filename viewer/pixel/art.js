// Shared by the build script and the browser: the readable fallback chosen from a thing's meta.
function wordsOf(text) {
  const clean = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase();
  return new Set(clean.match(/[a-z0-9]+/g) || []);
}

export function archetype(thing) {
  const text = `${thing.kind || ''} ${thing.name || ''} ${thing.drawing || ''}`;
  const words = wordsOf(text);
  const has = (...items) => items.some(word => words.has(word));
  const starts = (...items) => [...words].some(word => items.some(x => word.startsWith(x)));

  if (has('hexe', 'hexen', 'witch', 'witches', 'zauber', 'zauberer')) return 'witch';
  if (starts('eiffel')) return 'eiffel';
  if (starts('wolkenkratz', 'skyscraper')
    || has('turm', 'tower', 'haus', 'house', 'schloss', 'castle', 'gebaude', 'building', 'hutte', 'hut', 'brucke', 'bridge')) return 'tower';
  if (starts('drach', 'dragon')
    || has('vogel', 'voegel', 'bird', 'birds', 'eule', 'eulen', 'owl', 'owls', 'fledermaus', 'bat', 'bats',
      'biene', 'bienen', 'bee', 'bees', 'schmetterling', 'butterfly')) return 'dragon';
  if (starts('fisch', 'pinguin')
    || has('fish', 'wal', 'wale', 'whale', 'whales', 'hai', 'haie', 'shark', 'ente', 'enten', 'duck', 'ducks',
      'penguin', 'krabbe', 'crab', 'wassermann')) return 'fish';
  if (has('spinne', 'spinnen', 'spider', 'spiders', 'schlange', 'snake', 'wurm', 'worm', 'raupe',
    'caterpillar', 'schnecke', 'snail', 'eidechse')) return 'snake';
  if (has('blume', 'blumen', 'flower', 'flowers', 'tulpe', 'tulpen', 'tulip', 'rose', 'roses')) return 'flower';
  if (has('baum', 'baume', 'tree', 'trees', 'pflanze', 'plant', 'gras', 'wiese', 'pilz', 'mushroom', 'blatt', 'leaves')) return 'tree';
  if (has('lampe', 'lamp', 'laterne', 'lantern', 'kerze', 'candle', 'feuer', 'fire', 'sonne', 'sun', 'mond', 'moon',
    'stern', 'star', 'licht', 'light')) return 'lamp';
  if (has('stuhl', 'chair', 'tisch', 'table', 'bett', 'bed', 'schrank', 'cupboard', 'truhe', 'chest', 'sofa', 'regal', 'shelf')) return 'chest';
  if (has('wolke', 'wolken', 'cloud', 'clouds', 'regen', 'rain', 'schnee', 'snow', 'gewitter', 'storm',
    'regenbogen', 'rainbow', 'blitz', 'lightning')) return 'cloud';
  if (has('apfel', 'apple', 'keks', 'cookie', 'biscuit', 'brot', 'bread', 'kuchen', 'cake', 'eis', 'ice',
    'banane', 'banana', 'karotte', 'carrot', 'traube', 'grape', 'milch', 'milk', 'pizza', 'nudel', 'pasta', 'beere', 'berry')) return 'cookie';
  if (starts('auto') || has('car', 'cars', 'bus', 'buses', 'zug', 'train', 'boot', 'boat', 'schiff', 'ship',
    'fahrrad', 'bike', 'rakete', 'rocket', 'flugzeug', 'plane')) return 'car';
  if (has('person', 'kind', 'child', 'girl', 'boy', 'mensch', 'mann', 'frau', 'vater', 'mutter', 'junge', 'madchen',
    'maedchen', 'laufer', 'laeufer', 'runner', 'clown', 'fee', 'ritter', 'prinzessin')) return 'person';
  if (has('maus', 'mouse', 'hund', 'dog', 'katze', 'cat', 'bar', 'baer', 'bear', 'pferd', 'horse', 'esel',
    'fuchs', 'wolf', 'kuh', 'schaf', 'tier', 'animal', 'giraffe')) return 'mouse';
  if (starts('kritzel') || has('scribble', 'kringel', 'tangle', 'loop')) return 'scribble';
  return 'blob';
}
