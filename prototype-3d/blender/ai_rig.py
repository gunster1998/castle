"""
Шаг 2: риг и анимации для сгенерированного эльфа (extracted.blend из ai_extract.py).
  * скелет из 17 костей по разметке суставов (модель стоит в A-позе, лицом в -Y);
  * веса считаются по зонам: лук целиком к левой кисти, плащ к кости cape, руки/ноги/голова
    по расстоянию до ближайших костей своей зоны;
  * анимации Idle, Walk, Shoot, Death;
  * металл/шероховатость из текстуры убраны (стилизованный вид, и так надёжнее в браузере).
Запуск: blender -b -P ai_rig.py -- <extracted.blend> <out_dir> [--render]
"""
import bpy, sys, os, math
import numpy as np
from mathutils import Vector, Quaternion, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
RENDER = '--render' in argv
bpy.ops.wm.open_mainfile(filepath=SRC)
sc = bpy.context.scene
sc.render.fps = 30
V = Vector
body = bpy.data.objects['ElfBody']

# ---------------------------------------------------------------- материал
for m in body.data.materials:
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    for name in ('Metallic', 'Roughness'):
        for l in list(b.inputs[name].links):
            nt.links.remove(l)
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Roughness'].default_value = 0.8
    for n in [n for n in nt.nodes if n.type == 'TEX_IMAGE' and not n.outputs['Color'].links]:
        nt.nodes.remove(n)

# ---------------------------------------------------------------- скелет (разметка по ортопроекциям)
J = {
    'shL': V((0.24, 0.0, 1.43)), 'elL': V((0.39, -0.01, 1.2)), 'wrL': V((0.5, -0.02, 1.0)), 'fiL': V((0.51, -0.03, 0.88)),
    'hipL': V((0.11, 0.0, 0.95)), 'knL': V((0.12, -0.02, 0.5)), 'anL': V((0.13, 0.0, 0.12)), 'toeL': V((0.13, -0.2, 0.03)),
}
for k in list(J):
    if k.endswith('L'):
        p = J[k]
        J[k[:-1] + 'R'] = V((-p.x, p.y, p.z))

BONES = [
    ('root', V((0, 0, 0)), V((0, 0, 0.3)), None),
    ('hips', V((0, 0, 0.95)), V((0, 0, 1.1)), 'root'),
    ('spine', V((0, 0, 1.1)), V((0, 0, 1.45)), 'hips'),
    ('head', V((0, -0.02, 1.52)), V((0, -0.02, 1.88)), 'spine'),
    ('cape', V((0, 0.14, 1.4)), V((0, 0.24, 0.6)), 'spine'),
]
for s in 'LR':
    BONES += [
        (f'upper_arm.{s}', J['sh' + s], J['el' + s], 'spine'),
        (f'forearm.{s}', J['el' + s], J['wr' + s], f'upper_arm.{s}'),
        (f'hand.{s}', J['wr' + s], J['fi' + s], f'forearm.{s}'),
        (f'thigh.{s}', J['hip' + s], J['kn' + s], 'hips'),
        (f'shin.{s}', J['kn' + s], J['an' + s], f'thigh.{s}'),
        (f'foot.{s}', J['an' + s], J['toe' + s], f'shin.{s}'),
    ]
SEG = {n: (h, t) for n, h, t, _ in BONES}

arm_data = bpy.data.armatures.new('ElfRig')
ARM = bpy.data.objects.new('ElfArcherAI', arm_data)
sc.collection.objects.link(ARM)
bpy.context.view_layer.objects.active = ARM
bpy.ops.object.mode_set(mode='EDIT')
for n, h, t, p in BONES:
    eb = arm_data.edit_bones.new(n)
    eb.head, eb.tail, eb.roll = h, t, 0
    if p:
        eb.parent = arm_data.edit_bones[p]
