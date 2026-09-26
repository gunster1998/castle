"""
Эльф-лучник v2 для Castle Fight: оригинальная модель в духе RTS начала 2000-х.
Отличия от v1:
  * одна skinned-сетка (1 объект, 3 материала) вместо 60+ отдельных деталей;
  * «рисованная» раскраска через цвета вершин (градиенты, блики, разброс тона);
  * материал TeamColor — игра красит его в цвет команды;
  * крупные RTS-пропорции: листовые наплечники, большие перчатки и сапоги,
    светящиеся глаза, длинные уши, плащ с рваным краем;
  * вторичная анимация: кости плаща и волос качаются с запаздыванием;
  * стойка лучника боком, полное натяжение, отдача при выстреле.

Запуск:  blender -b -P elf_archer_v2.py -- <out_dir> [--render]
"""
import bpy, bmesh, math, sys, os, random
from mathutils import Vector, Quaternion, Matrix, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else '.')
RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 30
V = Vector

# ---------------------------------------------------------------- materials
def lin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

def vc_material(name, rough=0.85, emission=None, double=False):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    if emission:
        b.inputs['Emission Color'].default_value = (*lin(emission), 1)
        b.inputs['Emission Strength'].default_value = 2.0
    m.use_backface_culling = not double
    return m

BODY = vc_material('Body', double=True)
TEAM = vc_material('TeamColor', double=True)
GLOW = vc_material('Glow', rough=0.4, emission='#9ff5d8')

# ---------------------------------------------------------------- palette
C = dict(
    skin='#f3cfa6', hair='#f2d680', tunic='#2f7d3c', tunic_dk='#1d4f2a', leaf='#3f9a48',
    leather='#8d5731', leather_dk='#4a2b17', pants='#34402c', gold='#e8b83f', wood='#6b3f1f',
    string='#f1ead2', shaft='#d9b57c', steel='#c9d2da', fletch='#d43b2e', eye='#bfffe9',
    brow='#c9b27a', team='#e9e9e9', lip='#c98b76',
)

# ---------------------------------------------------------------- part helpers
PARTS = []   # (obj, bone, material)
rng = random.Random(42)

def _finish(o, name, smooth=False):
    o.name = name
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if smooth:
        bpy.ops.object.shade_smooth()
    else:
        bpy.ops.object.shade_flat()
    return o

def paint(o, hexc, dark=0.6, light=1.15, jitter=0.07, top=0.12):
    """Рисованная раскраска: снизу темнее, сверху светлее, у граней лёгкий разброс."""
    me = o.data
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    base = lin(hexc)
    mw = o.matrix_world
    zs = [(mw @ v.co).z for v in me.vertices]
    zmin, zmax = min(zs), max(zs)
    span = max(zmax - zmin, 1e-4)
    for poly in me.polygons:
        j = 1 + rng.uniform(-jitter, jitter)
        f = 1 + top * max(0.0, poly.normal.z) - 0.08 * max(0.0, -poly.normal.z)
        for li in poly.loop_indices:
            t = (zs[me.loops[li].vertex_index] - zmin) / span
            s = (dark + (light - dark) * t) * j * f
            attr.data[li].color = (base[0] * s, base[1] * s, base[2] * s, 1)

def add(o, bone, color, mat=None, **pk):
    paint(o, color, **pk)
    o.data.materials.clear()
    o.data.materials.append(mat or BODY)
    PARTS.append((o, bone))
    return o

def cone(name, p0, p1, r0, r1, v=8, flat=1.0, smooth=False, twist=0.0):
    p0, p1 = V(p0), V(p1)
    d = p1 - p0
    bpy.ops.mesh.primitive_cone_add(vertices=v, radius1=r0, radius2=r1, depth=d.length,
                                    location=(p0 + p1) / 2, rotation=(0, 0, twist))
    o = bpy.context.active_object
    o.scale = (1, flat, 1)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = V((0, 0, 1)).rotation_difference(d.normalized())
    return _finish(o, name, smooth)

