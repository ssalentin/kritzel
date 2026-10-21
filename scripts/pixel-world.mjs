// Build the pixel app's static scene from viewer/things/*.js with claude-pxl.
// The generated .px.js is deterministic; the PNG is the only thing the pixel app loads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archetype } from '../viewer/pixel/art.js';
import { label, layoutThings, SCENE } from '../viewer/pixel/layout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.KRITZEL_ROOT ? path.resolve(process.env.KRITZEL_ROOT) : path.resolve(HERE, '..');
const THINGS = path.join(ROOT, 'viewer', 'things');
const ART = path.join(ROOT, 'art', 'pixel-world.px.js');
const OUT = path.join(ROOT, 'viewer', 'pixel');
const LIBRARY = path.join(ROOT, 'docs', 'pixel-library.png');
const PXL_COMMIT = '21fee41f7ecce00bc868d7567f24ffd0f3acc8fa';
const PXL_DIR = process.env.PXL_DIR || path.join(tmpdir(), `kritzel-claude-pxl-${PXL_COMMIT}`);

const PAL = `pal({
  k: "#1b1630", w: "#fff6e0", c: "#f4e8c8", C: "#d8c49a",
  g: "#38b764", G: "#257179", l: "#a7f070", r: "#b13e53", R: "#5d275d",
  b: "#41a6f6", B: "#29366f", y: "#ffcd75", Y: "#ef7d57", o: "#ef7d57",
  n: "#94b0c2", N: "#566c86", m: "#333c57", p: "#b55088", P: "#5d275d",
  s: "#ffccaa", S: "#c98f6b", e: "#8a5a3c", E: "#5c3a2c", a: "#2ce8f5",
})
ramps("kGg", "kRr", "kNn", "kPp", "kEe", "kSs")`;

