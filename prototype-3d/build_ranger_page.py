"""Собирает web_ranger/index.html (страница ИИ-эльфа) из общих частей web/index.html
и dist_ranger/index.html со встроенной моделью для публикации."""
import base64, pathlib, re
root = pathlib.Path(__file__).parent
src = (root / 'web/index.html').read_text()

head = src[:src.index('<div class="wrap">')]
head = head.replace('<title>Elf Archer Trials</title>', '<title>Elf Ranger</title>')
head = head.replace('.badge.c { background: var(--c); }', '.badge.c { background: var(--c); } .badge.d { background: var(--c); }')
head = head.replace('</style>', """  .info { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px; }
  @media (max-width: 900px) { .info { grid-template-columns: 1fr; } }
  .info .card { --tone: var(--c); }
</style>""")

markup = """<div class="wrap">
  <header>
    <div class="eyebrow">Castle Fight · модель с нуля в Blender</div>
    <h1>Эльфийка-следопыт</h1>
    <p class="lede">Модель построена с нуля в Blender по вашему листу с четырьмя ракурсами: цельное тело, одежда слоями, волосы с косой, колчан и лук. Анимации из библиотеки Quaternius Universal Animation Library (CC0), стрельба собрана отдельно. Сцену можно крутить мышью или пальцем.</p>
  </header>

  <section class="stage-wrap" aria-label="3D-сцена">
    <div class="stage" id="stage">
      <canvas id="view"></canvas>
      <div class="labels" id="labels"></div>
      <div class="loading" id="loading">Загружаю модель…</div>
      <div class="hint">Крутить: мышь / палец · Масштаб: колесо / щипок</div>
    </div>
    <div class="controls">
      <div class="group" role="group" aria-label="Анимация">
        <span>Анимация</span>
        <button id="anim-idle" data-anim="idle" aria-pressed="false">Покой</button>
        <button id="anim-walk" data-anim="walk" aria-pressed="false">Ходьба</button>
        <button id="anim-run" data-anim="run" aria-pressed="false">Бег</button>
        <button id="anim-shoot" data-anim="shoot" aria-pressed="true">Стрельба</button>
        <button id="anim-hit" data-anim="hit" aria-pressed="false">Попадание</button>
        <button id="anim-death" data-anim="death" aria-pressed="false">Смерть</button>
      </div>
      <div class="group" role="group" aria-label="Камера">
        <span>Камера</span>
        <button id="cam-close" data-cam="close" aria-pressed="true">Эльф</button>
        <button id="cam-range" data-cam="range" aria-pressed="false">С мишенью</button>
      </div>
      <div class="group">
        <button id="sound" aria-pressed="false">Звук: выкл</button>
      </div>
    </div>
  </section>

  <section class="info" aria-label="О модели">
    <article class="card">
      <h3><span class="badge d">D</span>Цифры</h3>
      <dl>
        <dt>Файл</dt><dd data-stat="D-size">—</dd>
        <dt>Треугольники</dt><dd data-stat="D-tris">—</dd>
        <dt>Кости</dt><dd data-stat="D-bones">—</dd>
        <dt>Анимации</dt><dd data-stat="D-clips">—</dd>
        <dt>Исходник</dt><dd>с нуля, скрипт Blender</dd>
        <dt>Анимации взяты</dt><dd>Quaternius UAL, CC0</dd>
        <dt>Материалы</dt><dd data-stat="D-mats">—</dd>
      </dl>
    </article>
    <article class="card">
      <h3>Что сделано и что осталось</h3>
      <div class="pc plus"><h4>Сделано</h4><ul>
        <li>Тело одной гладкой сеткой по замерам с референса, одежда отдельными слоями поверх</li>
        <li>Веса тела посчитаны автоматически, одежда копирует их с тела, поэтому ничего не рвётся</li>
        <li>Лук перенесён со спины в левую руку, чтобы стрелять; колчан за спиной</li>
        <li>Покой, ходьба, бег, попадание и смерть из библиотеки анимаций; стрельба с натяжением и отдачей</li>
      </ul></div>
      <div class="pc minus"><h4>Можно улучшить</h4><ul>
        <li>Материалы однотонные, без текстур: нет узоров на тунике и фактуры кожи</li>
        <li>Лицо упрощённое, пальцы и тетива не анимированы</li>
        <li>Плащ качается на одной кости, без симуляции ткани</li>
      </ul></div>
    </article>
  </section>
</div>

"""

script_start = src.index('<script type="importmap">')
script_end = src.index('// ---------- A: Blender')
script = src[script_start:script_end]
script = re.sub(r"const LANES = \[.*?\];", "const LANES = [\n  { key: 'D', name: 'Эльфийка', z: 0, color: '#b995e6' },\n];", script, flags=re.S)
script = script.replace("renderer.toneMappingExposure = 1.05;", "renderer.toneMappingExposure = 1.3;")