bpy.ops.object.mode_set(mode='OBJECT')
BQ = {b.name: b.matrix_local.to_quaternion() for b in arm_data.bones}

# ---------------------------------------------------------------- веса по зонам
import bmesh
me = body.data

def verts_np():
    a = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)

def components():
    E = np.empty(len(me.edges) * 2, int)
    me.edges.foreach_get('vertices', E)
    E = E.reshape(-1, 2)
    parent = np.arange(len(me.vertices))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in E:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    return np.array([find(i) for i in range(len(parent))])

def bow_mask(P):
    x, y, z = P.T
    comp = components()
    labels, counts = np.unique(comp, return_counts=True)
    main = labels[np.argmax(counts)]
    isl = [l for l in labels if l != main and x[comp == l].max() > 0.4]
    grip_zone = (x > 0.4) & (z > 0.83) & (z < 1.08)
    B = np.isin(comp, isl) | ((x > 0.44) & ~grip_zone) \
        | ((x > 0.2) & (z > 0.18) & (z < 0.95) & ((y < -0.17) | ((y > 0.12) & (z < 0.6))))
    return B, grip_zone

# генератор сплавил лук с телом: режем грани-перемычки между луком и телом (кроме кулака)
P = verts_np()
B, grip = bow_mask(P)
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
cut = []
for f in bm.faces:
    ids = [v.index for v in f.verts]
    inb = [B[i] for i in ids]
    if any(inb) and not all(inb) and any((not B[i]) and not grip[i] for i in ids):
        cut.append(f)
bmesh.ops.delete(bm, geom=cut, context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(me)
bm.free()
print('CUT faces', len(cut))
P = verts_np()
B, grip = bow_mask(P)

def seg_dist(P, a, b):
    a, b = np.array(a), np.array(b)
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)

names = [n for n, *_ in BONES if n != 'root']
D = {n: seg_dist(P, *SEG[n]) for n in names}
x, y, z = P[:, 0], P[:, 1], P[:, 2]
ax = np.abs(x)

def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

W = {n: np.zeros(len(P)) for n in names}
done = np.zeros(len(P), bool)

def assign(mask, cands, power=4, eps=0.01):
    idx = np.where(mask & ~done)[0]
    if not len(idx):
        return
    d = np.stack([D[c][idx] for c in cands], 1)
    w = 1 / (d + eps) ** power
    # только три ближайшие кости
    if w.shape[1] > 3:
        cut = np.sort(w, 1)[:, -3][:, None]
        w = np.where(w >= cut, w, 0)
    w /= w.sum(1, keepdims=True)
    for i, c in enumerate(cands):
        W[c][idx] += w[:, i]
    done[idx] = True

bow = B
W['hand.L'][bow] = 1
done |= bow
# 2) колчан и верх спины
assign((y > 0.07) & (z > 1.3), ['spine', 'head'])
# 3) плащ сзади: доля кости cape растёт вниз и назад
cape = (y > 0.07) & (z > 0.45) & (ax < 0.4)
idx = np.where(cape & ~done)[0]
wc = smoothstep(0.08, 0.2, y[idx]) * smoothstep(1.35, 0.95, z[idx])
wz = smoothstep(0.95, 1.15, z[idx])
W['cape'][idx] += wc
W['spine'][idx] += (1 - wc) * wz
W['hips'][idx] += (1 - wc) * (1 - wz)
done[idx] = True
# 4) руки: близко к линии руки своей стороны
for s, sg in (('L', 1), ('R', -1)):
    near = np.minimum.reduce([D[f'upper_arm.{s}'], D[f'forearm.{s}'], D[f'hand.{s}']])
    edge = 0.30 + 0.25 * np.maximum(0, 1.25 - z)       # край плаща ближе к телу, чем рука
    assign((near < 0.13) & (sg * x > edge), [f'upper_arm.{s}', f'forearm.{s}', f'hand.{s}', 'spine'])