// Procedural fill-ins for kinds not yet in the exact-pixel library below. Pixel-generated,
// per-thing PNGs replace them; these keep unknown drawings visible in the first fallback scene.
const SPRITES = {
  dragon: { w: 48, h: 40, code: `
  ellipse(24, 26, 12, 9, "G")
  ellipse(22, 24, 10, 6, "g")
  poly([24,17, 38,2, 44,4, 34,20], "r")
  poly([18,18, 6,4, 1,7, 12,22], "r")
  poly([24,18, 36,4, 39,6, 30,20], "R")
  ellipse(36, 16, 6, 6, "G")
  ellipse(39, 17, 4, 3, "g")
  rect(40, 14, 4, 2, "G")
  px(41, 15, "w"); px(42, 15, "k")
  poly([33,11, 35,6, 37,10], "y")
  poly([37,10, 39,5, 41,10], "y")
  rect(17, 34, 3, 6, "G"); rect(28, 34, 3, 6, "G")
  rect(15, 39, 6, 2, "g"); rect(27, 39, 6, 2, "g")
  poly([13,28, 2,24, 0,27, 10,32], "G")
  shade([8, 20, 32, 16], 1)` },
  witch: { w: 24, h: 40, code: `
  poly([11,0, 16,13, 6,13], "P")
  rect(4, 12, 16, 3, "p")
  ellipse(12, 20, 5, 5, "s")
  px(10, 19, "k"); px(14, 19, "k")
  rect(10, 23, 4, 1, "S")
  poly([8,25, 16,25, 20,38, 4,38], "p")
  rect(5, 30, 2, 8, "p"); rect(17, 30, 2, 8, "p")
  ellipse(5, 30, 2, 2, "s"); ellipse(19, 30, 2, 2, "s")
  rect(20, 20, 2, 18, "e"); rect(22, 22, 2, 2, "y")
  shade([4, 25, 16, 13], 1)` },
  person: { w: 18, h: 34, code: `
  ellipse(9, 7, 6, 6, "e")
  ellipse(9, 9, 5, 5, "s")
  px(7, 9, "k"); px(12, 9, "k")
  rect(7, 12, 4, 1, "S")
  rect(5, 15, 8, 9, "b")
  rect(2, 16, 3, 8, "s"); rect(13, 16, 3, 8, "s")
  rect(5, 24, 3, 7, "B"); rect(10, 24, 3, 7, "B")
  rect(4, 31, 4, 3, "k"); rect(10, 31, 4, 3, "k")
  shade([4, 15, 10, 9], 1)` },
  tower: { w: 24, h: 48, code: `
  rect(3, 6, 18, 42, "N")
  rect(5, 8, 14, 38, "n")
  rect(8, 0, 8, 6, "N"); rect(11, 0, 2, 6, "n")
  line(11, 0, 11, 8, "N")
  rect(7, 12, 3, 3, "a"); rect(14, 12, 3, 3, "a")
  rect(7, 18, 3, 3, "a"); rect(14, 18, 3, 3, "a")
  rect(7, 24, 3, 3, "a"); rect(14, 24, 3, 3, "a")
  rect(7, 30, 3, 3, "a"); rect(14, 30, 3, 3, "a")
  rect(7, 36, 3, 3, "a"); rect(14, 36, 3, 3, "a")
  rect(3, 44, 18, 4, "m")
  shade([3, 6, 18, 42], 1)` },
  eiffel: { w: 28, h: 48, code: `
  line(4, 47, 12, 10, "Y"); line(23, 47, 15, 10, "Y")
  line(7, 38, 13, 12, "Y"); line(20, 38, 14, 12, "Y")
  line(2, 44, 25, 30, "Y"); line(2, 30, 25, 44, "Y")
  line(6, 34, 21, 22, "Y"); line(6, 22, 21, 34, "Y")
  line(9, 24, 18, 14, "Y"); line(9, 14, 18, 24, "Y")
  rect(12, 8, 4, 4, "y"); rect(13, 2, 2, 7, "y")
  shade([2, 10, 24, 37], 1)` },
  tree: { w: 26, h: 34, code: `
  poly([13,1, 25,14, 1,14], "g")
  poly([13,8, 25,21, 1,21], "g")
  poly([13,15, 26,29, 0,29], "g")
  rect(11, 28, 4, 6, "e")
  ellipse(7, 13, 1, 1, "r"); ellipse(16, 18, 1, 1, "y"); ellipse(10, 24, 1, 1, "r")
  shade([0, 12, 26, 18], 1)` },
  cloud: { w: 30, h: 12, code: `
  ellipse(8, 7, 6, 4, "N"); ellipse(15, 5, 7, 5, "n"); ellipse(22, 7, 6, 4, "N")
  shade([0, 4, 30, 8], 1)` },
  flower: { w: 22, h: 34, code: `
  line(11, 32, 11, 14, "G", 2)
  line(10, 24, 4, 20, "g", 2); line(12, 27, 18, 23, "g", 2)
  ellipse(11, 9, 4, 5, "y"); ellipse(6, 10, 4, 4, "Y")
  ellipse(16, 10, 4, 4, "y"); ellipse(8, 5, 4, 4, "y")
  ellipse(14, 5, 4, 4, "y"); ellipse(11, 9, 3, 3, "o")
  shade([4, 3, 15, 11], 1)` },
  scribble: { w: 30, h: 32, code: `
  ellipse(15, 20, 11, 9, "n")
  ellipse(11, 19, 7, 6, "N")
  ring(21, 6, 5, "n")
  line(6, 12, 24, 27, "N", 2); line(23, 13, 7, 26, "N", 2)
  ellipse(11, 17, 2, 2, "w"); ellipse(19, 17, 2, 2, "w")
  px(12, 18, "k"); px(18, 18, "k")
  poly([12,23, 15,25, 18,23], "k")
  shade([4, 12, 22, 14], 1)` },
  mouse: { w: 28, h: 20, code: `
  ellipse(14, 13, 10, 5, "n")
  ellipse(19, 9, 6, 5, "n")
  ellipse(16, 5, 3, 4, "N"); ellipse(23, 6, 3, 4, "N")
  px(18, 10, "k"); ellipse(25, 12, 2, 1, "o")
  line(5, 15, 1, 10, "n", 2)
  rect(8, 17, 3, 2, "N"); rect(17, 17, 3, 2, "N")
  shade([5, 7, 20, 9], 1)` },
  fish: { w: 30, h: 20, code: `
  ellipse(16, 11, 9, 6, "b")
  poly([8,11, 1,5, 3,11, 1,17], "B")
  poly([17,15, 21,18, 22,14], "B")
  px(22, 9, "k"); ellipse(24, 11, 1, 1, "w")
  poly([14,6, 11,2, 17,5], "B")
  shade([7, 5, 19, 12], 1)` },
  snake: { w: 30, h: 24, code: `
  line(4, 20, 10, 14, "G", 5)
  line(10, 14, 17, 18, "g", 5)
  line(17, 18, 23, 11, "G", 5)
  ellipse(24, 9, 5, 4, "g")
  px(24, 8, "k"); line(29, 10, 30, 11, "r", 1)
  shade([2, 6, 27, 16], 1)` },
  lamp: { w: 22, h: 32, code: `
  rect(8, 28, 6, 4, "m")
  rect(9, 15, 4, 13, "N")
  poly([5,14, 17,14, 15,6, 7,6], "N")
  rect(7, 7, 8, 7, "y"); rect(9, 8, 4, 5, "w")
  rect(6, 4, 10, 3, "m")
  shade([5, 6, 12, 8], 1)` },
  chest: { w: 30, h: 22, code: `
  rect(2, 7, 26, 13, "e")
  rect(3, 4, 24, 6, "E")
  rect(4, 8, 22, 2, "y")
  rect(13, 7, 4, 8, "y"); rect(14, 10, 2, 2, "k")
  line(4, 13, 26, 13, "E"); rect(3, 17, 24, 2, "e")
  shade([2, 4, 26, 15], 1)` },
  cookie: { w: 18, h: 18, code: `
  ellipse(9, 9, 7, 7, "y")
  ellipse(6, 7, 1, 1, "E"); ellipse(11, 5, 1, 1, "E")
  ellipse(12, 11, 2, 1, "o"); ellipse(7, 12, 1, 1, "E")
  shade([2, 2, 14, 14], 1)` },
  car: { w: 36, h: 22, code: `
  rect(2, 9, 32, 9, "b")
  poly([7,9, 11,3, 25,3, 30,9], "B")
  rect(12, 5, 5, 4, "n"); rect(20, 5, 5, 4, "n")
  ellipse(8, 18, 4, 3, "m"); ellipse(28, 18, 4, 3, "m")
  ellipse(8, 18, 2, 1, "N"); ellipse(28, 18, 2, 1, "N")
  rect(2, 12, 3, 2, "y")
  shade([2, 8, 32, 10], 1)` },
  blob: { w: 26, h: 26, code: `
  ellipse(13, 14, 10, 9, "p")
  ellipse(9, 12, 6, 5, "P")
  ellipse(9, 11, 2, 2, "w"); ellipse(18, 11, 2, 2, "w")
  px(10, 12, "k"); px(17, 12, "k")
  poly([10,17, 13,19, 16,17], "k")
  shade([3, 6, 20, 14], 1)` },
};

