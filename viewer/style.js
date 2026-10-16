// Kritzel's look: the world drawn on paper. One extra full-screen pass over the rendered scene adds
// thick ink outlines (where depth jumps: silhouettes and steps), pencil hatching in the shade and a
// paper grain, the same for every thing, however it was modelled. Cheap: no extra draw calls, one
// pass over the screen. Off until chosen: ?style=paper turns it on (style.enabled at runtime).

export function createStyle({ THREE, renderer, scene, camera }) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });
  target.depthTexture = new THREE.DepthTexture(size.x, size.y);

  // paper fibres: a small tiling noise texture, drawn once
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d'), img = g.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const x = i % 256, y = i / 256 | 0;
    const v = 200 + 40 * Math.random() + 15 * Math.sin(x * 0.21 + Math.sin(y * 0.07) * 3);
    img.data.set([v, v, v, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  const paper = new THREE.CanvasTexture(cv);
  paper.wrapS = paper.wrapT = THREE.RepeatWrapping;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: target.texture }, tDepth: { value: target.depthTexture }, tPaper: { value: paper },
      res: { value: size.clone() }, near: { value: camera.near }, far: { value: camera.far },
      inkColor: { value: new THREE.Color(0x2b2622) }, inkWidth: { value: 1.6 * Math.min(2, renderer.getPixelRatio()) },
      hatch: { value: 1 }, grain: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      #include <packing>
      varying vec2 vUv;
      uniform sampler2D tColor, tDepth, tPaper;
      uniform vec2 res; uniform float near, far, inkWidth, hatch, grain; uniform vec3 inkColor;
      float viewZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
      void main() {
        vec4 c = texture2D(tColor, vUv);
        vec2 px = inkWidth / res;
        float d = viewZ(vUv);
        // ink where the depth jumps (relative to how far away it is): outlines, thicker up close
        float e = abs(viewZ(vUv + vec2(px.x, 0.0)) - d) + abs(viewZ(vUv - vec2(px.x, 0.0)) - d)
                + abs(viewZ(vUv + vec2(0.0, px.y)) - d) + abs(viewZ(vUv - vec2(0.0, px.y)) - d);
        float edge = smoothstep(0.035, 0.08, e / max(d, 0.5));
        vec3 col = c.rgb;
        if (c.a > 0.01) {
          // pencil hatching in the shade: diagonal strokes, crossed where it is darker
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          vec2 p = gl_FragCoord.xy;
          float h1 = step(fract((p.x + p.y) / 7.0), 0.22) * smoothstep(0.42, 0.22, l);
          float h2 = step(fract((p.x - p.y) / 7.0), 0.22) * smoothstep(0.16, 0.06, l);
          col = mix(col, inkColor, max(h1, h2) * 0.28 * hatch);
          // paper grain
          float fibre = texture2D(tPaper, gl_FragCoord.xy / 256.0).r;
          col *= mix(1.0, 0.82 + 0.25 * fibre, grain);
        }
        float a = max(c.a, edge);
        gl_FragColor = vec4(mix(col, inkColor, edge * 0.92), a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const post = new THREE.Scene();
  post.add(quad);
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const plain = new URLSearchParams(location.search).get('style') !== 'paper';   // opt-in until Sebastian chooses
  camera.layers.enable(1);             // layer 1: speech bubbles and name tags, drawn on top of the paper
  const api = {
    enabled: !plain,
    render() {
      if (!api.enabled) return renderer.render(scene, camera);
      camera.layers.disable(1);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(post, flat);
      camera.layers.set(1);                 // the bubbles, clean on top
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = auto;
      camera.layers.enable(0);
    },
    setSize() {
      renderer.getDrawingBufferSize(size);
      target.setSize(size.x, size.y);
      material.uniforms.res.value.copy(size);
    },
    uniforms: material.uniforms,     // for trying things out: inkWidth, hatch, grain, inkColor
  };
  return api;
}
