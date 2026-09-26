"""
Процедурный эльф-лучник для Castle Fight.
Запуск (без окна):
  blender -b -P elf_archer.py -- <out_dir> [--render]
Результат: <out_dir>/elf_archer_blender.glb с анимациями Idle, Walk, Shoot, Death.
"""
import bpy, math, sys, os
from mathutils import Vector, Quaternion, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else '.')
RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 30

# ---------------------------------------------------------------- materials
def lin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

MATS = {}
def mat(name, hexc, rough=0.85, metal=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    col = (*lin(hexc), 1)
    b.inputs['Base Color'].default_value = col
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m.diffuse_color = col
    MATS[name] = m
    return m

SKIN = mat('Skin', '#f2cda8', 0.7)
HAIR = mat('Hair', '#efd98a', 0.6)
TUNIC = mat('Tunic', '#3f8a44')
TUNIC_DK = mat('TunicDark', '#24552b')
LEATHER = mat('Leather', '#7a4b2a')
LEATHER_DK = mat('LeatherDark', '#4a2e1c')
PANTS = mat('Pants', '#3c3a2c')
GOLD = mat('Gold', '#e0b545', 0.35, 1.0)
WOOD = mat('BowWood', '#6e4424', 0.6)
STRING = mat('String', '#efe8d0', 0.5)
SHAFT = mat('Shaft', '#d6b27a', 0.7)
STEEL = mat('Steel', '#b9c2cc', 0.3, 1.0)
FLETCH = mat('Fletch', '#c8372d', 0.8)
EYE = mat('Eye', '#1d2a3a', 0.3)

# ---------------------------------------------------------------- mesh helpers
def _finish(o, name, m, smooth=False):
    o.name = name
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(m)
    if smooth:
        bpy.ops.object.shade_smooth()
    else:
        bpy.ops.object.shade_flat()
    return o

def cone(name, p0, p1, r0, r1, m, v=8, flat=1.0, smooth=False):
    """Усечённый конус от p0 (радиус r0) до p1 (радиус r1)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bpy.ops.mesh.primitive_cone_add(vertices=v, radius1=r0, radius2=r1, depth=d.length,
                                    location=(p0 + p1) / 2)
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.scale = (1, flat, 1)
    return _finish(o, name, m, smooth)

def box(name, center, size, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    return _finish(o, name, m)

def ball(name, center, r, m, scale=(1, 1, 1), sub=2, smooth=True):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=center)
    o = bpy.context.active_object
    o.scale = scale
    return _finish(o, name, m, smooth)

def torus(name, center, R, r, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=12,
                                     minor_segments=4, location=center, rotation=rot)
    return _finish(bpy.context.active_object, name, m)

def tube(name, pts, radii, m, bevel=0.02):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = bevel
    cu.bevel_resolution = 1
    cu.use_fill_caps = True
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for p, co, r in zip(sp.points, pts, radii):
        p.co = (*co, 1)
        p.radius = r
    o = bpy.data.objects.new(name, cu)
    sc.collection.objects.link(o)
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.active_object
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

# ---------------------------------------------------------------- skeleton
V = Vector
SH_L, SH_R = V((0.21, 0, 1.37)), V((-0.21, 0, 1.37))
EL = 0.28      # плечо
FA = 0.25      # предплечье
WR_L = SH_L - V((0, 0, EL + FA))
WR_R = SH_R - V((0, 0, EL + FA))
GRIP = WR_L - V((0, 0, 0.045))                 # центр кулака левой руки
NOCK_REST = GRIP + V((-0.02, 0.05, 0.13))      # точка на тетиве (над кулаком, к лучнику)
ARROW_LEN = 0.6

BONES = [
    ('root', (0, 0, 0), None),
    ('hips', (0, 0, 0.95), 'root'),
    ('spine', (0, 0, 1.02), 'hips'),
    ('head', (0, 0, 1.45), 'spine'),
    ('upper_arm.L', SH_L, 'spine'),
    ('forearm.L', SH_L - V((0, 0, EL)), 'upper_arm.L'),
    ('hand.L', WR_L, 'forearm.L'),
    ('nock', NOCK_REST, 'hand.L'),
    ('arrow', NOCK_REST, 'nock'),
    ('upper_arm.R', SH_R, 'spine'),
    ('forearm.R', SH_R - V((0, 0, EL)), 'upper_arm.R'),
    ('hand.R', WR_R, 'forearm.R'),
    ('thigh.L', (0.1, 0, 0.9), 'hips'),
    ('shin.L', (0.1, 0, 0.5), 'thigh.L'),
    ('foot.L', (0.1, 0, 0.1), 'shin.L'),
    ('thigh.R', (-0.1, 0, 0.9), 'hips'),
    ('shin.R', (-0.1, 0, 0.5), 'thigh.R'),
    ('foot.R', (-0.1, 0, 0.1), 'shin.R'),
]

arm_data = bpy.data.armatures.new('ElfRig')
ARM = bpy.data.objects.new('ElfArcher', arm_data)
sc.collection.objects.link(ARM)
bpy.context.view_layer.objects.active = ARM
bpy.ops.object.mode_set(mode='EDIT')
for name, head, parent in BONES:
    eb = arm_data.edit_bones.new(name)
    eb.head = head
    eb.tail = V(head) + V((0, 0, 0.08))
    eb.roll = 0
    if parent:
        eb.parent = arm_data.edit_bones[parent]
        eb.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

REST = {b.name: b.head_local.copy() for b in arm_data.bones}
BQ = {b.name: b.matrix_local.to_quaternion() for b in arm_data.bones}
PARENT = {n: p for n, _, p in BONES}

def attach(o, bone):
    bpy.context.view_layer.update()
    mw = o.matrix_world.copy()
    o.parent = ARM
    o.parent_type = 'BONE'
    o.parent_bone = bone
    bpy.context.view_layer.update()
    o.matrix_world = mw

# ---------------------------------------------------------------- body
parts = []
def P(o, bone):
    parts.append((o, bone))
    return o

for s, x in (('L', 0.1), ('R', -0.1)):
    P(box(f'Boot.{s}', (x, -0.035, 0.065), (0.12, 0.22, 0.13), LEATHER_DK), f'foot.{s}')
    P(cone(f'BootShaft.{s}', (x, 0, 0.08), (x, 0, 0.34), 0.07, 0.075, LEATHER), f'shin.{s}')
    P(cone(f'BootCuff.{s}', (x, 0, 0.32), (x, 0, 0.38), 0.085, 0.09, LEATHER_DK), f'shin.{s}')
    P(cone(f'Shin.{s}', (x, 0, 0.35), (x, 0, 0.52), 0.055, 0.062, PANTS), f'shin.{s}')
    P(cone(f'Thigh.{s}', (x, 0, 0.5), (x, 0, 0.9), 0.066, 0.085, PANTS), f'thigh.{s}')

P(cone('Skirt', (0, 0, 0.7), (0, 0, 1.0), 0.23, 0.165, TUNIC, v=8, flat=0.85), 'hips')
P(cone('SkirtTrim', (0, 0, 0.68), (0, 0, 0.73), 0.235, 0.225, GOLD, v=8, flat=0.85), 'hips')
P(torus('Belt', (0, 0, 1.0), 0.165, 0.028, LEATHER, rot=(0, 0, 0)), 'hips')
bpy.context.active_object.scale = (1, 0.85, 1)
P(box('Buckle', (0, -0.15, 1.0), (0.07, 0.03, 0.06), GOLD), 'hips')

P(cone('Torso', (0, 0, 0.98), (0, 0, 1.4), 0.165, 0.2, TUNIC, v=8, flat=0.72), 'spine')
P(cone('Mantle', (0, 0, 1.3), (0, 0, 1.47), 0.27, 0.09, TUNIC_DK, v=8, flat=0.8), 'spine')
P(box('Clasp', (0, -0.17, 1.37), (0.05, 0.03, 0.05), GOLD, rot=(0, math.radians(45), 0)), 'spine')
P(cone('Cape', (0, 0.17, 1.4), (0, 0.24, 0.72), 0.19, 0.27, TUNIC_DK, v=4, flat=0.12), 'spine')
bpy.context.active_object.rotation_euler = (0, 0, math.radians(45))
P(box('Strap', (0, -0.02, 1.2), (0.05, 0.33, 0.5), LEATHER_DK, rot=(math.radians(0), math.radians(-38), 0)), 'spine')
# колчан
qa, qb = V((-0.12, 0.22, 0.98)), V((0.1, 0.25, 1.45))
P(cone('Quiver', qa, qb, 0.055, 0.065, LEATHER, v=8), 'spine')
P(cone('QuiverRim', qb - (qb - qa).normalized() * 0.03, qb, 0.072, 0.072, GOLD, v=8), 'spine')
for i, off in enumerate(((0.0, 0.0), (0.03, 0.02), (-0.025, 0.02), (0.01, -0.025))):
    tip = qb + (qb - qa).normalized() * 0.12 + V((off[0], off[1], 0))
    P(cone(f'QArrow{i}', qb - (qb - qa).normalized() * 0.05 + V((off[0], off[1], 0)), tip, 0.008, 0.008, SHAFT, v=5), 'spine')
    P(cone(f'QFletch{i}', tip - (qb - qa).normalized() * 0.07, tip, 0.028, 0.012, FLETCH, v=3), 'spine')

# голова
HC = V((0, 0, 1.63))
P(ball('Head', HC, 0.15, SKIN, scale=(0.95, 1, 1.07)), 'head')
P(ball('Hair', HC + V((0, 0.03, 0.035)), 0.158, HAIR, scale=(1, 1, 1.02)), 'head')
P(cone('HairBack', HC + V((0, 0.06, 0.04)), HC + V((0, 0.12, -0.33)), 0.15, 0.09, HAIR, v=7, flat=0.55, smooth=True), 'head')
P(box('Fringe', HC + V((0.05, -0.12, 0.1)), (0.13, 0.05, 0.06), HAIR, rot=(0.3, 0, -0.4)), 'head')
P(box('Circlet', HC + V((0, -0.138, 0.085)), (0.05, 0.015, 0.035), GOLD, rot=(0, 0.785, 0)), 'head')
P(torus('CircletBand', HC + V((0, 0.0, 0.075)), 0.152, 0.009, GOLD, rot=(0.12, 0, 0)), 'head')
for s, sx in (('L', 1), ('R', -1)):
    base = HC + V((sx * 0.13, 0.02, 0.0))
    tip = HC + V((sx * 0.3, 0.1, 0.12))
    P(cone(f'Ear.{s}', base, tip, 0.045, 0.0, SKIN, v=4, flat=0.35), 'head')
    P(ball(f'Eye.{s}', HC + V((sx * 0.052, -0.138, 0.005)), 0.022, EYE, scale=(1, 0.6, 1.25), sub=1), 'head')
    P(box(f'Brow.{s}', HC + V((sx * 0.058, -0.14, 0.052)), (0.05, 0.012, 0.012), HAIR, rot=(0, sx * 0.25, 0)), 'head')
P(cone('Nose', HC + V((0, -0.13, -0.02)), HC + V((0, -0.17, -0.04)), 0.018, 0.0, SKIN, v=4), 'head')

# руки
for s, sh, wr in (('L', SH_L, WR_L), ('R', SH_R, WR_R)):
    el = sh - V((0, 0, EL))
    P(ball(f'Pauldron.{s}', sh + V((0, 0, 0.01)), 0.08, TUNIC_DK, sub=1, smooth=False), f'upper_arm.{s}')
    P(cone(f'UpperArm.{s}', sh, el, 0.058, 0.05, TUNIC), f'upper_arm.{s}')
    P(cone(f'Bracer.{s}', el - V((0, 0, 0.03)), wr, 0.052, 0.046, LEATHER), f'forearm.{s}')
    P(ball(f'Elbow.{s}', el, 0.05, TUNIC, sub=1), f'forearm.{s}')
    P(ball(f'Hand.{s}', wr - V((0, 0, 0.045)), 0.046, SKIN, sub=1), f'hand.{s}')

# лук: лежит вдоль локальной Y руки, тетива в +Z
BOW_HALF = 0.52
BOW_REC = 0.13
bow_pts, bow_r = [], []
N = 16
for i in range(N + 1):
    t = -1 + 2 * i / N
    z = BOW_REC * t * t - 0.05 * max(0.0, abs(t) - 0.82) / 0.18
    bow_pts.append(GRIP + V((-0.02, BOW_HALF * t, z)))
    bow_r.append(1.25 - 0.75 * abs(t))
P(tube('Bow', bow_pts, bow_r, WOOD, bevel=0.02), 'hand.L')
P(cone('BowGrip', GRIP + V((-0.02, -0.07, 0)), GRIP + V((-0.02, 0.07, 0)), 0.03, 0.03, LEATHER_DK), 'hand.L')
for s in (-1, 1):
    P(ball(f'BowTip{s}', bow_pts[0 if s < 0 else -1], 0.018, GOLD, sub=1), 'hand.L')

# стрела на тетиве (скрывается масштабом кости arrow)
a0 = NOCK_REST
a1 = NOCK_REST - V((0, 0, ARROW_LEN))
P(cone('ArrowShaft', a0, a1, 0.008, 0.008, SHAFT, v=5), 'arrow')
P(cone('ArrowHead', a1 + V((0, 0, 0.01)), a1 - V((0, 0, 0.06)), 0.022, 0.0, STEEL, v=4), 'arrow')
for k in range(3):
    ang = k * 2 * math.pi / 3
    off = V((math.cos(ang) * 0.018, math.sin(ang) * 0.018, 0))
    P(box(f'Fletch{k}', a0 - V((0, 0, 0.07)) + off, (0.004, 0.03, 0.09), FLETCH, rot=(0, 0, ang)), 'arrow')

for o, bone in parts:
    attach(o, bone)

# тетива — скиннингом: концы к hand.L, середина к nock
def build_string():
    top, bot = bow_pts[-1], bow_pts[0]
    mid = NOCK_REST
    import bmesh
    bm = bmesh.new()
    rings = []
    r = 0.005
    for c in (top, mid, bot):
        ring = [bm.verts.new(c + V((r * math.cos(a), 0, r * math.sin(a)))) for a in (0, 2.094, 4.189)]
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for i in range(3):
            bm.faces.new((ra[i], ra[(i + 1) % 3], rb[(i + 1) % 3], rb[i]))
    me = bpy.data.meshes.new('BowString')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('BowString', me)
    sc.collection.objects.link(o)
    me.materials.append(STRING)
    gh = o.vertex_groups.new(name='hand.L')
    gn = o.vertex_groups.new(name='nock')
    gh.add([0, 1, 2, 6, 7, 8], 1.0, 'REPLACE')
    gn.add([3, 4, 5], 1.0, 'REPLACE')
    o.parent = ARM
    mod = o.modifiers.new('Armature', 'ARMATURE')
    mod.object = ARM
build_string()

# ---------------------------------------------------------------- posing
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
    """qw — поворот в мировых осях (относительно родителя)."""
    B = BQ[bone]
    PB[bone].rotation_quaternion = B.inverted() @ qw @ B

def rot(bone, x=0.0, y=0.0, z=0.0):
    setq(bone, Euler((x, y, z), 'XYZ').to_quaternion())

def move(bone, v):
    PB[bone].location = BQ[bone].inverted() @ V(v)

def world_q(bone):
    """Полный мировой поворот кости относительно покоя."""
    return PB[bone].matrix.to_quaternion() @ BQ[bone].inverted()

def world_pos(bone):
    return PB[bone].head.copy()

def ik_arm(side, target, pole):
    up, fo, ha = f'upper_arm.{side}', f'forearm.{side}', f'hand.{side}'
    upd()
    S = world_pos(up)
    qp = world_q('spine')
    a, b = EL, FA
    d = V(target) - S
    dist = min(d.length, a + b - 1e-3)
    u = d.normalized()
    x = (a * a - b * b + dist * dist) / (2 * dist)
    h = math.sqrt(max(a * a - x * x, 0))
    pole = V(pole)
    v = (pole - pole.dot(u) * u).normalized()
    E = S + u * x + v * h
    W = S + u * dist
    down = V((0, 0, -1))
    q_up_total = down.rotation_difference((E - S).normalized())
    setq(up, qp.inverted() @ q_up_total)
    q_fo_rel = down.rotation_difference(q_up_total.inverted() @ (W - E).normalized())
    setq(fo, q_fo_rel)
    upd()

def orient_hand(side, up, fwd, roll=0.0):
    """Мировая ориентация кисти: локальная +Y -> up, локальная -Z -> fwd."""
    upd()
    fwd = V(fwd).normalized()
    upv = (V(up) - V(up).dot(fwd) * fwd).normalized()
    zc = -fwd
    xc = upv.cross(zc)
    R = Matrix((xc, upv, zc)).transposed().to_quaternion()
    if roll:
        R = Quaternion(fwd, roll) @ R
    qp = world_q(f'forearm.{side}')
    setq(f'hand.{side}', qp.inverted() @ R)
    upd()

def draw_string(amount):
    move('nock', (0, 0, amount))

def show_arrow(k):
    PB['arrow'].scale = (max(k, 1e-4),) * 3

def key_all(frame):
    for pb in PB:
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        pb.keyframe_insert('location', frame=frame)
        pb.keyframe_insert('scale', frame=frame)

def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * t

# позы -----------------------------------------------------------
def pose_idle(f, n=60):
    reset()
    p = 2 * math.pi * f / n
    br = math.sin(p)
    move('hips', (0, 0, -0.006 * (1 - math.cos(p))))
    rot('spine', 0.025 * br)
    rot('head', -0.03 * br, 0, 0.05 * math.sin(p * 0.5))
    rot('thigh.L', 0, -0.05); rot('thigh.R', 0, 0.05)
    rot('foot.L', 0, 0.05); rot('foot.R', 0, -0.05)
    rot('upper_arm.R', 0.05 * br, 0.12)
    rot('forearm.R', -0.2 - 0.04 * br)
    rot('upper_arm.L', -0.25, -0.18 - 0.02 * br)
    rot('forearm.L', -0.95)
    orient_hand('L', (0.05, -0.15, 1), (0.35, -1, 0))
    show_arrow(0)

def pose_walk(f, n=30):
    reset()
    p = 2 * math.pi * f / n
    s = math.sin(p)
    move('hips', (0, 0, 0.035 * math.cos(2 * p) - 0.02))
    rot('hips', 0, 0, 0.1 * s)
    rot('spine', 0.08, 0, -0.16 * s)
    rot('head', -0.04, 0, 0.06 * s)
    for side, sg in (('L', 1), ('R', -1)):
        ph = p if sg > 0 else p + math.pi
        th = -0.55 * math.sin(ph)
        sh = 0.15 + 0.75 * max(0.0, math.sin(ph - 1.9)) ** 1.2
        rot(f'thigh.{side}', th)
        rot(f'shin.{side}', sh)
        rot(f'foot.{side}', -0.6 * (th + sh) + 0.2 * max(0.0, -math.sin(ph)))
    rot('upper_arm.R', 0.5 * s, 0.1)
    rot('forearm.R', -0.35 - 0.3 * max(0.0, -s))
    rot('upper_arm.L', -0.25 - 0.15 * s, -0.18)
    rot('forearm.L', -1.0)
    orient_hand('L', (0.05, -0.3, 1), (0.35, -1, 0))
    show_arrow(0)

LW_TARGET = V((0.0, -0.47, 1.41))
MAX_DRAW = 0.2

def shoot_base(twist=-0.22):
    rot('hips', 0, 0, 0.12)
    rot('spine', 0.03, 0, twist)
    rot('head', -0.02, 0, -twist - 0.12)
    rot('thigh.L', -0.12, -0.12); rot('shin.L', 0.15); rot('foot.L', 0, 0.12)
    rot('thigh.R', 0.2, 0.1); rot('shin.R', 0.12); rot('foot.R', -0.3, -0.1)
    move('hips', (0, 0, -0.025))
    ik_arm('L', LW_TARGET, (1, 0.2, -0.6))
    orient_hand('L', (0, 0, 1), (0, -1, 0))

def nock_world():
    upd()
    return world_pos('nock')

QUIVER_REACH = V((0.02, 0.2, 1.62))

def pose_shoot(f):
    """36 кадров: натяжение 0-14, удержание, выстрел на 21, возврат за стрелой."""
    reset()
    shoot_base()
    if f <= 14:
        dr = smooth(f / 14) * MAX_DRAW
        arrow = 1
    elif f <= 20:
        dr = MAX_DRAW + 0.004 * math.sin(f * 2.3)
        arrow = 1
    else:
        dr = 0
        arrow = 0 if f < 33 else smooth((f - 32) / 3)
    draw_string(dr)
    show_arrow(arrow)
    n = nock_world()
    if f <= 20:
        tgt = n + V((-0.035, 0.03, -0.01))
    else:
        full = n + V((-0.035, 0.03 + 0.2 + 0.04, -0.01))  # позиция натянутой тетивы
        follow = full + V((-0.12, 0.08, 0.02))
        if f <= 25:
            tgt = full.lerp(follow, smooth((f - 20) / 4))
        elif f <= 30:
            tgt = follow.lerp(QUIVER_REACH, smooth((f - 25) / 5))
        else:
            tgt = QUIVER_REACH.lerp(n + V((-0.035, 0.03, -0.01)), smooth((f - 30) / 6))
    ik_arm('R', tgt, (-1, 0.5, 0.05))
    orient_hand('R', (0, -0.3, 1), (0.4, -0.3, -1) if f <= 20 else (0, -1, -0.3))

def pose_death(f):
    reset()
    t1 = smooth(f / 9)
    t2 = smooth((f - 7) / 15)
    t3 = smooth((f - 22) / 5) * (1 - smooth((f - 27) / 5))
    move('hips', (0, lerp(0, 0.32, t2), lerp(-0.12 * t1, -0.8, t2) + 0.03 * t3))
    rot('hips', lerp(0, -1.5, t2), 0, 0.2 * t2)
    rot('spine', lerp(0.35 * t1, 0.05, t2))
    rot('head', lerp(0.3 * t1, -0.25, t2), 0, 0.5 * t2)
    for side, sg in (('L', 1), ('R', -1)):
        rot(f'thigh.{side}', lerp(-0.55 * t1, -0.1, t2), -sg * 0.18 * t2)
        rot(f'shin.{side}', lerp(0.9 * t1, 0.35 if sg > 0 else 0.15, t2))
        rot(f'foot.{side}', lerp(-0.3 * t1, 0.4, t2))
        rot(f'upper_arm.{side}', lerp(-0.6 * t1, -0.3, t2), -sg * lerp(0.3 * t1, 1.35, t2))
        rot(f'forearm.{side}', lerp(-0.4 * t1, -0.2, t2))
    show_arrow(0)

# ---------------------------------------------------------------- actions
ARM.animation_data_create()
CLIPS = [
    ('Idle', 60, pose_idle, 2),
    ('Walk', 30, pose_walk, 1),
    ('Shoot', 36, pose_shoot, 1),
    ('Death', 40, pose_death, 1),
]
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
    actions.append((act, n))

if RENDER:
    cam_data = bpy.data.cameras.new('Cam')
    cam = bpy.data.objects.new('Cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = (1.9, -3.0, 1.55)
    cam.rotation_euler = (V((0, 0, 0.9)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = 45
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.display.shading.show_shadows = True
    sc.render.resolution_x, sc.render.resolution_y = 360, 420
    sc.render.film_transparent = False
    shots = [('Idle', 0), ('Walk', 0), ('Walk', 8), ('Shoot', 0), ('Shoot', 16), ('Shoot', 27), ('Death', 10), ('Death', 40)]
    lookup = {a.name: a for a, _ in actions}
    for nm, fr in shots:
        ARM.animation_data.action = lookup[nm]
        sc.frame_set(fr)
        sc.render.filepath = os.path.join(OUT, f'preview_{nm}_{fr:02d}.png')
        bpy.ops.render.render(write_still=True)
    cam.location = (-0.9, -2.6, 1.7)
    cam.rotation_euler = (V((0, 0, 1.2)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    ARM.animation_data.action = lookup['Shoot']
    sc.frame_set(16)
    sc.render.filepath = os.path.join(OUT, 'preview_Shoot_front.png')
    bpy.ops.render.render(write_still=True)

# NLA-дорожки, чтобы экспортер увидел все клипы
for act, n in actions:
    tr = ARM.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, 0, act)
ARM.animation_data.action = None
sc.frame_set(0)
reset()

sc.frame_start, sc.frame_end = 0, 60
path = os.path.join(OUT, 'elf_archer_blender.glb')
bpy.ops.export_scene.gltf(
    filepath=path,
    export_format='GLB',
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_apply=True,
    export_yup=True,
)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'elf_archer.blend'))
print('EXPORTED', path, os.path.getsize(path))