// The first exact-pixel library, drawn in the 32x32 Final-Fantasy-like shape language:
// selective dark edges, four to six tones per material, and one readable signature feature.
Object.assign(SPRITES, {
  dragon: { w: 32, h: 32, grid: [
    '................k....k..........',
    '...............kyk..kyk.........',
    '...............kyykkkyk.........',
    '................kyyyyk..........',
    '...............kGGGGGGk.........',
    '..............kGGwwwwGGk........',
    '..............kGGwkwkGGk........',
    '..............kGGGwwGGGk........',
    '...............kGGbbGGk.........',
    '................kGGGGk..........',
    '................kGGGGk..........',
    '.........kk.....kGGGGk.....kk...',
    '.......kkRRkk...kGGGGk...kkRRkk.',
    '......kRRrrrrk.kGGGGGGk.krrrrRRk',
    '.....kRrrRRrrrkGGbbbbGGkrrrRRrrR',
    '...kRrrRRRRrrkGbbbbbbGkrrRRRRrrR',
    '..kRrrRRRRRRrkGbBbBbBGkrrRRRRRRr',
    '..kRRRRRRRRRRkGbbbbbbGkrrRRRRRRR',
    '....kkkkkkkkkkkGGGGGGGGkkkkkkkkk',
    '............kGGGGGGGGGk.........',
    '...........kGGGGGGGGGGGk........',
    '...........kGgGGGGGGGGGk........',
    '...........kGGGGGGGGGGGk........',
    '..........kGGGGGGGGGGGGGk.......',
    '..........kGGkGGGGGGkGGk........',
    '.........kGGGkGGGGGGkGGGk.......',
    '.........kGGGk.kGGk.kGGGk.......',
    '........kGGGk...kk...kGGGk......',
    '........kGGk..........kGGk......',
    '.......kyyk............kyyk.....',
    '......kyyyk............kyyyk....',
    '.......kkk..............kkk.....',
  ] },
  witch: { w: 32, h: 32, grid: [
    '................................',
    '..............kk................',
    '.............kpPk...............',
    '............kpPPpk..............',
    '...........kpPPPPPk.............',
    '..........kpPPPPPPPk............',
    '.........kpPPpPPPPPpk...........',
    '........kRRRRRRRRRRRk...........',
    '........kkkkkkkkkkkkk...........',
    '............kSSSSk..............',
    '...........kSssssSk.............',
    '...........kSwkwSsk.............',
    '...........kSssssSk.............',
    '............kSssk...............',
    '..........kkppppkk..............',
    '.........kppPppPppk.............',
    '........kpPpppppPppk............',
    '.......kSppPppppPppSk...........',
    '.......kSkppppppppkSk...........',
    '........k.kppppppk.k............',
    '..........kppppppk..............',
    '..........kpPppPpk..............',
    '.........kppppppppk.............',
    '........kppppppppppk............',
    '.......kppppppppppppk...........',
    '......kppPppPppPppPppk..........',
    '.....kppppppppppppppppk.........',
    '....kPppppppppppppppppPk........',
    '....kkkkkkkkkkkkkkkkkkkk........',
    '.........kyk...kyk..............',
    '........kyyk...kyyk.............',
    '................................',
  ] },
  person: { w: 32, h: 32, grid: [
    '................................',
    '............kkkkkk..............',
    '..........kkEeeeEkk.............',
    '.........kEeeeeeeEk.............',
    '........kEeSSSSSSeEk............',
    '........kESSssssSSEk............',
    '........kESskwskwsESk...........',
    '.........kSssssssSSk............',
    '..........kSskksSk..............',
    '...........ksssk................',
    '..........kkbbbkk...............',
    '.........kbbbbbbbk..............',
    '........kbBbbbbbBbk.............',
    '.......kSbbbbbbbbbk.............',
    '......kSskbbbbbbksSk............',
    '......kSkbbbbbbbbkSk............',
    '........kbbbbbbbbk..............',
    '........kBBBBBBBBk..............',
    '........kNNNNNNNNk..............',
    '........kNNk..kNNk..............',
    '........kNNk..kNNk..............',
    '........kNNk..kNNk..............',
    '........kNNk..kNNk..............',
    '.......kNNk....kNNk.............',
    '.......kNNk....kNNk.............',
    '......kNNk......kNNk............',
    '.....kNNNk......kNNNk...........',
    '....kNNNNk......kNNNNk..........',
    '...kkkkkkk......kkkkkkk.........',
    '...kssssk........ksssssk........',
    '..kSSSSSSk......kSSSSSSk........',
    '................................',
  ] },
  tree: { w: 32, h: 32, grid: [
    '................................',
    '..............kk................',
    '.............kllk...............',
    '............klgGk...............',
    '...........klgggGk..............',
    '..........klgggggGk.............',
    '.........klgggggggGk............',
    '........kggggGGGGGGgk...........',
    '.......kgggGGGGGGGGGgk..........',
    '......kggGGGGGGGGGGGGgk.........',
    '.......kkkkkkkkkkkkkk...........',
    '..........klgggGk...............',
    '.........klgggggGk..............',
    '........kgggggggGgk.............',
    '.......kgggGGGGGGGgk............',
    '......kggGGGGGGGGGGgk...........',
    '.......kkkkkkkkkkkkk............',
    '.........klggggGk...............',
    '........klggggggGk..............',
    '.......kgggGGGGGggk.............',
    '......kggGGGGGGGGGgk............',
    '.....kggGGGGGGGGGGGGgk..........',
    '......kkkkkkkkkkkkkkk...........',
    '...........kEBk.................',
    '...........kEBk.................',
    '...........kEBk.................',
    '..........kEEBBk................',
    '..........kEEBBk................',
    '.........kEEBBBBk...............',
    '........kkkkkkkkk...............',
    '................................',
    '................................',
  ] },
  tower: { w: 32, h: 32, grid: [
    '...............k................',
    '..............kak...............',
    '..............kak...............',
    '.............kkNkk..............',
    '...........kkNNNNNkk............',
    '..........kNNnnnnnNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnmnnnmNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnaaanaNNk...........',
    '..........kNnnnnnnNNk...........',
    '..........kNnnnnnnNNk...........',
    '.........kkNnnnnnnNNkk..........',
    '........kNNNNmmmmNNNNNk.........',
    '........kNnnnnnnnnnnnNk.........',
    '........kNNNNNNNNNNNNNk.........',
    '........kkkkkkkkkkkkkkk.........',
    '................................',
    '................................',
  ] },
  flower: { w: 32, h: 32, grid: [
    '................................',
    '................................',
    '............kkkk................',
    '..........kkyYYykk..............',
    '.........kyyYyyYYyk.............',
    '........kyYYyyyyYYYk............',
    '.......kyYYywwwyYYYk............',
    '.......kyYywwwwwyYYk............',
    '.......kyYywwowwyYYk............',
    '........kyYYwwyYYyk.............',
    '.........kyyYYYYyyk.............',
    '..........kkyYYykk..............',
    '............kGGk................',
    '............kGGk................',
    '...........kGGGGk...............',
    '.......kk..kGgGGk..kk...........',
    '......kGGkkGgGGGGkkGGk..........',
    '.....kGGgGGGGGGGGGgGGk..........',
    '.....kGgk.kGgGGGGk.kGgk.........',
    '......kk..kGGgGGGk..kk..........',
    '..........kGGGGGGk..............',
    '..........kGgGGGGk..............',
    '..........kGGgGGGk..............',
    '..........kGGGGGGk..............',
    '..........kGgGGGGk..............',
    '..........kGGgGGGk..............',
    '..........kGGGGGGk..............',
    '..........kGGgGGk...............',
    '..........kGGGGGk...............',
    '.........kGgGGGGGk..............',
    '.........kkkkkkkkk..............',
    '................................',
  ] },
  scribble: { w: 32, h: 32, grid: [
    '................................',
    '........kk..........kk..........',
    '.......kNNk........kNNk.........',
    '.......kNnnkkkkkkkkNnk..........',
    '.....kkkNnnnnnnnnnnNkkk.........',
    '....kNnnnnnnnnnnnnnnnnNk........',
    '...kNnnNNNNNNNNNNNNNNnnNk.......',
    '..kNnnNNbbbbbbbbbbbbNNnnNk......',
    '..kNnNNbbbwwbbbbwwbbbNNnNk......',
    '..kNnNbbbwwwwbbwwwwbbbNnNk......',
    '..kNnNbbwwkwwwbbwwwkwwbNnNk.....',
    '..kNnNbbbwwwwbbwwwwbbbNnNk......',
    '..kNnNNbbbwwbbbbwwbbbNNnNk......',
    '..kNnnNNbbbbbbbbbbbbNNnnNk......',
    '..kNnnnNNNNNNNNNNNNNNnnnnNk.....',
    '...kNnnnnnnnnnnnnnnnnnnNk.......',
    '....kkNnnnnnnnnnnnnnnNkk........',
    '......kNNNNNNNNNNNNNNk..........',
    '........kkNNNNNNNNkk............',
    '..........kNNNNNNk..............',
    '.........kNNkkkkNNk.............',
    '........kNNk....kNNk............',
    '........kNNk....kNNk............',
    '.......kNNk......kNNk...........',
    '.......kNNk......kNNk...........',
    '......kNNk........kNNk..........',
    '......kNNk........kNNk..........',
    '.....kNNNk........kNNNk.........',
    '....kNNNNk........kNNNNk........',
    '...kkkkkkk........kkkkkkk.......',
    '......kk............kk..........',
    '................................',
  ] },
});