# 5) голова
assign(z > 1.6, ['head'])
assign(z > 1.5, ['head', 'spine'])
# 6) ноги
for s, sg in (('L', 1), ('R', -1)):
    assign((z < 0.98) & (sg * x >= 0), ['hips', f'thigh.{s}', f'shin.{s}', f'foot.{s}'])
# 7) наплечники: чем дальше от шеи, тем больше следуют за рукой
for s, sg in (('L', 1), ('R', -1)):
    sh = np.array(J['sh' + s])
    m = (np.linalg.norm(P - sh, axis=1) < 0.24) & (z > 1.38) & (sg * x > 0.16) & (y < 0.06) & ~done
    idx2 = np.where(m)[0]
    wa = smoothstep(0.17, 0.3, sg * x[idx2])
    W[f'upper_arm.{s}'][idx2] += wa
    W['spine'][idx2] += 1 - wa
    done[idx2] = True
# 8) остальное — торс (без рук: иначе плащ тянется за поднятой рукой)
assign(np.ones(len(P), bool), ['hips', 'spine', 'head'])

for n in names:
    vg = body.vertex_groups.new(name=n)
    nz = np.where(W[n] > 1e-3)[0]
    for i in nz:
        vg.add([int(i)], float(W[n][i]), 'REPLACE')
body.parent = ARM
mod = body.modifiers.new('Armature', 'ARMATURE')
mod.object = ARM
print('WEIGHTS done, bow verts', int(bow.sum()), 'cape verts', len(idx))

# ---------------------------------------------------------------- позы
PB = ARM.pose.bones
for pb in PB:
    pb.rotation_mode = 'QUATERNION'

def upd():
    bpy.context.view_layer.update()

def reset():
    for pb in PB:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)

def setq(bone, qw):
    B = BQ[bone]
    PB[bone].rotation_quaternion = B.inverted() @ qw @ B

def rot(bone, x=0.0, y=0.0, z=0.0):
    setq(bone, Euler((x, y, z), 'XYZ').to_quaternion())

def move(bone, v):
    PB[bone].location = BQ[bone].inverted() @ V(v)

def world_q(bone):
    return PB[bone].matrix.to_quaternion() @ BQ[bone].inverted()

def world_pos(bone):
    return PB[bone].head.copy()

UP_DIR = {s: (J['el' + s] - J['sh' + s]).normalized() for s in 'LR'}
FO_DIR = {s: (J['wr' + s] - J['el' + s]).normalized() for s in 'LR'}
LEN = {s: ((J['el' + s] - J['sh' + s]).length, (J['wr' + s] - J['el' + s]).length) for s in 'LR'}

def ik_arm(s, target, pole):
    upd()
    S = world_pos(f'upper_arm.{s}')
    qp = world_q('spine')
    a, b = LEN[s]
    d = V(target) - S
    dist = min(d.length, a + b - 1e-3)
    u = d.normalized()
    xx = (a * a - b * b + dist * dist) / (2 * dist)
    h = math.sqrt(max(a * a - xx * xx, 0))
    pole = V(pole)
    v = (pole - pole.dot(u) * u).normalized()
    E = S + u * xx + v * h
    Wp = S + u * dist
    # направление плеча в покое уже повёрнуто родителем (spine)
    q_up = (qp @ UP_DIR[s]).rotation_difference((E - S).normalized()) @ qp
    setq(f'upper_arm.{s}', qp.inverted() @ q_up)
    q_fo = (q_up @ FO_DIR[s]).rotation_difference((Wp - E).normalized()) @ q_up
    setq(f'forearm.{s}', q_up.inverted() @ q_fo)
    upd()

def orient_hand(s, R):
    upd()
    setq(f'hand.{s}', world_q(f'forearm.{s}').inverted() @ R)
    upd()

def key_all(frame):
    for pb in PB:
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        pb.keyframe_insert('location', frame=frame)

def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * t

ARMS_IN = 0.22     # A-поза -> руки ближе к телу

