"""
Риг и анимации для эльфийки-следопыта, построенной с нуля (elf_ranger.py).
  * скелет по суставам BODY из elf_ranger.py;
  * тело: автоматические веса (heat); одежда копирует веса с тела (Data Transfer);
    голова/волосы -> head, кисти -> hand, лук -> hand.L, колчан -> spine, плащ -> spine+cape;
  * всё сливается в одну сетку; анимации Quaternius UAL (CC0) + стрельба.
Запуск: blender -b -P ranger_rig.py -- <model.blend> <out_dir> <UAL.gltf> [--render]
"""
import bpy, sys, os, math
import numpy as np
from mathutils import Vector, Quaternion, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, UAL = argv[0], argv[1], argv[2]
RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=SRC)
sc = bpy.context.scene
sc.render.fps = 30
V = Vector
ns = {'STAGE': []}
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)) if '__file__' in dir() else '/Users/konstantin/repos/castle/prototype-3d/blender', 'elf_ranger.py')).read(), ns)
BODY = ns['BODY']

# убрать из файла всё, кроме модели
keep = set(bpy.data.collections['ElfRanger'].objects)
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)

def bj(n):
    return V(BODY[n][0])

J = {}
for s in 'LR':
    J['sh' + s], J['el' + s], J['wr' + s] = bj(f'shoulder.{s}'), bj(f'elbow.{s}'), bj(f'wrist.{s}')
BONES = [
    ('root', V((0, 0, 0)), V((0, 0, 0.3)), None),
    ('hips', bj('pelvis'), bj('waist'), 'root'),
    ('spine', bj('waist'), bj('neck0'), 'hips'),
    ('head', bj('neck0'), V((0, 0, 1.8)), 'spine'),
    ('cape', V((0, 0.15, 1.44)), V((0, 0.24, 0.64)), 'spine'),
]
for s in 'LR':
    d = (J['wr' + s] - J['el' + s]).normalized()
    BONES += [
        (f'upper_arm.{s}', J['sh' + s], J['el' + s], 'spine'),
        (f'forearm.{s}', J['el' + s], J['wr' + s], f'upper_arm.{s}'),
        (f'hand.{s}', J['wr' + s], J['wr' + s] + d * 0.16, f'forearm.{s}'),
        (f'thigh.{s}', bj(f'hip.{s}'), bj(f'knee.{s}'), 'hips'),
        (f'shin.{s}', bj(f'knee.{s}'), bj(f'ankle.{s}'), f'thigh.{s}'),
        (f'foot.{s}', bj(f'ankle.{s}'), bj(f'toe.{s}'), f'shin.{s}'),
    ]
SEG = {n: (h, t) for n, h, t, _ in BONES}
arm_data = bpy.data.armatures.new('RangerRig')
ARM = bpy.data.objects.new('ElfRangerRig', arm_data)
sc.collection.objects.link(ARM)
bpy.context.view_layer.objects.active = ARM
bpy.ops.object.mode_set(mode='EDIT')
for n, h, t, p in BONES:
    eb = arm_data.edit_bones.new(n)
    eb.head, eb.tail, eb.roll = h, t, 0
    if p:
        eb.parent = arm_data.edit_bones[p]
    eb.use_deform = n != 'root'
bpy.ops.object.mode_set(mode='OBJECT')
BQ = {b.name: b.matrix_local.to_quaternion() for b in arm_data.bones}

# ---------------------------------------------------------------- сетки: применить модификаторы, кривые -> меши
def realize(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target='MESH')
    return bpy.context.active_object

parts = [realize(o) for o in list(bpy.data.collections['ElfRanger'].objects) if o.type in ('MESH', 'CURVE')]
body = bpy.data.objects['Body']

# тело: веса «по теплу»
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True)
ARM.select_set(True)
bpy.context.view_layer.objects.active = ARM
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
if 'cape' in body.vertex_groups:
    body.vertex_groups.remove(body.vertex_groups['cape'])
print('BODY groups', len(body.vertex_groups))

def smoothstep(e0, e1, v):
    t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

def rigid(o, weights):
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    for bone, w in weights.items():
        o.vertex_groups.new(name=bone).add(list(range(len(o.data.vertices))), w, 'REPLACE')

def transfer(o):
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    m = o.modifiers.new('DT', 'DATA_TRANSFER')
    m.object = body
    m.use_vert_data = True
    m.data_types_verts = {'VGROUP_WEIGHTS'}
    m.vert_mapping = 'POLYINTERP_NEAREST'
    m.layers_vgroup_select_src = 'ALL'
    m.layers_vgroup_select_dst = 'NAME'
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.datalayout_transfer(modifier='DT')
    bpy.ops.object.modifier_apply(modifier='DT')