tail = r"""
// ---------- D: модель из нейросети
async function loadAI() {
  const lane = LANES[0];
  const gltf = await loadGLB('models/elf_ranger.glb.b64.txt');
  const holder = placeUnit(gltf.scene, lane, 1.75);
  const handL = gltf.scene.getObjectByName('handL');
  const handR = gltf.scene.getObjectByName('handR');
  const arrow = makeArrowMesh(0.8);
  arrow.visible = false;
  scene.add(arrow);
  const release = 21 / 30, back = 33 / 30;
  const a = new V3(), b = new V3();
  const u = clipUnit({
    lane, holder, gltf,
    map: { idle: 'Idle', walk: 'Walk', run: 'Run', shoot: 'Shoot', hit: 'Hit', death: 'Death' },
    release,
    anchor: () => handL,
    onShootUpdate(u) {
      // стрела на тетиве: от правой кисти через кулак с луком
      let vis = false;
      if (u.state === 'shoot') {
        const t = u.actions.shoot.time;
        vis = t < release || t > back;
      }
      arrow.visible = vis;
      if (vis) {
        handR.getWorldPosition(a);
        handL.getWorldPosition(b);
        arrow.position.copy(a);
        arrow.lookAt(b.x + (b.x - a.x) * 4, b.y + (b.y - a.y) * 4, b.z + (b.z - a.z) * 4);
      }
    },
  });
  let bones = 0;
  gltf.scene.traverse(o => { if (o.isBone) bones++; });
  setStat('D-size', fmtBytes(gltf.byteLength));
  setStat('D-tris', countTris(gltf.scene).toLocaleString('ru-RU'));
  setStat('D-bones', String(bones));
  setStat('D-clips', String(gltf.animations.length));
  const mats = new Set(); gltf.scene.traverse(o => { if (o.isMesh) [].concat(o.material).forEach(m => mats.add(m)); });
  setStat('D-mats', String(mats.size));
  return u;
}

// ------------------------------------------------------------------ labels & camera
const labelEls = LANES.map(lane => {
  const el = document.createElement('div');
  el.className = 'label';
  el.innerHTML = `<span class="badge ${lane.key.toLowerCase()}">${lane.key}</span>${lane.name}`;
  labelsEl.appendChild(el);
  return el;
});
function updateLabels() {
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  LANES.forEach((lane, i) => {
    const p = new V3(0, 2.25, lane.z).project(camera);
    const el = labelEls[i];
    el.hidden = p.z > 1;
    el.style.transform = `translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
  });
}
const CAMS = {
  close: { pos: new V3(2.9, 1.7, 2.7), look: new V3(0, 1.05, 0) },
  range: { pos: new V3(4.3, 3.6, 9.8), look: new V3(4.3, 1.0, 0) },
};
let camAnim = null;
function goCam(k, instant = false) {
  const c = CAMS[k];
  const pos = c.pos.clone();
  if (camera.aspect < 1) pos.sub(c.look).multiplyScalar(k === 'range' ? 1.8 : 1.35).add(c.look);
  if (instant || reduceMotion) {
    camera.position.copy(pos); controls.target.copy(c.look); controls.update();
    return;
  }
  camAnim = { t: 0, fromP: camera.position.clone(), fromL: controls.target.clone(), toP: pos, toL: c.look.clone() };
}
function resize() {
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stageEl);
resize();
goCam('close', true);

// ------------------------------------------------------------------ UI
function press(selector, attr, val) {
  document.querySelectorAll(selector).forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === val)));
}
let currentAnim = 'shoot';
document.querySelectorAll('[data-anim]').forEach(b => b.addEventListener('click', () => {
  currentAnim = b.dataset.anim;
  press('[data-anim]', 'data-anim', currentAnim);
  units.forEach(u => u.play(currentAnim));
}));
document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => {
  press('[data-cam]', 'data-cam', b.dataset.cam);
  goCam(b.dataset.cam);
}));
const soundBtn = document.getElementById('sound');
soundBtn.addEventListener('click', () => {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  soundOn = !soundOn;
  soundBtn.setAttribute('aria-pressed', String(soundOn));
  soundBtn.textContent = soundOn ? 'Звук: вкл' : 'Звук: выкл';
});

// ------------------------------------------------------------------ boot
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const u of units) u.update(dt);
  updateProjectiles(dt);
  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 0.9);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
    controls.target.lerpVectors(camAnim.fromL, camAnim.toL, e);
    if (camAnim.t >= 1) camAnim = null;
  }
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const loadingEl = document.getElementById('loading');
loadAI().then(u => {
  units.push(u);
  u.play(currentAnim);
  loadingEl.hidden = true;
}).catch(err => {
  console.error(err);
  loadingEl.textContent = err.message || String(err);
});
</script>
"""
page = head + markup + script + tail
out = root / 'web_ranger/index.html'
out.write_text(page)
# версия для публикации: модель встроена в страницу
b64 = base64.b64encode((root / 'web_ranger/models/elf_ranger.glb').read_bytes()).decode()
block = f'<script type="text/plain" data-model="models/elf_ranger.glb.b64.txt">{b64}</script>\n'
dist = page.replace('<script type="importmap">', block + '<script type="importmap">', 1)
(root / 'dist_ranger').mkdir(exist_ok=True)
(root / 'dist_ranger/index.html').write_text(dist)
print(out, len(page), 'dist', len(dist))