def pose_idle(f, n=60):
    reset()
    p = 2 * math.pi * f / n
    br = math.sin(p)
    move('hips', (0.01 * math.sin(p * 0.5), 0, -0.008 * (1 - math.cos(p))))
    rot('spine', 0.025 * br, 0, 0.03 * math.sin(p * 0.5))
    rot('head', -0.03 * br, 0, 0.15 * math.sin(p * 0.5))
    rot('upper_arm.L', -0.05, ARMS_IN * 0.4 + 0.02 * br)
    rot('forearm.L', -0.12)
    rot('upper_arm.R', 0.04 * br, -ARMS_IN - 0.02 * br)
    rot('forearm.R', -0.2 - 0.04 * br)
    rot('cape', 0.04 + 0.03 * math.sin(p - 0.6), 0, 0.02 * math.sin(p * 0.5 - 0.5))

def pose_walk(f, n=32):
    reset()
    p = 2 * math.pi * f / n
    s = math.sin(p)
    move('hips', (0, 0, 0.035 * math.cos(2 * p) - 0.02))
    rot('hips', 0, 0, 0.1 * s)
    rot('spine', 0.08, 0, -0.14 * s)
    rot('head', -0.05, 0, 0.08 * s)
    for side, sg in (('L', 1), ('R', -1)):
        ph = p if sg > 0 else p + math.pi
        th = -0.5 * math.sin(ph)
        kn = 0.12 + 0.8 * max(0.0, math.sin(ph - 1.9)) ** 1.2
        rot(f'thigh.{side}', th)
        rot(f'shin.{side}', kn)
        rot(f'foot.{side}', -0.6 * (th + kn) + 0.2 * max(0.0, -math.sin(ph)))
    rot('upper_arm.R', 0.45 * s, -ARMS_IN)
    rot('forearm.R', -0.3 - 0.3 * max(0.0, -s))
    rot('upper_arm.L', -0.15 - 0.12 * s, ARMS_IN * 0.4)
    rot('forearm.L', -0.2)
    rot('cape', 0.32 + 0.08 * math.sin(2 * p - 1.2), 0, 0.06 * math.sin(p - 0.8))

LW_TARGET = V((0.06, -0.5, 1.42))
CHIN = V((-0.03, -0.2, 1.52))
QUIVER = V((-0.12, 0.2, 1.62))

def pose_shoot(f):
    """36 кадров: подъём и натяжение 0-14, удержание, выстрел на 21, рука за стрелой к колчану."""
    reset()
    rec = smooth((f - 21) / 2) * (1 - smooth((f - 23) / 8)) if f >= 21 else 0.0
    rot('hips', 0, 0, 0.28)
    rot('spine', 0.02 + 0.07 * rec, 0, -0.4)
    rot('head', -0.03, 0, 0.34)
    rot('thigh.L', -0.18, -0.12); rot('shin.L', 0.18); rot('foot.L', 0.0, 0.12)
    rot('thigh.R', 0.22, 0.12); rot('shin.R', 0.14); rot('foot.R', -0.36, -0.12)
    move('hips', (0, 0.015 * rec, -0.03))
    ik_arm('L', LW_TARGET + V((0, 0.03 * rec, 0.02 * rec)), (1, 0.4, -0.5))
    orient_hand('L', Quaternion((0, 0, 1), 0.0))        # лук вертикально, как в исходной модели
    upd()
    grip = world_pos('hand.L')
    start = grip + V((-0.05, 0.1, 0.03))
    if f <= 3:
        tgt = QUIVER.lerp(start, smooth(f / 3))
    elif f <= 14:
        tgt = start.lerp(CHIN, smooth((f - 3) / 11))
    elif f <= 20:
        tgt = CHIN + V((0, 0, 0.003 * math.sin(f * 2.3)))
    elif f <= 25:
        tgt = CHIN.lerp(CHIN + V((-0.16, 0.12, 0.03)), smooth((f - 20) / 3))
    else:
        tgt = (CHIN + V((-0.16, 0.12, 0.03))).lerp(QUIVER, smooth((f - 25) / 8))
    ik_arm('R', tgt, (-1, 0.8, 0.1))
    rot('cape', 0.1 + 0.25 * rec, 0, 0.04 * math.sin(f / 36 * 2 * math.pi))