HEAD_PARTS = ('Head', 'Nose', 'Eye', 'Iris', 'Lash', 'Brow', 'Ear', 'Lips', 'HairCap', 'SideBraid', 'Braid')
for o in parts:
    if o is body:
        continue
    n = o.name
    if n.startswith(HEAD_PARTS):
        rigid(o, {'head': 1.0})
    elif n.startswith(('Palm', 'Finger', 'Thumb')):
        rigid(o, {'hand.' + n[-1]: 1.0})
    elif n.startswith(('Bow',)):
        rigid(o, {'hand.L': 1.0})
    elif n.startswith(('Quiver', 'QArrow', 'QFeather', 'Yoke', 'Clasp', 'Hood')):
        rigid(o, {'spine': 1.0})
    elif n.startswith('Pauldron'):
        k = int(n[len('Pauldron')])
        s = n[-1]
        rigid(o, {'upper_arm.' + s: 0.7 + 0.15 * k, 'spine': 0.3 - 0.15 * k})
    elif n == 'Cloak':
        for g in list(o.vertex_groups):
            o.vertex_groups.remove(g)
        gc, gs = o.vertex_groups.new(name='cape'), o.vertex_groups.new(name='spine')
        for v in o.data.vertices:
            w = smoothstep(1.38, 0.95, v.co.z)
            gc.add([v.index], w, 'REPLACE')
            gs.add([v.index], 1 - w, 'REPLACE')
    else:
        transfer(o)
    print('weights', n, len(o.vertex_groups))

# одна сетка
bpy.ops.object.select_all(action='DESELECT')
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body = bpy.context.active_object
body.name = 'ElfRangerMesh'
for m in list(body.modifiers):
    body.modifiers.remove(m)
body.parent = ARM
dec = body.modifiers.new('Dec', 'DECIMATE')
dec.ratio = min(1.0, 22000 / len(body.data.polygons))
bpy.context.view_layer.objects.active = body
bpy.ops.object.modifier_apply(modifier='Dec')
mod = body.modifiers.new('Armature', 'ARMATURE')
mod.object = ARM
print('MESH', len(body.data.vertices), 'verts', len(body.data.polygons), 'faces', len(body.data.materials), 'materials')

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


# ---------------------------------------------------------------- анимации из Quaternius UAL
existing = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=UAL)
ual_objs = [o for o in bpy.data.objects if o not in existing]
ual_names = [o.name for o in ual_objs]
UARM = next(o for o in ual_objs if o.type == 'ARMATURE')
for o in ual_objs:
    if o.type == 'MESH':
        bpy.data.objects.remove(o)
for t in UARM.animation_data.nla_tracks:
    t.mute = True
UAL_FPS = 24
sc.render.fps = 30
mod.show_viewport = False            # пока печём анимации, сетку не деформируем (быстрее)

def uw(name):
    """Мировые голова, хвост и поворот (дельта от покоя) кости UAL в текущем кадре."""
    pb = UARM.pose.bones[name]
    M = UARM.matrix_world @ pb.matrix
    rest = (UARM.matrix_world @ pb.bone.matrix_local).to_quaternion()
    return M.to_translation(), UARM.matrix_world @ pb.tail, M.to_quaternion() @ rest.inverted()

HIPS_REST = UARM.matrix_world @ UARM.data.bones['DEF-hips'].head_local
RATIO = 0.95 / HIPS_REST.z

def sample(action_name):
    act = bpy.data.actions[action_name]
    UARM.animation_data.action = act
    if hasattr(UARM.animation_data, 'action_slot') and act.slots:
        UARM.animation_data.action_slot = act.slots[0]
    s, e = act.frame_range
    n = max(1, round((e - s) / UAL_FPS * 30))
    frames = []
    for i in range(n + 1):
        uf = s + i / 30 * UAL_FPS
        sc.frame_set(int(uf), subframe=uf - int(uf))
        d = {}
        for b in ('DEF-hips', 'DEF-spine.003', 'DEF-head'):
            d[b] = uw(b)
        for s_ in 'LR':
            for b in ('upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe'):
                d[f'{b}.{s_}'] = uw(f'DEF-{b}.{s_}')
        frames.append(d)
    return frames

REST_DIR = {n: (SEG[n][1] - SEG[n][0]).normalized() for n in SEG}
L_OFF = Quaternion((0, 1, 0), -0.26) @ Quaternion((1, 0, 0), -0.08)   # левая рука с луком чуть в сторону и вперёд

def aim(bone, target_dir):
    upd()
    Pq = world_q(PARENT_OF[bone])
    r = Pq @ REST_DIR[bone]
    T = r.rotation_difference(target_dir.normalized()) @ Pq
    setq(bone, Pq.inverted() @ T)

PARENT_OF = {n: p for n, _, _, p in BONES}