def box(name, center, size, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    return _finish(o, name)

def ball(name, center, r, scale=(1, 1, 1), sub=2, smooth=True, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=center, rotation=rot)
    o = bpy.context.active_object
    o.scale = scale
    return _finish(o, name, smooth)

def torus(name, center, R, r, rot=(0, 0, 0), seg=14, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=seg,
                                     minor_segments=4, location=center, rotation=rot)
    o = bpy.context.active_object
    o.scale = scale
    return _finish(o, name)

def tube(name, pts, radii, bevel=0.02):
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
    bpy.ops.object.shade_smooth()
    return o

def leaf(name, base, tip, width, thick=0.02, bend=V((0, 0, 0)), segs=4):
    """Лист/лезвие: ромб с изгибом от base к tip, ширина по нормали к направлению."""
    base, tip = V(base), V(tip)
    d = tip - base
    side = d.cross(V((0, 0, 1)))
    if side.length < 1e-4:
        side = V((1, 0, 0))
    side.normalize()
    nrm = side.cross(d).normalized()
    bm = bmesh.new()
    rows = []
    for i in range(segs + 1):
        t = i / segs
        c = base + d * t + bend * math.sin(math.pi * t)
        w = width * math.sin(math.pi * min(1.0, t * 1.15)) if i < segs else 0.0
        rows.append([bm.verts.new(c - side * w), bm.verts.new(c + nrm * thick), bm.verts.new(c + side * w),
                     bm.verts.new(c - nrm * thick)])
    for a, b in zip(rows, rows[1:]):
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(list(reversed(rows[0])))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    sc.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    me.update()
    return o

# ---------------------------------------------------------------- skeleton
SH_L, SH_R = V((0.25, 0, 1.42)), V((-0.25, 0, 1.42))
EL, FA = 0.30, 0.27
WR_L = SH_L - V((0, 0, EL + FA))
WR_R = SH_R - V((0, 0, EL + FA))
GRIP = WR_L - V((0, 0, 0.055))
NOCK_REST = GRIP + V((-0.025, 0.06, 0.15))
ARROW_LEN = 0.78
HC = V((0, 0, 1.7))

BONES = [
    ('root', (0, 0, 0), None),
    ('hips', (0, 0, 0.98), 'root'),
    ('spine', (0, 0, 1.06), 'hips'),
    ('head', (0, 0, 1.52), 'spine'),
    ('hair', HC + V((0, 0.12, 0.02)), 'head'),
    ('cape', (0, 0.17, 1.46), 'spine'),
    ('upper_arm.L', SH_L, 'spine'),
    ('forearm.L', SH_L - V((0, 0, EL)), 'upper_arm.L'),
    ('hand.L', WR_L, 'forearm.L'),
    ('nock', NOCK_REST, 'hand.L'),
    ('arrow', NOCK_REST, 'nock'),
    ('upper_arm.R', SH_R, 'spine'),
    ('forearm.R', SH_R - V((0, 0, EL)), 'upper_arm.R'),
    ('hand.R', WR_R, 'forearm.R'),
    ('thigh.L', (0.115, 0, 0.93), 'hips'),
    ('shin.L', (0.115, 0, 0.52), 'thigh.L'),
    ('foot.L', (0.115, 0, 0.11), 'shin.L'),
    ('thigh.R', (-0.115, 0, 0.93), 'hips'),
    ('shin.R', (-0.115, 0, 0.52), 'thigh.R'),
    ('foot.R', (-0.115, 0, 0.11), 'shin.R'),
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
BQ = {b.name: b.matrix_local.to_quaternion() for b in arm_data.bones}

# ---------------------------------------------------------------- model
# ноги и сапоги
for s, x in (('L', 0.115), ('R', -0.115)):
    sx = 1 if s == 'L' else -1
    add(box(f'Boot.{s}', (x, -0.04, 0.075), (0.15, 0.25, 0.15)), f'foot.{s}', C['leather_dk'])
    add(cone(f'Toe.{s}', (x, -0.16, 0.06), (x, -0.3, 0.13), 0.07, 0.0, v=6, flat=0.7), f'foot.{s}', C['leather_dk'])
    add(box(f'Sole.{s}', (x, -0.05, 0.015), (0.16, 0.27, 0.03)), f'foot.{s}', '#2b1a0f', dark=0.9, light=1.0)
    add(cone(f'BootShaft.{s}', (x, 0, 0.1), (x, 0, 0.36), 0.075, 0.085, v=8), f'shin.{s}', C['leather'])
    # листовой отворот сапога
    for k in range(5):
        a = k / 5 * 2 * math.pi + 0.3
        b0 = V((x + math.cos(a) * 0.08, math.sin(a) * 0.08, 0.34))
        add(leaf(f'Cuff{k}.{s}', b0, b0 + V((math.cos(a) * 0.05, math.sin(a) * 0.05, 0.1)), 0.035, 0.008),
            f'shin.{s}', C['leaf'])
    add(cone(f'Shin.{s}', (x, 0, 0.34), (x, 0, 0.54), 0.058, 0.066), f'shin.{s}', C['pants'])
    add(ball(f'Knee.{s}', (x, -0.05, 0.53), 0.06, scale=(1, 0.7, 1.1), sub=1, smooth=False), f'shin.{s}', C['leather'])
    add(cone(f'Thigh.{s}', (x, 0, 0.52), (x, 0, 0.93), 0.07, 0.092), f'thigh.{s}', C['pants'])

# таз: пояс, табард командного цвета
add(cone('Hips', (0, 0, 0.84), (0, 0, 1.04), 0.2, 0.18, v=10, flat=0.8), 'hips', C['tunic_dk'])
add(torus('Belt', (0, 0, 1.0), 0.19, 0.035, scale=(1, 0.8, 1)), 'hips', C['leather'])
add(ball('Buckle', (0, -0.165, 1.0), 0.05, scale=(1, 0.4, 0.8), sub=1, smooth=False), 'hips', C['gold'], dark=0.8, light=1.3)
add(box('PouchL', (0.19, -0.07, 0.94), (0.07, 0.06, 0.09)), 'hips', C['leather'])
add(box('PouchR', (-0.2, 0.02, 0.94), (0.06, 0.07, 0.08)), 'hips', C['leather'])
add(cone('TabardF', (0, -0.14, 1.0), (0, -0.2, 0.62), 0.14, 0.11, v=4, flat=0.12, twist=math.pi / 4), 'hips', C['team'], TEAM)
add(cone('TabardB', (0, 0.14, 1.0), (0, 0.2, 0.64), 0.14, 0.11, v=4, flat=0.12, twist=math.pi / 4), 'hips', C['team'], TEAM)
add(cone('TabardTrimF', (0, -0.2, 0.66), (0, -0.205, 0.6), 0.115, 0.1, v=4, flat=0.14, twist=math.pi / 4), 'hips', C['gold'])
for s in (1, -1):
    add(cone(f'Skirt{s}', (s * 0.15, 0, 1.0), (s * 0.22, 0, 0.7), 0.1, 0.13, v=5, flat=0.6), 'hips', C['tunic'])

# торс
add(cone('Torso', (0, 0, 1.02), (0, 0, 1.46), 0.18, 0.25, v=10, flat=0.7), 'spine', C['tunic'])
add(cone('Chest', (0, -0.1, 1.18), (0, -0.12, 1.44), 0.12, 0.17, v=6, flat=0.5), 'spine', C['leather'])
add(ball('Crescent', (0, -0.2, 1.33), 0.045, scale=(1, 0.35, 1), sub=1, smooth=False), 'spine', C['gold'], dark=0.8, light=1.3)
add(cone('Collar', (0, 0, 1.4), (0, 0, 1.54), 0.2, 0.1, v=10, flat=0.85), 'spine', C['tunic_dk'])
add(box('Strap', (0.02, -0.03, 1.24), (0.06, 0.37, 0.56), rot=(0, math.radians(-36), 0)), 'spine', C['leather_dk'])

# наплечники: округлая основа и три листа
for s, sh in (('L', SH_L), ('R', SH_R)):
    sx = 1 if s == 'L' else -1
    add(ball(f'Pauldron.{s}', sh + V((sx * 0.03, 0, 0.04)), 0.12, scale=(1.05, 1.1, 0.75), sub=2), f'upper_arm.{s}', C['leaf'])
    for k, (ang, ln) in enumerate(((-0.6, 0.22), (0.0, 0.27), (0.6, 0.22))):
        b0 = sh + V((sx * 0.08, math.sin(ang) * 0.07, 0.06))
        tip = b0 + V((sx * ln * 0.75, math.sin(ang) * ln * 0.5, ln * 0.55))
        add(leaf(f'PLeaf{k}.{s}', b0, tip, 0.06, 0.012, bend=V((0, 0, 0.03))), f'upper_arm.{s}', C['leaf'], dark=0.75, light=1.3)
    add(torus(f'PRim.{s}', sh + V((sx * 0.03, 0, -0.03)), 0.1, 0.014, scale=(1.05, 1.1, 1)), f'upper_arm.{s}', C['gold'])

# руки: рукав, наруч, большая перчатка
for s, sh, wr in (('L', SH_L, WR_L), ('R', SH_R, WR_R)):
    el = sh - V((0, 0, EL))
    add(cone(f'UpperArm.{s}', sh, el, 0.066, 0.058), f'upper_arm.{s}', C['tunic'])
    add(ball(f'Elbow.{s}', el, 0.058, sub=1), f'forearm.{s}', C['tunic'])
    add(cone(f'Bracer.{s}', el - V((0, 0, 0.04)), wr + V((0, 0, 0.02)), 0.056, 0.074, v=8), f'forearm.{s}', C['leather'])
    add(torus(f'BracerRim.{s}', wr + V((0, 0, 0.03)), 0.074, 0.012), f'forearm.{s}', C['gold'])
    add(ball(f'Glove.{s}', wr - V((0, 0, 0.055)), 0.064, scale=(0.9, 1, 1.1), sub=1, smooth=False), f'hand.{s}', C['leather_dk'])

# голова
head = ball('Head', HC, 0.16, scale=(0.92, 1.0, 1.08), sub=3)
for v in head.data.vertices:            # острый подбородок и скулы (координаты локальные, центр в 0)
    z = v.co.z
    if z < 0:
        k = 1 + 0.5 * z / 0.175
        v.co.x *= k
        v.co.y *= 0.85 + 0.15 * k
add(head, 'head', C['skin'], dark=1.0, light=1.12, jitter=0.0)
add(cone('Nose', HC + V((0, -0.14, 0.0)), HC + V((0, -0.19, -0.035)), 0.022, 0.0, v=4), 'head', C['skin'], dark=0.9)
for s, sx in (('L', 1), ('R', -1)):
    base = HC + V((sx * 0.13, 0.02, 0.01))
    tip = HC + V((sx * 0.35, 0.1, 0.1))
    add(leaf(f'Ear.{s}', base, tip, 0.085, 0.02, bend=V((0, 0, 0.03))), 'head', C['skin'], dark=0.95, light=1.15, jitter=0.0)
    add(ball(f'Eye.{s}', HC + V((sx * 0.055, -0.14, 0.01)), 0.024, scale=(1.3, 0.5, 0.75), sub=1), 'head', C['eye'], GLOW, dark=1, light=1)
    add(box(f'Brow.{s}', HC + V((sx * 0.06, -0.145, 0.055)), (0.07, 0.015, 0.018), rot=(0, sx * 0.35, 0)), 'head', C['brow'])
add(box('Mouth', HC + V((0, -0.135, -0.075)), (0.04, 0.01, 0.008)), 'head', C['lip'], dark=1, light=1)
# волосы: шапка, пряди назад, чёлка, обруч
add(ball('HairCap', HC + V((0, 0.03, 0.045)), 0.168, scale=(1, 1.02, 1), sub=2), 'head', C['hair'], dark=0.8, light=1.2)
for k, sx in enumerate((-0.09, -0.03, 0.03, 0.09)):
    add(leaf(f'Fringe{k}', HC + V((sx, -0.12, 0.14)), HC + V((sx * 1.6, -0.17, 0.05)), 0.04, 0.012), 'head', C['hair'], dark=0.85, light=1.2)
for k, (sx, ln) in enumerate(((-0.1, 0.45), (-0.035, 0.52), (0.035, 0.52), (0.1, 0.45))):
    b0 = HC + V((sx, 0.12, 0.06))
    add(leaf(f'Strand{k}', b0, b0 + V((sx * 0.6, 0.1, -ln)), 0.055, 0.02, bend=V((0, 0.05, 0))), 'hair', C['hair'], dark=0.7, light=1.2)
add(torus('Circlet', HC + V((0, 0.0, 0.08)), 0.165, 0.011, rot=(0.15, 0, 0), seg=20), 'head', C['gold'])
add(ball('Gem', HC + V((0, -0.165, 0.1)), 0.022, scale=(1, 0.5, 1.2), sub=1, smooth=False), 'head', C['eye'], GLOW, dark=1, light=1)

# плащ с рваным краем
def build_cape():
    bm = bmesh.new()
    cols, rows = 7, 6
    grid = []
    for r in range(rows + 1):
        t = r / rows
        z = 1.46 - 0.84 * t
        w = 0.2 + 0.14 * t
        row = []
        for c in range(cols + 1):
            u = c / cols * 2 - 1
            jag = (0.07 if c % 2 else 0.0) * (1 if r == rows else 0)
            y = 0.17 + 0.07 * (1 - u * u) + 0.12 * t
            row.append(bm.verts.new((u * w, y, z + jag)))
        grid.append(row)
    for a, b in zip(grid, grid[1:]):
        for c in range(cols):
            bm.faces.new((a[c], a[c + 1], b[c + 1], b[c]))
    me = bpy.data.meshes.new('Cape')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('Cape', me)
    sc.collection.objects.link(o)
    return o
add(build_cape(), 'cape', C['team'], TEAM, dark=0.55, light=1.0)

# колчан
qa, qb = V((-0.14, 0.24, 1.0)), V((0.13, 0.28, 1.52))
qd = (qb - qa).normalized()
add(cone('Quiver', qa, qb, 0.065, 0.078, v=8), 'spine', C['leather'])
add(torus('QRim1', qb - qd * 0.03, 0.08, 0.012, rot=Vector((0, 0, 1)).rotation_difference(qd).to_euler()), 'spine', C['gold'])
add(torus('QRim2', qa + qd * 0.05, 0.068, 0.01, rot=Vector((0, 0, 1)).rotation_difference(qd).to_euler()), 'spine', C['gold'])
for k, off in enumerate(((0, 0), (0.035, 0.015), (-0.03, 0.02), (0.012, -0.03), (-0.02, -0.02))):
    o = V((off[0], off[1], 0))
    tip = qb + qd * 0.16 + o
    add(cone(f'QShaft{k}', qb - qd * 0.05 + o, tip, 0.008, 0.008, v=5), 'spine', C['shaft'])
    add(leaf(f'QFletch{k}', tip - qd * 0.1, tip + qd * 0.01, 0.025, 0.004), 'spine', C['fletch'])

# эльфийский лук: изогнутые плечи, лезвия на концах, золото на рукояти
BOW_HALF, BOW_REC = 0.62, 0.15
bow_pts, bow_r = [], []
for i in range(25):
    t = -1 + 2 * i / 24
    z = BOW_REC * t * t - 0.07 * max(0.0, abs(t) - 0.78) / 0.22
    bow_pts.append(GRIP + V((-0.025, BOW_HALF * t, z)))
    bow_r.append(1.4 - 0.85 * abs(t))
add(tube('Bow', bow_pts, bow_r, bevel=0.021), 'hand.L', C['wood'], dark=0.8, light=1.25)
add(cone('BowGrip', GRIP + V((-0.025, -0.09, 0)), GRIP + V((-0.025, 0.09, 0)), 0.034, 0.034), 'hand.L', C['leather_dk'])
for s in (-1, 1):
    add(torus(f'GripRing{s}', GRIP + V((-0.025, s * 0.1, 0)), 0.034, 0.01, rot=(math.pi / 2, 0, 0)), 'hand.L', C['gold'])
    p_end = bow_pts[0 if s < 0 else -1]
    p_prev = bow_pts[2 if s < 0 else -3]
    add(leaf(f'BowBlade{s}', p_end, p_end + (p_end - p_prev).normalized() * 0.1 + V((0, 0, -0.04)), 0.028, 0.006), 'hand.L', C['gold'], dark=0.85, light=1.35)
    mid = bow_pts[6 if s < 0 else -7]
    add(leaf(f'BowLeaf{s}', mid, mid + V((0, s * 0.07, -0.07)), 0.025, 0.005), 'hand.L', C['leaf'])

# стрела на тетиве
a0, a1 = NOCK_REST, NOCK_REST - V((0, 0, ARROW_LEN))
add(cone('ArrowShaft', a0, a1, 0.009, 0.009, v=5), 'arrow', C['shaft'])
add(leaf('ArrowHead', a1 + V((0, 0, 0.02)), a1 - V((0, 0, 0.09)), 0.03, 0.008), 'arrow', C['steel'], dark=0.9, light=1.3)
for k in range(3):
    ang = k * 2 * math.pi / 3
    off = V((math.cos(ang), math.sin(ang), 0)) * 0.012
    add(leaf(f'Fletch{k}', a0 - V((0, 0, 0.02)) + off, a0 - V((0, 0, 0.13)) + off * 2.2, 0.018, 0.003), 'arrow', C['fletch'])

# тетива: концы к руке, середина к кости nock
def build_string():
    top, bot = bow_pts[-1], bow_pts[0]
    bm = bmesh.new()
    rings = []
    r = 0.0055
    for c in (top, NOCK_REST, bot):
        rings.append([bm.verts.new(c + V((r * math.cos(a), 0, r * math.sin(a)))) for a in (0, 2.094, 4.189)])
    for ra, rb in zip(rings, rings[1:]):
        for i in range(3):
            bm.faces.new((ra[i], ra[(i + 1) % 3], rb[(i + 1) % 3], rb[i]))
    me = bpy.data.meshes.new('BowString')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('BowString', me)
    sc.collection.objects.link(o)
    return o
string_obj = add(build_string(), 'hand.L', C['string'], dark=1, light=1)

# ---------------------------------------------------------------- one skinned mesh
for o, bone in PARTS:
    vg = o.vertex_groups.new(name=bone)
    vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
# середина тетивы — к кости nock
gn = string_obj.vertex_groups.new(name='nock')
string_obj.vertex_groups['hand.L'].remove([3, 4, 5])
gn.add([3, 4, 5], 1.0, 'REPLACE')

bpy.ops.object.select_all(action='DESELECT')
for o, _ in PARTS:
    o.select_set(True)
body = PARTS[0][0]
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body = bpy.context.active_object
body.name = 'ElfArcherMesh'
body.parent = ARM
mod = body.modifiers.new('Armature', 'ARMATURE')
mod.object = ARM
print('MESH', len(body.data.vertices), 'verts', len(body.data.polygons), 'faces', len(body.data.materials), 'materials')

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

def ik_arm(side, target, pole):
    up, fo = f'upper_arm.{side}', f'forearm.{side}'
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
    q_up = down.rotation_difference((E - S).normalized())
    setq(up, qp.inverted() @ q_up)
    setq(fo, down.rotation_difference(q_up.inverted() @ (W - E).normalized()))
    upd()

def orient_hand(side, up, fwd):
    upd()
    fwd = V(fwd).normalized()
    upv = (V(up) - V(up).dot(fwd) * fwd).normalized()
    zc = -fwd
    xc = upv.cross(zc)
    R = Matrix((xc, upv, zc)).transposed().to_quaternion()
    setq(f'hand.{side}', world_q(f'forearm.{side}').inverted() @ R)
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

def secondary(cape_x, hair_x, sway=0.0):
    """Плащ и волосы: наклон назад + покачивание."""
    rot('cape', cape_x, 0, sway)
    rot('hair', hair_x, 0, sway * 0.7)

def pose_idle(f, n=60):
    reset()
    p = 2 * math.pi * f / n
    br = math.sin(p)
    move('hips', (0.012 * math.sin(p * 0.5), 0, -0.008 * (1 - math.cos(p))))
    rot('hips', 0, 0.02 * math.sin(p * 0.5), 0)
    rot('spine', 0.03 * br, 0, 0.03 * math.sin(p * 0.5))
    rot('head', -0.04 * br, 0, 0.18 * math.sin(p * 0.5))
    rot('thigh.L', 0, -0.06); rot('thigh.R', 0, 0.06)
    rot('foot.L', 0, 0.06); rot('foot.R', 0, -0.06)
    rot('upper_arm.R', 0.05 * br, 0.14)
    rot('forearm.R', -0.25 - 0.05 * br)
    rot('upper_arm.L', -0.25, -0.2 - 0.02 * br)
    rot('forearm.L', -0.95)
    orient_hand('L', (0.05, -0.15, 1), (0.35, -1, 0))
    secondary(0.06 + 0.03 * math.sin(p - 0.6), 0.05 + 0.03 * math.sin(p - 0.9), 0.03 * math.sin(p * 0.5 - 0.5))
    show_arrow(0)

def pose_walk(f, n=30):
    reset()
    p = 2 * math.pi * f / n
    s = math.sin(p)
    move('hips', (0, 0, 0.04 * math.cos(2 * p) - 0.025))
    rot('hips', 0, 0, 0.12 * s)
    rot('spine', 0.1, 0.03 * math.cos(2 * p), -0.18 * s)
    rot('head', -0.06 + 0.03 * math.cos(2 * p - 0.5), 0, 0.08 * s)
    for side, sg in (('L', 1), ('R', -1)):
        ph = p if sg > 0 else p + math.pi
        th = -0.6 * math.sin(ph)
        sh = 0.15 + 0.85 * max(0.0, math.sin(ph - 1.9)) ** 1.2
        rot(f'thigh.{side}', th)
        rot(f'shin.{side}', sh)
        rot(f'foot.{side}', -0.6 * (th + sh) + 0.25 * max(0.0, -math.sin(ph)))
    rot('upper_arm.R', 0.55 * s, 0.12)
    rot('forearm.R', -0.35 - 0.35 * max(0.0, -s))
    rot('upper_arm.L', -0.25 - 0.15 * s, -0.2)
    rot('forearm.L', -1.0)
    orient_hand('L', (0.05, -0.3, 1), (0.35, -1, 0))
    secondary(0.38 + 0.1 * math.sin(2 * p - 1.2), 0.3 + 0.08 * math.sin(2 * p - 1.5), 0.08 * math.sin(p - 0.8))
    show_arrow(0)

LW_TARGET = V((0.03, -0.62, 1.45))
MAX_DRAW = 0.34
QUIVER_REACH = V((0.06, 0.24, 1.66))

def pose_shoot(f):
    """36 кадров: натяжение 0-14, удержание, выстрел на 21, отдача, рука к колчану."""
    reset()
    rec = smooth((f - 21) / 2) * (1 - smooth((f - 23) / 8)) if f >= 21 else 0.0
    lean = smooth(f / 14) * 0.05 if f <= 21 else 0.05 * (1 - smooth((f - 21) / 10))
    rot('hips', 0, 0, 0.3)
    rot('spine', 0.02 - lean + 0.08 * rec, 0, -0.42)
    rot('head', -0.04, 0, 0.36)
    rot('thigh.L', -0.2, -0.16); rot('shin.L', 0.2); rot('foot.L', 0.05, 0.16)
    rot('thigh.R', 0.25, 0.14); rot('shin.R', 0.15); rot('foot.R', -0.4, -0.14)
    move('hips', (0, 0.02 * rec, -0.035))
    ik_arm('L', LW_TARGET + V((0, 0.03 * rec, 0.02 * rec)), (1, 0.3, -0.6))
    orient_hand('L', (0, 0, 1), (0, -1, 0))
    if f <= 14:
        dr, arrow = smooth(f / 14) * MAX_DRAW, 1
    elif f <= 20:
        dr, arrow = MAX_DRAW + 0.004 * math.sin(f * 2.3), 1
    else:
        dr, arrow = 0, (0 if f < 33 else smooth((f - 32) / 3))
    draw_string(dr)
    show_arrow(arrow)
    upd()
    n = world_pos('nock')
    hold = n + V((-0.035, 0.035, -0.01))
    if f <= 20:
        tgt = hold
    else:
        full = hold + V((0, MAX_DRAW, 0))
        follow = full + V((-0.14, 0.1, 0.03))
        if f <= 25:
            tgt = full.lerp(follow, smooth((f - 20) / 4))
        elif f <= 30:
            tgt = follow.lerp(QUIVER_REACH, smooth((f - 25) / 5))
        else:
            tgt = QUIVER_REACH.lerp(hold, smooth((f - 30) / 6))
    ik_arm('R', tgt, (-1, 0.7, 0.1))
    orient_hand('R', (0, -0.3, 1), (0.4, -0.3, -1) if f <= 20 else (0, -1, -0.3))
    secondary(0.1 + 0.25 * rec, 0.08 + 0.3 * rec, 0.04 * math.sin(f / 36 * 2 * math.pi))

def pose_death(f):
    reset()
    t1 = smooth(f / 9)
    t2 = smooth((f - 7) / 15)
    t3 = smooth((f - 22) / 5) * (1 - smooth((f - 27) / 5))
    move('hips', (0, lerp(0, 0.34, t2), lerp(-0.12 * t1, -0.83, t2) + 0.03 * t3))
    rot('hips', lerp(0, -1.5, t2), 0, 0.2 * t2)
    rot('spine', lerp(0.35 * t1, 0.05, t2))
    rot('head', lerp(0.3 * t1, -0.25, t2), 0, 0.5 * t2)
    for side, sg in (('L', 1), ('R', -1)):
        rot(f'thigh.{side}', lerp(-0.55 * t1, -0.1, t2), -sg * 0.18 * t2)
        rot(f'shin.{side}', lerp(0.9 * t1, 0.35 if sg > 0 else 0.15, t2))
        rot(f'foot.{side}', lerp(-0.3 * t1, 0.4, t2))
        rot(f'upper_arm.{side}', lerp(-0.6 * t1, -0.3, t2), -sg * lerp(0.3 * t1, 1.35, t2))
        rot(f'forearm.{side}', lerp(-0.4 * t1, -0.2, t2))
    # плащ сначала взлетает, потом ложится под тело
    secondary(lerp(0.6 * t1, 1.35, t2) - 0.15 * t3, lerp(0.5 * t1, 1.2, t2), 0.1 * t2)
    show_arrow(0)

# ---------------------------------------------------------------- actions
ARM.animation_data_create()
CLIPS = [('Idle', 60, pose_idle, 2), ('Walk', 30, pose_walk, 1), ('Shoot', 36, pose_shoot, 1), ('Death', 40, pose_death, 1)]
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
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'VERTEX'
    sc.display.shading.show_shadows = True
    sc.render.resolution_x, sc.render.resolution_y = 360, 440
    lookup = {a.name: a for a, _ in actions}
    shots = [('Idle', 0, (1.9, -3.0, 1.6)), ('Walk', 8, (1.9, -3.0, 1.6)), ('Shoot', 16, (1.9, -3.0, 1.6)),
             ('Shoot', 16, (-1.2, -2.6, 1.8)), ('Shoot', 24, (1.9, -3.0, 1.6)), ('Death', 40, (1.9, -3.0, 1.6)),
             ('Idle', 0, (0.4, -1.3, 1.75)), ('Idle', 0, (-2.2, 2.4, 1.7))]
    for i, (nm, fr, pos) in enumerate(shots):
        cam.location = pos
        look = V((0, 0, 1.7 if pos[1] > -1.5 and pos[0] < 1 and pos[2] > 1.7 and nm == 'Idle' and pos[1] < 0 else 0.95))
        cam.rotation_euler = (look - cam.location).to_track_quat('-Z', 'Y').to_euler()
        cam_data.lens = 45
        ARM.animation_data.action = lookup[nm]
        sc.frame_set(fr)
        sc.render.filepath = os.path.join(OUT, f'v2_{i}_{nm}_{fr:02d}.png')
        bpy.ops.render.render(write_still=True)

for act, n in actions:
    tr = ARM.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, 0, act)
ARM.animation_data.action = None
sc.frame_set(0)
reset()

path = os.path.join(OUT, 'elf_archer_v2.glb')
bpy.ops.export_scene.gltf(
    filepath=path, export_format='GLB', export_animations=True,
    export_animation_mode='ACTIONS', export_apply=True, export_yup=True, export_texcoords=False,
)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'elf_archer_v2.blend'))
print('EXPORTED', path, os.path.getsize(path))