def pose_death(f):
    reset()
    t1 = smooth(f / 9)
    t2 = smooth((f - 7) / 15)
    t3 = smooth((f - 22) / 5) * (1 - smooth((f - 27) / 5))
    move('hips', (0, lerp(0, 0.36, t2), lerp(-0.12 * t1, -0.8, t2) + 0.03 * t3))
    rot('hips', lerp(0, -1.5, t2), 0, 0.2 * t2)
    rot('spine', lerp(0.35 * t1, 0.05, t2))
    rot('head', lerp(0.3 * t1, -0.25, t2), 0, 0.5 * t2)
    for side, sg in (('L', 1), ('R', -1)):
        rot(f'thigh.{side}', lerp(-0.55 * t1, -0.1, t2), -sg * 0.15 * t2)
        rot(f'shin.{side}', lerp(0.9 * t1, 0.3 if sg > 0 else 0.12, t2))
        rot(f'foot.{side}', lerp(-0.3 * t1, 0.4, t2))
        rot(f'upper_arm.{side}', lerp(-0.6 * t1, -0.3, t2), -sg * lerp(0.1 * t1, 0.9, t2))
        rot(f'forearm.{side}', lerp(-0.4 * t1, -0.2, t2))
    rot('cape', lerp(0.5 * t1, 1.3, t2) - 0.15 * t3)

# ---------------------------------------------------------------- клипы
ARM.animation_data_create()
CLIPS = [('Idle', 60, pose_idle, 2), ('Walk', 32, pose_walk, 1), ('Shoot', 36, pose_shoot, 1), ('Death', 40, pose_death, 1)]
actions = []
for name, n, fn, step in CLIPS:
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ARM.animation_data.action = act
    frames = list(range(0, n + 1, step))
    if frames[-1] != n:
        frames.append(n)
    for fr in frames:
        fn(fr if name == 'Death' else fr % n)
        key_all(fr)
    actions.append(act)

if RENDER:
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 40
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 380, 460
    lookup = {a.name: a for a in actions}
    shots = [('Idle', 0), ('Walk', 8), ('Walk', 24), ('Shoot', 16), ('Shoot', 27), ('Death', 12), ('Death', 40)]
    for i, (nm, fr) in enumerate(shots):
        cam.location = (2.6, -3.4, 1.7)
        cam.rotation_euler = (V((0, 0, 0.95)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        ARM.animation_data.action = lookup[nm]
        sc.frame_set(fr)
        sc.render.filepath = os.path.join(OUT, f'rig_{i}_{nm}_{fr:02d}.png')
        bpy.ops.render.render(write_still=True)
    cam.location = (0.2, 3.6, 1.6)
    cam.rotation_euler = (V((0, 0, 0.95)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    ARM.animation_data.action = lookup['Walk']
    sc.frame_set(8)
    sc.render.filepath = os.path.join(OUT, 'rig_7_back_walk.png')
    bpy.ops.render.render(write_still=True)

for act in actions:
    tr = ARM.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, 0, act)
ARM.animation_data.action = None
sc.frame_set(0)
reset()

path = os.path.join(OUT, 'elf_archer_ai.glb')
bpy.ops.export_scene.gltf(
    filepath=path, export_format='GLB', export_animations=True, export_animation_mode='ACTIONS',
    export_apply=True, export_yup=True, export_image_format='JPEG', export_jpeg_quality=88,
)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'elf_archer_ai.blend'))
print('EXPORTED', path, os.path.getsize(path))