def apply(d, extra_hips=None, extra_spine=None, extra_head=None, arms=True, bow_out=True):
    reset()
    hp, _, hq = d['DEF-hips']
    move('hips', (hp - HIPS_REST) * RATIO)
    setq('hips', (extra_hips or Quaternion()) @ hq)
    upd()
    cq = d['DEF-spine.003'][2]
    setq('spine', world_q('hips').inverted() @ (extra_spine or Quaternion()) @ cq)
    upd()
    setq('head', world_q('spine').inverted() @ (extra_head or Quaternion()) @ d['DEF-head'][2])
    for s in 'LR':
        chain = [('thigh', 'shin'), ('shin', 'foot'), ('foot', 'toe')]
        if arms:
            chain = [('upper_arm', 'forearm'), ('forearm', 'hand'), ('hand', None)] + chain
        for b, nxt in chain:
            h, t, _ = d[f'{b}.{s}']
            tgt = (d[f'{nxt}.{s}'][0] if nxt else t) - h
            if s == 'L' and bow_out and b in ('upper_arm', 'forearm', 'hand'):
                tgt = L_OFF @ tgt
            aim(f'{b}.{s}', tgt)
    if arms and bow_out:
        orient_hand('L', Quaternion())     # лук вертикально

def cape_sway(t, base, amp, speed=1.0):
    rot('cape', base + amp * math.sin(t * 2 * math.pi * speed - 1.0), 0, 0.04 * math.sin(t * math.pi * speed))

LW_TARGET = V((0.06, -0.5, 1.42))
CHIN = V((-0.03, -0.17, 1.55))
QUIVER = V((-0.12, 0.2, 1.62))

def shoot_arms(f):
    rec = smooth((f - 21) / 2) * (1 - smooth((f - 23) / 8)) if f >= 21 else 0.0
    ik_arm('L', LW_TARGET + V((0, 0.03 * rec, 0.02 * rec)), (1, 0.4, -0.5))
    orient_hand('L', Quaternion())
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
    return rec

ARM.animation_data_create()
CLIPS = [
    ('Idle', 'Idle_Loop', 0.03, 0.02),
    ('Walk', 'Walk_Loop', 0.12, 0.04),
    ('Run', 'Jog_Fwd_Loop', 0.22, 0.06),
    ('Hit', 'Hit_Chest', 0.06, 0.04),
    ('Death', 'Death01', 0.05, 0.0),
]
actions = []
cache = {}
for name, src_name, *_ in CLIPS:
    cache[src_name] = sample(src_name)
idle_frames = cache['Idle_Loop']

for name, src_name, cb, ca in CLIPS:
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ARM.animation_data.action = act
    frames = cache[src_name]
    n = len(frames) - 1
    for i, d in enumerate(frames):
        apply(d, bow_out=(name != 'Death'))
        if name == 'Death':
            k = smooth(i / max(1, n * 0.6))
            rot('cape', 0.05 + 0.15 * k)
        else:
            cape_sway(i / max(1, n), cb, ca, 2 if name in ('Walk', 'Run') else 1)
        key_all(i)
    actions.append(act)
    print('CLIP', name, 'frames', len(frames))

# стрельба: тело и ноги из Idle_Loop, разворот корпуса и руки лучника
act = bpy.data.actions.new('Shoot')
act.use_fake_user = True
ARM.animation_data.action = act
for f in range(37):
    rec = smooth((f - 21) / 2) * (1 - smooth((f - 23) / 8)) if f >= 21 else 0.0
    d = idle_frames[f % len(idle_frames)]
    apply(d, extra_hips=Quaternion((0, 0, 1), 0.28),
          extra_spine=Quaternion((1, 0, 0), 0.07 * rec) @ Quaternion((0, 0, 1), -0.12),
          extra_head=Quaternion((0, 0, 1), 0.2), arms=False, bow_out=False)
    shoot_arms(f)
    rot('cape', 0.05 + 0.1 * rec, 0, 0.03 * math.sin(f / 36 * 2 * math.pi))
    key_all(f)
actions.append(act)
print('CLIP Shoot frames 37')

# убрать библиотеку UAL из файла
for nm in ual_names:
    if nm in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects[nm])
for a in [a for a in bpy.data.actions if a not in actions]:
    bpy.data.actions.remove(a)
mod.show_viewport = True


if RENDER:
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 40
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.render.resolution_x, sc.render.resolution_y = 380, 460
    lookup = {a.name: a for a in actions}
    shots = [('Idle', 10), ('Walk', 8), ('Run', 6), ('Shoot', 16), ('Shoot', 27), ('Hit', 8), ('Death', 999), ('Walk', 20)]
    for i, (nm, fr) in enumerate(shots):
        a = lookup[nm]
        fr = min(fr, int(a.frame_range[1]))
        cam.location = (2.6, -3.4, 1.7)
        cam.rotation_euler = (V((0, 0, 0.95)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        ARM.animation_data.action = a
        sc.frame_set(fr)
        sc.render.filepath = os.path.join(OUT, f'rr_{i}_{nm}_{fr:02d}.png')
        bpy.ops.render.render(write_still=True)

for a in actions:
    tr = ARM.animation_data.nla_tracks.new()
    tr.name = a.name
    tr.strips.new(a.name, 0, a)
ARM.animation_data.action = None
sc.frame_set(0)
reset()
path = os.path.join(OUT, 'elf_ranger.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=True, export_animation_mode='ACTIONS',
                          export_apply=True, export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'elf_ranger_rigged.blend'))
print('EXPORTED', path, os.path.getsize(path))