const dims = {};
for (const [name, sprite] of Object.entries(SPRITES)) {
  if (sprite.grid) {
    const columns = sprite.mx ? sprite.w / 2 : sprite.w;
    if (sprite.grid.length !== sprite.h || sprite.grid.some(row => row.length !== columns))
      throw new Error(`${name}: grid must be exactly ${sprite.w}x${sprite.h}`);
    dims[name] = { w: sprite.w, h: sprite.h, source: sprite };
  } else dims[name] = { w: sprite.w + 2, h: sprite.h + 2, source: sprite };
}

const VARIANTS = {
  person: [{}, { b: 'g', B: 'G' }, { b: 'r', B: 'R' }, { b: 'p', B: 'P' }],
  witch: [{}, { p: 'b', P: 'B' }],
  dragon: [{}, { g: 'b', G: 'B' }, { g: 'r', G: 'R' }],
  tree: [{}, { g: 'G', G: 'g' }],
  flower: [{}, { y: 'p', Y: 'R' }, { y: 'b', Y: 'B' }],
  scribble: [{}, { n: 'b', N: 'B' }, { n: 'p', N: 'P' }],
  mouse: [{}, { n: 'b', N: 'B' }, { n: 'y', N: 'o' }],
  fish: [{}, { b: 'g', B: 'G' }, { b: 'p', B: 'P' }],
  snake: [{}, { g: 'b', G: 'B' }],
  tower: [{}, { a: 'y' }],
  chest: [{}, { e: 'E', E: 'e' }],
  cookie: [{}, { y: 'r' }, { y: 'n' }],
  car: [{}, { b: 'g' }, { b: 'r' }],
  blob: [{}, { p: 'b', P: 'B' }, { p: 'g', P: 'G' }],
};

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = ((h ^ c.charCodeAt(0)) * 16777619) >>> 0;
  return h;
}
export function parseMeta(file, text) {
  const pick = re => (re.exec(text) || [])[1];
  const name = pick(/\bname\s*:\s*['"]([^'"]+)['"]/s) || file.replace(/\.js$/, '').replace(/[-_]/g, ' ');
  const drawing = pick(/\bdrawing\s*:\s*['"]([^'"]*)['"]/s) || '';
  const kind = pick(/\bkind\s*:\s*['"]([^'"]+)['"]/s) || '';
  const p = /\bpaper\s*:\s*\{\s*x\s*:\s*([\d.]+)\s*,\s*y\s*:\s*([\d.]+)/s.exec(text);
  return { file, name, drawing, kind, paper: p ? { x: Math.max(0, Math.min(1, +p[1])), y: Math.max(0, Math.min(1, +p[2])) } : { x: .5, y: .5 } };
}
export function makeSource(things) {
  const spriteSource = Object.entries(dims).map(([name, d]) => d.source.grid
    ? `sprite(${JSON.stringify(`fallback-${name}`)}, ${d.source.mx ? '{ mx: true }' : `{ w: ${d.source.w}, h: ${d.source.h} }`}, \`
${d.source.grid.join('\n')}\`)`
    : `sprite(${JSON.stringify(`fallback-${name}`)}, { w: ${d.source.w}, h: ${d.source.h}, outline: "k" },
${d.source.code.trim().split('\n').map(line => line.trim()).filter(Boolean)
  .map(line => `  ${line.replace(/;\s*/g, ', ')},`).join('\n')}
)`).join('\n\n');
  const ops = [];
  for (const t of layoutThings(things)) {
    const kind = archetype(t), d = dims[kind];
    const { cx, cy } = t, tag = label(t.name);
    const x = Math.round(cx - d.w / 2), y = Math.round(cy - d.h);
    const variants = VARIANTS[kind] || [{}];
    const swap = variants[hash(t.file + t.name) % variants.length];
    ops.push(`  ellipse(${cx}, ${cy}, ${Math.max(4, Math.round(d.w * .55))}, 2, "m"),`);
    ops.push(`  stamp(${JSON.stringify(`fallback-${kind}`)}, ${x}, ${y}${Object.keys(swap).length ? `, { swap: ${JSON.stringify(swap)} }` : ''}),`);
    ops.push(`  text(${cx}, ${Math.min(176, cy + 4)}, ${JSON.stringify(tag)}, "k", { align: "c" }),`);
  }
  return `// generated by scripts/pixel-world.mjs from viewer/things; edit the script, not this file
${PAL}

${spriteSource}

scene("library", { w: 320, h: 200, bg: "B" },
  rect(0, 0, 320, 200, "B"),
  stamp("fallback-dragon", 40, 28),
  stamp("fallback-person", 40, 116),
  stamp("fallback-witch", 144, 28),
  stamp("fallback-tree", 144, 116),
  stamp("fallback-tower", 248, 28),
  text(40, 64, "DRAGON", "w", { align: "c" }),
  text(40, 152, "CHILD", "w", { align: "c" }),
  text(144, 64, "WITCH", "w", { align: "c" }),
  text(144, 152, "TREE", "w", { align: "c" }),
  text(248, 64, "TOWER", "w", { align: "c" })
)

scene("book", { w: ${SCENE.w}, h: ${SCENE.h}, bg: "B" },
  rect(0, 0, 320, 200, "B"),
  rect(12, 22, 142, 158, "c"),
  rect(166, 22, 142, 158, "c"),
  rect(150, 22, 20, 158, "R"),
  rect(12, 180, 142, 6, "C"),
  rect(166, 180, 142, 6, "C"),
)

scene("kritzel", { w: ${SCENE.w}, h: ${SCENE.h}, bg: "B" },
  rect(0, 0, 320, 200, "B"),
  rect(12, 22, 142, 158, "c"),
  rect(166, 22, 142, 158, "c"),
  rect(150, 22, 20, 158, "R"),
  rect(12, 180, 142, 6, "C"),
  rect(166, 180, 142, 6, "C"),
${ops.join('\n')}
)
`;
}

function ensurePxl() {
  const cli = path.join(PXL_DIR, 'bin', 'pxl.js');
  if (existsSync(cli)) return cli;
  mkdirSync(path.dirname(PXL_DIR), { recursive: true });
  execFileSync('git', ['clone', '--quiet', 'https://github.com/crsolver/claude-pxl', PXL_DIR], { stdio: 'inherit' });
  execFileSync('git', ['-C', PXL_DIR, 'checkout', '--quiet', PXL_COMMIT], { stdio: 'inherit' });
  return cli;
}

export function readThings(dir = THINGS) {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [];
  return files.map(f => parseMeta(f, readFileSync(path.join(dir, f), 'utf8')));
}

export function run() {
  const things = readThings();
  mkdirSync(path.dirname(ART), { recursive: true });
  writeFileSync(ART, makeSource(things));
  const cli = ensurePxl();
  const started = Date.now();
  execFileSync(process.execPath, [cli, 'build', ART, '--out', OUT, '--no-preview'], { cwd: ROOT, stdio: 'inherit' });
  if (process.env.KRITZEL_PIXEL_PREVIEW !== '0') {
    mkdirSync(path.dirname(LIBRARY), { recursive: true });
    execFileSync('convert', [path.join(OUT, 'scenes', 'library.png'), '-filter', 'point', '-resize', '400%', LIBRARY],
      { cwd: ROOT, stdio: 'inherit' });
  }
  const png = path.join(OUT, 'scenes', 'kritzel.png');
  const report = {
    ok: existsSync(png), things: things.length, art: path.relative(ROOT, ART), png: path.relative(ROOT, png),
    cli: `node bin/pxl.js build art/pixel-world.px.js --out viewer/pixel --no-preview`,
    commit: PXL_COMMIT, ms: Date.now() - started, bytes: existsSync(png) ? statSync(png).size : 0,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
