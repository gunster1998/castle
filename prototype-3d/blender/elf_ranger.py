"""
Эльфийка-следопыт по референсу prototype-3d/ref/sheet.jpg — модель с нуля в Blender.
Выполняется по стадиям в живом Blender через MCP:
    STAGE = 'refs' | 'body' | ...
    exec(open(__file__).read())
Масштаб: рост 1.75 м, лицом в -Y, ноги на z=0.
"""
import bpy, bmesh, math
from mathutils import Vector as V, Matrix, Euler

REF = '/Users/konstantin/repos/castle/prototype-3d/ref/'
PX = 1.75 / 974           # метров на пиксель листа
COLL = 'ElfRanger'


def coll():
    c = bpy.data.collections.get(COLL)
    if not c:
        c = bpy.data.collections.new(COLL)
        bpy.context.scene.collection.children.link(c)
    return c


def fresh(name, data=None):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    o = bpy.data.objects.new(name, data)
    coll().objects.link(o)
    return o


def view3d():
    for area in bpy.context.screen.areas:
        if area.type == 'VIEW_3D':
            return area, next(r for r in area.regions if r.type == 'WINDOW'), area.spaces.active
    return None, None, None


def look(view='FRONT', target=(0, 0, 0.9), dist=2.6, ortho=True, shading='MATERIAL'):
    area, region, space = view3d()
    r3d = space.region_3d
    rots = {
        'FRONT': Euler((math.radians(90), 0, 0)),
        'SIDE': Euler((math.radians(90), 0, math.radians(-90))),     # с -X: видно правый бок
        'BACK': Euler((math.radians(90), 0, math.radians(180))),
        'THREE': Euler((math.radians(75), 0, math.radians(30))),
    }
    r3d.view_rotation = rots[view].to_quaternion()
    r3d.view_location = V(target)
    r3d.view_distance = dist
    r3d.view_perspective = 'ORTHO' if ortho else 'PERSP'
    space.shading.type = shading
    space.overlay.show_floor = True


def mat(name, color, rough=0.7, metal=0.0, sss=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if sss and 'Subsurface Weight' in b.inputs:
        b.inputs['Subsurface Weight'].default_value = sss
    m.diffuse_color = (*color, 1)
    return m


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


# ------------------------------------------------------------------ стадия: референсы
def stage_refs():
    specs = [
        ('Ref_Front', 'view_front.png', (0, 0.7, 0.93), (math.radians(90), 0, 0)),
        ('Ref_Side', 'view_right.png', (0.7, -0.039, 0.93), (math.radians(90), 0, math.radians(-90))),
        ('Ref_Back', 'view_back.png', (0, -0.7, 0.93), (math.radians(90), 0, math.radians(180))),
    ]
    for name, fn, loc, rot in specs:
        o = fresh(name)
        o.empty_display_type = 'IMAGE'
        o.data = bpy.data.images.load(REF + fn, check_existing=True)
        o.empty_display_size = 1091 * PX
        o.empty_image_offset = (-0.5, -0.5)
        o.location, o.rotation_euler = loc, rot
        o.empty_image_depth = 'BACK'
        o.use_empty_image_alpha = True
        o.color[3] = 0.55
        o.show_empty_image_perspective = name != 'Ref_Side'
        o.hide_select = True
    cube = bpy.data.objects.get('Cube')
    if cube:
        bpy.data.objects.remove(cube)
    old = bpy.data.collections.get('ElfArcher')
    if old:
        old.hide_viewport = True
        old.hide_render = True


# ------------------------------------------------------------------ стадия: тело (skin modifier)
# Суставы (x вправо от персонажа = +X слева персонажа, y вперёд = -Y), радиусы (ширина, глубина)
BODY = {
    'pelvis': ((0, 0.0, 0.95), (0.138, 0.1)),
    'waist': ((0, 0.005, 1.09), (0.1, 0.08)),
    'chest': ((0, 0.0, 1.27), (0.128, 0.095)),
    'neck0': ((0, 0.01, 1.46), (0.058, 0.055)),
    'neck1': ((0, 0.005, 1.53), (0.048, 0.05)),
}
for s, sx in (('L', 1), ('R', -1)):
    BODY.update({
        f'clav.{s}': ((sx * 0.11, 0.01, 1.43), (0.06, 0.055)),
        f'shoulder.{s}': ((sx * 0.185, 0.01, 1.415), (0.048, 0.05)),
        f'elbow.{s}': ((sx * 0.27, 0.02, 1.15), (0.037, 0.038)),
        f'wrist.{s}': ((sx * 0.365, 0.0, 0.965), (0.027, 0.022)),
        f'hip.{s}': ((sx * 0.095, 0.0, 0.9), (0.085, 0.085)),
        f'knee.{s}': ((sx * 0.105, -0.01, 0.5), (0.052, 0.055)),
        f'calf.{s}': ((sx * 0.108, 0.0, 0.32), (0.05, 0.055)),
        f'ankle.{s}': ((sx * 0.11, 0.015, 0.085), (0.035, 0.04)),
        f'toe.{s}': ((sx * 0.115, -0.14, 0.03), (0.038, 0.03)),
    })
EDGES = [('pelvis', 'waist'), ('waist', 'chest'), ('chest', 'neck0'), ('neck0', 'neck1')]
for s in 'LR':
    EDGES += [('neck0', f'clav.{s}'), (f'clav.{s}', f'shoulder.{s}'), (f'shoulder.{s}', f'elbow.{s}'),
              (f'elbow.{s}', f'wrist.{s}'), ('pelvis', f'hip.{s}'), (f'hip.{s}', f'knee.{s}'),
              (f'knee.{s}', f'calf.{s}'), (f'calf.{s}', f'ankle.{s}'), (f'ankle.{s}', f'toe.{s}')]


def stage_body():
    me = bpy.data.meshes.new('BodyBase')
    names = list(BODY)
    me.from_pydata([BODY[n][0] for n in names], [(names.index(a), names.index(b)) for a, b in EDGES], [])
    o = fresh('Body', me)
    sk = o.modifiers.new('Skin', 'SKIN')
    sk.use_smooth_shade = True
    sk.branch_smoothing = 0.6
    for i, n in enumerate(names):
        o.data.skin_vertices[0].data[i].radius = BODY[n][1]
    o.data.skin_vertices[0].data[names.index('pelvis')].use_root = True
    sub = o.modifiers.new('Subsurf', 'SUBSURF')
    sub.levels = sub.render_levels = 2
    o.data.materials.append(mat('Skin', srgb('#e9b99a'), 0.55, sss=0.15))
    bpy.context.view_layer.objects.active = o


# ------------------------------------------------------------------ общие помощники формы
def sub(o, lv=2):
    m = o.modifiers.new('Subsurf', 'SUBSURF')
    m.levels = m.render_levels = lv
    return m


def smooth(o):
    for p in o.data.polygons:
        p.use_smooth = True


def mesh_obj(name, bm, material, subsurf=0):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = fresh(name, me)
    smooth(o)
    o.data.materials.append(material)
    if subsurf:
        sub(o, subsurf)
    return o


def ellipsoid(name, center, radii, material, seg=24, rings=12, deform=None, subsurf=1, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        co = v.co.copy()
        if deform:
            co = deform(co)
        sc_ = V((co.x * radii[0], co.y * radii[1], co.z * radii[2]))
        v.co = (rot @ sc_ if rot else sc_) + V(center)
    return mesh_obj(name, bm, material, subsurf)


def leaf(name, base, tip, width, thick, material, bend=V((0, 0, 0)), segs=6, side_hint=V((0, 0, 1)), subsurf=1):
    base, tip = V(base), V(tip)
    d = tip - base
    side = d.cross(side_hint)
    if side.length < 1e-5:
        side = V((1, 0, 0))
    side.normalize()
    nrm = side.cross(d).normalized()
    bm = bmesh.new()
    rows = []
    for i in range(segs + 1):
        t = i / segs
        c = base + d * t + bend * math.sin(math.pi * t)
        w = width * (math.sin(math.pi * min(1.0, t * 1.1)) ** 0.8) if i < segs else 0.0
        th = thick * (1 - 0.7 * t)
        rows.append([bm.verts.new(c - side * w), bm.verts.new(c + nrm * th), bm.verts.new(c + side * w),
                     bm.verts.new(c - nrm * th)])
    for a, b in zip(rows, rows[1:]):
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(list(reversed(rows[0])))
    return mesh_obj(name, bm, material, subsurf)


# ------------------------------------------------------------------ стадия: голова
HEAD_C = V((0, -0.004, 1.667))


def stage_head():
    skin = bpy.data.materials['Skin']

    def shape(c):
        x, y, z = c.x, c.y, c.z
        if z < 0:                                  # челюсть сужается к острому подбородку
            k = 1 - 0.33 * (-z) ** 1.7
            x *= k
            if y < 0:
                y *= 1 - 0.15 * (-z)
        if y > 0.2 and z > -0.2:                   # затылок
            y *= 1.08
        if y < -0.55:                              # лицо чуть плоское
            y = -0.55 + (y + 0.55) * 0.75
        if z > 0.55:
            x *= 1 - 0.1 * (z - 0.55)
        return V((x, y, z))
    ellipsoid('Head', HEAD_C, (0.075, 0.09, 0.104), skin, seg=32, rings=18, deform=shape, subsurf=1)
    # нос
    bm = bmesh.new()
    top = HEAD_C + V((0, -0.083, 0.02))
    tipc = HEAD_C + V((0, -0.103, -0.02))
    L = HEAD_C + V((-0.013, -0.088, -0.028))
    R = HEAD_C + V((0.013, -0.088, -0.028))
    back = HEAD_C + V((0, -0.078, -0.03))
    vs = [bm.verts.new(p) for p in (top, tipc, L, R, back)]
    for f in ((0, 2, 1), (0, 1, 3), (1, 2, 4), (1, 4, 3), (0, 3, 4), (0, 4, 2)):
        bm.faces.new([vs[i] for i in f])
    mesh_obj('Nose', bm, skin, subsurf=2)
    # глаза: белок, зелёная радужка, тёмная линия ресниц
    white = mat('EyeWhite', srgb('#efe9e2'), 0.35)
    iris = mat('Iris', srgb('#6b8f3a'), 0.2)
    lash = mat('Lash', srgb('#2a2019'), 0.6)
    lip = mat('Lips', srgb('#c98f80'), 0.45, sss=0.1)
    brow = mat('Brow', srgb('#b9ad98'), 0.8)
    for s, sx in (('L', 1), ('R', -1)):
        ec = HEAD_C + V((sx * 0.03, -0.074, 0.012))
        ellipsoid(f'Eye.{s}', ec, (0.016, 0.008, 0.0085), white, seg=16, rings=8, subsurf=1)
        ellipsoid(f'Iris.{s}', ec + V((0, -0.0065, 0)), (0.0068, 0.003, 0.0068), iris, seg=12, rings=6, subsurf=1)
        leaf(f'Lash.{s}', ec + V((-sx * 0.017, -0.005, 0.004)), ec + V((sx * 0.019, -0.002, 0.007)), 0.0035, 0.0018, lash,
             bend=V((0, -0.004, 0.004)), side_hint=V((0, 1, 0)))
        leaf(f'Brow.{s}', ec + V((-sx * 0.016, -0.008, 0.024)), ec + V((sx * 0.024, -0.001, 0.028)), 0.004, 0.002, brow,
             bend=V((0, -0.003, 0.004)), side_hint=V((0, 1, 0)))
        # ухо: длинный лист назад-вверх
        base = HEAD_C + V((sx * 0.068, 0.012, 0.005))
        tip = HEAD_C + V((sx * 0.13, 0.05, 0.085))
        leaf(f'Ear.{s}', base, tip, 0.024, 0.008, skin, bend=V((0, 0.006, 0.01)), segs=8)
    ellipsoid('Lips', HEAD_C + V((0, -0.083, -0.052)), (0.017, 0.006, 0.0055), lip, seg=16, rings=8, subsurf=1)


# ------------------------------------------------------------------ стадия: кисти
def capsule(name, a, b, r0, r1, material, seg=10):
    a, b = V(a), V(b)
    d = b - a
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=d.length)
    R = d.normalized().to_track_quat('Z', 'Y').to_matrix()
    for v in bm.verts:
        v.co = (a + b) / 2 + R @ v.co
    for p_ in (a, b):
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=6, radius=r0 if p_ is a else r1,
                                  matrix=Matrix.Translation(p_))
    o = mesh_obj(name, bm, material, 0)
    rm = o.modifiers.new('Remesh', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = 0.0025
    return o


def stage_hands():
    skin = bpy.data.materials['Skin']
    for n in [o.name for o in bpy.data.objects if o.name.split('.')[0] in ('Palm', 'Fingers', 'Thumb') or o.name.startswith(('Finger', 'Thumb'))]:
        bpy.data.objects.remove(bpy.data.objects[n])
    for s, sx in (('L', 1), ('R', -1)):
        el = V(BODY[f'elbow.{s}'][0])
        wr = V(BODY[f'wrist.{s}'][0])
        d = (wr - el).normalized()
        across = V((0, -1, 0))                                   # поперёк ладони: вперёд
        across = (across - across.dot(d) * d).normalized()
        palm_n = d.cross(across).normalized() * sx               # ладонь смотрит к бедру
        pc = wr + d * 0.045
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1)
        Rm = Matrix((across, palm_n, d)).transposed()
        for v in bm.verts:
            v.co = pc + Rm @ V((v.co.x * 0.036, v.co.y * 0.016, v.co.z * 0.05))
        mesh_obj(f'Palm.{s}', bm, skin, 1)
        for k, (off, ln) in enumerate(((-0.024, 0.062), (-0.008, 0.07), (0.008, 0.066), (0.023, 0.052))):
            k0 = pc + d * 0.04 + across * off
            k1 = k0 + d * ln * 0.55 - palm_n * 0.008
            k2 = k1 + d * ln * 0.45 - palm_n * 0.014
            capsule(f'Finger{k}a.{s}', k0, k1, 0.0085, 0.0078, skin)
            capsule(f'Finger{k}b.{s}', k1, k2, 0.0078, 0.0065, skin)
        t0 = pc - d * 0.02 + across * -0.028
        t1 = t0 + d * 0.035 + across * -0.012 - palm_n * 0.012
        t2 = t1 + d * 0.03 - palm_n * 0.008
        capsule(f'Thumb0.{s}', t0, t1, 0.011, 0.009, skin)
        capsule(f'Thumb1.{s}', t1, t2, 0.009, 0.0072, skin)


# ------------------------------------------------------------------ одежда
C = {
    'tunic': srgb('#526c3c'), 'tunic_dk': srgb('#3d5230'), 'leather': srgb('#6e4529'), 'leather_dk': srgb('#4a2d1b'),
    'pants': srgb('#3b3530'), 'boot': srgb('#5f3b22'), 'cloak': srgb('#435c35'), 'hair': srgb('#d9d3c4'),
    'metal': srgb('#a6a6a6'), 'wood': srgb('#8c6441'), 'feather': srgb('#d8d4cc'), 'gold': srgb('#b89a5a'),
}


def M(name, key, rough=0.65, metal=0.0):
    return mat(name, C[key], rough, metal)


def eval_mesh(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    return bpy.data.meshes.new_from_object(obj.evaluated_get(dg))


def seg_t(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return t, (p - (a + ab * t)).length


def shell(name, src, keep, offset, material, solid=0.0, subsurf=0, push=None):
    me = eval_mesh(src)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep(v.co)], context='VERTS')
    bm.normal_update()
    for v in bm.verts:
        off = offset(v.co) if callable(offset) else offset
        v.co = v.co + v.normal * off
        if push:
            v.co = v.co + push(v.co)
    o = mesh_obj(name, bm, material, 0)
    if solid:
        so = o.modifiers.new('Solid', 'SOLIDIFY')
        so.thickness = solid
        so.offset = 1
    if subsurf:
        sub(o, subsurf)
    return o


def arm_pts(s):
    return V(BODY[f'shoulder.{s}'][0]), V(BODY[f'elbow.{s}'][0]), V(BODY[f'wrist.{s}'][0])


def in_arm(p, s, t_max=1.0, r=0.085):
    sh, el, wr = arm_pts(s)
    t1, d1 = seg_t(p, sh, el)
    t2, d2 = seg_t(p, el, wr)
    return (d1 < r) or (d2 < r and t2 <= t_max)


def in_hand(p):
    for s in 'LR':
        sh, el, wr = arm_pts(s)
        d = (wr - el).normalized()
        if (p - wr).dot(d) > -0.005 and (p - wr).length < 0.2:
            return True
    return False


def ring_tube(name, rings, material, closed=True, gap=None, solid=0.0, subsurf=1, n=32):
    """rings: [(z, cx, cy, rx, ry)], gap(z)->полуширина разреза спереди в радианах."""
    bm = bmesh.new()
    grid = []
    for z, cx, cy, rx, ry in rings:
        g = gap(z) if gap else 0.0
        row = []
        for i in range(n + (0 if (closed and not g) else 1)):
            if closed and not g:
                a = -math.pi / 2 + 2 * math.pi * i / n
            else:
                a = -math.pi / 2 + g + (2 * math.pi - 2 * g) * i / n
            row.append(bm.verts.new((cx + rx * math.cos(a), cy + ry * math.sin(a), z)))
        grid.append(row)
    for ra, rb in zip(grid, grid[1:]):
        m = min(len(ra), len(rb))
        rng = range(m) if (closed and len(ra) == n) else range(m - 1)
        for i in rng:
            j = (i + 1) % m
            bm.faces.new((ra[i], ra[j], rb[j], rb[i]))
    o = mesh_obj(name, bm, material, 0)
    if solid:
        so = o.modifiers.new('Solid', 'SOLIDIFY')
        so.thickness = solid
        so.offset = 1
    if subsurf:
        sub(o, subsurf)
    return o


def stage_clothes():
    body = bpy.data.objects['Body']
    tunic_m, lea, lea_dk = M('Tunic', 'tunic', 0.75), M('Leather', 'leather', 0.55), M('LeatherDark', 'leather_dk', 0.6)
    pants_m, boot_m, metal = M('Pants', 'pants', 0.8), M('Boot', 'boot', 0.5), M('Metal', 'metal', 0.3, 0.9)
    # штаны: материал тела ниже пояса
    if 'Pants' not in body.data.materials:
        body.data.materials.append(pants_m)
    # тело: всё ниже 0.98 — штаны (через копию сетки с материалами по граням нельзя: skin-модификатор),
    # поэтому ноги закрываем тонкой оболочкой
    shell('Pants', body, lambda c: c.z < 1.0 and not in_hand(c) and abs(c.x) < 0.25, 0.004, pants_m, subsurf=0)

    def bust(c):
        d = V((0, 0, 0))
        for sx in (1, -1):
            q = ((c.x - sx * 0.065) / 0.07) ** 2 + ((c.z - 1.3) / 0.06) ** 2
            if c.y < 0:
                d.y -= 0.028 * math.exp(-q)
        return d
    # туника: торс + рукава до запястья, воротник-стойка
    shell('Tunic', body, lambda c: (0.96 < c.z < 1.51 and abs(c.x) < 0.2) or in_arm(c, 'L', 0.93) or in_arm(c, 'R', 0.93),
          0.008, tunic_m, subsurf=1, push=bust)
    # юбка туники с разрезом спереди
    ring_tube('TunicSkirt', [(1.0, 0, 0.0, 0.148, 0.115), (0.9, 0, 0.0, 0.16, 0.122), (0.8, 0, 0.0, 0.172, 0.13),
                             (0.72, 0, 0.0, 0.18, 0.137), (0.665, 0, 0.0, 0.185, 0.14)],
              tunic_m, closed=True, gap=lambda z: max(0.0, (0.86 - z) * 0.9), solid=0.007, subsurf=1)
    # сапоги: оболочка голени и стопы + отворот
    for s, sx in (('L', 1), ('R', -1)):
        shell(f'Boot.{s}', body, lambda c, sx=sx: c.z < 0.47 and c.x * sx > 0.02, 0.013, boot_m, subsurf=1)
        kx = V(BODY[f'knee.{s}'][0]).x
        ring_tube(f'BootCuff.{s}', [(0.4, kx, 0.0, 0.066, 0.07), (0.44, kx, 0.0, 0.074, 0.078), (0.485, kx, 0.0, 0.078, 0.082)],
                  boot_m, solid=0.008, subsurf=1)
        # подошва
        ellipsoid(f'Sole.{s}', (sx * 0.113, -0.045, 0.012), (0.05, 0.13, 0.014), lea_dk, seg=16, rings=6, subsurf=1)
    # наручи
    for s in 'LR':
        sh, el, wr = arm_pts(s)
        def keep_b(c, el=el, wr=wr):
            t, d = seg_t(c, el, wr)
            return d < 0.09 and 0.18 < t < 0.97
        shell(f'Bracer.{s}', body, keep_b, lambda c: 0.024, lea, subsurf=1)
    # наплечники: три слоя пластин
    for s, sx in (('L', 1), ('R', -1)):
        sh, el, wr = arm_pts(s)
        d = (el - sh).normalized()
        out = V((sx, 0, 0.35)).normalized()
        for k in range(3):
            c = sh + d * (0.01 + 0.045 * k) + out * 0.03 + V((0, 0, 0.02))
            r = 0.075 - 0.01 * k
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=1)
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.05], context='VERTS')
            R = out.to_track_quat('Z', 'Y').to_matrix()
            for v in bm.verts:
                lc = V((v.co.x * r * 1.05, v.co.y * r * 1.15, v.co.z * r * 0.55))
                v.co = c + R @ lc
            o = mesh_obj(f'Pauldron{k}.{s}', bm, lea if k != 1 else lea_dk, 0)
            so = o.modifiers.new('Solid', 'SOLIDIFY'); so.thickness = 0.007
            sub(o, 2)
    # V-накладка на груди
    for sx in (1, -1):
        leaf(f'Yoke.{"L" if sx > 0 else "R"}', (sx * 0.15, -0.02, 1.47), (0, -0.14, 1.32), 0.022, 0.005, lea,
             bend=V((0, -0.035, 0)), segs=8, side_hint=V((0, 1, 0)))
    ellipsoid('Clasp', (0.035, -0.135, 1.43), (0.012, 0.005, 0.009), metal, seg=12, rings=6)
    # пояс, пряжка, сумка
    ring_tube('Belt', [(0.95, 0, 0.0, 0.168, 0.13), (0.99, 0, 0.0, 0.165, 0.128)], lea, solid=0.008, subsurf=1)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = V((v.co.x * 0.04, v.co.y * 0.008, v.co.z * 0.034)) + V((-0.02, -0.146, 0.97))
    o = mesh_obj('Buckle', bm, metal, 1)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = V((v.co.x * 0.075, v.co.y * 0.04, v.co.z * 0.075)) + V((-0.115, -0.13, 0.92))
    mesh_obj('Pouch', bm, lea, 2)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = V((v.co.x * 0.078, v.co.y * 0.012, v.co.z * 0.035)) + V((-0.115, -0.155, 0.94))
    mesh_obj('PouchFlap', bm, lea_dk, 2)


def stage_cloak():
    cloak_m = M('Cloak', 'cloak', 0.85)
    bm = bmesh.new()
    nu, nv = 36, 16
    grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u = -1 + 2 * i / nu
            th = u * math.radians(112)
            t_top = 0.0
            z_hem = 0.6 + 0.2 * abs(u) ** 1.05
            z_top = 1.47 - 0.05 * abs(u) ** 2
            t = j / nv
            z = z_top + (z_hem - z_top) * t
            rx = 0.2 + 0.055 * t ** 0.9
            ry = 0.14 + 0.1 * t ** 0.9
            fold = 1 + 0.045 * math.sin(9 * th) * t ** 1.2
            x = math.sin(th) * rx * fold
            y = math.cos(th) * ry * fold + 0.02
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for a, b in zip(grid, grid[1:]):
        for i in range(nu):
            bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
    o = mesh_obj('Cloak', bm, cloak_m, 0)
    so = o.modifiers.new('Solid', 'SOLIDIFY'); so.thickness = 0.008
    sub(o, 1)
    # капюшон: мягкий валик у шеи и складки на спине
    ring_tube('HoodRoll', [(1.44, 0, 0.015, 0.135, 0.12), (1.49, 0, 0.02, 0.115, 0.105), (1.53, 0, 0.03, 0.09, 0.085)],
              cloak_m, gap=lambda z: 0.55, solid=0.02, subsurf=2)
    ellipsoid('Hood', (0, 0.125, 1.43), (0.12, 0.05, 0.1), cloak_m, seg=20, rings=10, subsurf=1)


def stage_hair():
    hair_m = M('Hair', 'hair', 0.5)
    head = bpy.data.objects['Head']

    def keep(c):
        rel = c - HEAD_C
        hairline = 0.03 + 0.045 * max(0.0, -rel.y / 0.09)     # спереди линия волос выше
        side_cut = abs(rel.x) > 0.055 and rel.y < 0.01 and rel.z < 0.02
        return rel.z > -0.035 + hairline * (rel.y < 0) and not side_cut or (rel.y > 0.02 and rel.z > -0.07)

    def groove(c):
        return 0.009 + 0.0025 * math.sin(c.x * 260)
    shell('HairCap', head, keep, groove, hair_m, subsurf=1)
    # коса: цепочка долей, чередующихся влево-вправо
    def braid(name, a, b, n, r0, r1, sway=0.011):
        a, b = V(a), V(b)
        for i in range(n):
            t = i / (n - 1)
            c = a.lerp(b, t) + V((sway * (1 if i % 2 else -1), 0, 0))
            r = r0 + (r1 - r0) * t
            ellipsoid(f'{name}{i:02d}', c, (r * 0.95, r * 0.8, r * 1.35), hair_m, seg=12, rings=6, subsurf=1,
                      rot=Euler((0, math.radians(28 if i % 2 else -28), 0)).to_matrix())
    braid('Braid', HEAD_C + V((0, 0.095, -0.01)), (0, 0.135, 1.22), 14, 0.024, 0.014)
    ellipsoid('BraidTie', (0, 0.134, 1.205), (0.012, 0.012, 0.01), M('LeatherDark', 'leather_dk'), seg=10, rings=6)
    leaf('BraidTuft', (0, 0.135, 1.2), (0, 0.13, 1.12), 0.014, 0.008, hair_m, segs=5)
    for s, sx in (('L', 1), ('R', -1)):
        braid(f'SideBraid.{s}.', HEAD_C + V((sx * 0.07, -0.02, 0.06)), HEAD_C + V((sx * 0.035, 0.09, 0.02)), 7, 0.011, 0.009, 0.005)


def stage_gear():
    lea, lea_dk, metal = M('Leather', 'leather', 0.55), M('LeatherDark', 'leather_dk', 0.6), M('Metal', 'metal', 0.3, 0.9)
    wood, feather, gold = M('Wood', 'wood', 0.5), M('Feather', 'feather', 0.8), M('Gold', 'gold', 0.35, 0.8)
    # колчан: снизу слева-сзади к правому плечу
    a, b = V((0.16, 0.2, 0.98)), V((-0.11, 0.2, 1.5))
    d = (b - a).normalized()
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.042, radius2=0.05, depth=(b - a).length)
    R = d.to_track_quat('Z', 'Y').to_matrix()
    for v in bm.verts:
        v.co = (a + b) / 2 + R @ v.co
    o = mesh_obj('Quiver', bm, lea, 1)
    for k, t in enumerate((0.05, 0.95)):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=False, segments=16, radius1=0.053, radius2=0.053, depth=0.025)
        for v in bm.verts:
            v.co = a.lerp(b, t) + R @ v.co
        mesh_obj(f'QuiverRim{k}', bm, gold, 1)
    ring_tube('QuiverStrap', [(1.2, 0, 0.0, 0.2, 0.155), (1.23, 0, 0.0, 0.2, 0.155)], lea_dk, solid=0.006, subsurf=1)
    c0 = V((0, 0, 1.215))
    bpy.data.objects['QuiverStrap'].data.transform(
        Matrix.Translation(c0) @ Euler((0, math.radians(-38), 0)).to_matrix().to_4x4() @ Matrix.Translation(-c0))
    for i in range(7):
        off = V(((i % 3 - 1) * 0.018, ((i // 3) - 1) * 0.016, 0))
        p0 = b - d * 0.05 + off
        p1 = b + d * (0.2 + 0.02 * (i % 2)) + off
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.004, radius2=0.004, depth=(p1 - p0).length)
        for v in bm.verts:
            v.co = (p0 + p1) / 2 + R @ v.co
        mesh_obj(f'QArrow{i}', bm, wood, 0)
        for f in range(3):
            ang = f * 2.094
            side = (R @ V((math.cos(ang), math.sin(ang), 0)))
            leaf(f'QFeather{i}_{f}', p1 - d * 0.075 + side * 0.004, p1 - d * 0.005 + side * 0.004, 0.012, 0.0015, feather,
                 side_hint=side, segs=4, subsurf=0)
    # лук за спиной: от левого плеча вверх до правого бедра вниз
    top, bot = V((0.24, 0.24, 1.93)), V((-0.3, 0.24, 0.66))
    axis = (top - bot)
    L = axis.length
    ax = axis.normalized()
    perp = V((0, 1, 0)).cross(ax).normalized()      # в плоскости спины
    pts, radii = [], []
    for i in range(33):
        t = -1 + 2 * i / 32
        bulge = 0.09 * (1 - t * t) - 0.05 * max(0.0, abs(t) - 0.75) / 0.25
        pts.append((bot + top) / 2 + ax * (L / 2 * t) + perp * bulge)
        radii.append(1.3 - 0.8 * abs(t))
    cu = bpy.data.curves.new('BowCurve', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 0.013; cu.bevel_resolution = 2
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for p_, co, r in zip(sp.points, pts, radii):
        p_.co = (*co, 1); p_.radius = r
    o = fresh('Bow', cu)
    o.data.materials.append(wood)
    cu2 = bpy.data.curves.new('StringCurve', 'CURVE'); cu2.dimensions = '3D'; cu2.bevel_depth = 0.0018
    sp = cu2.splines.new('POLY'); sp.points.add(1)
    sp.points[0].co = (*pts[0], 1); sp.points[1].co = (*pts[-1], 1)
    o2 = fresh('BowString', cu2)
    o2.data.materials.append(M('String', 'feather', 0.6))
    grip = (bot + top) / 2 + perp * 0.09
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.017, radius2=0.017, depth=0.11)
    Rg = ax.to_track_quat('Z', 'Y').to_matrix()
    for v in bm.verts:
        v.co = grip + Rg @ v.co
    mesh_obj('BowGrip', bm, lea_dk, 1)


def stage_bow_hand():
    """Лук в левой руке (для игры): вертикально, тетива к лучнику (+Y), рукоять в кулаке."""
    wood, lea_dk = M('Wood', 'wood', 0.5), M('LeatherDark', 'leather_dk', 0.6)
    el, wr = V(BODY['elbow.L'][0]), V(BODY['wrist.L'][0])
    d = (wr - el).normalized()
    grip = wr + d * 0.05 + V((0.012, 0, 0))
    half = 0.62
    ax = V((0, 0, 1))
    front = V((0, -1, 0))
    pts, radii = [], []
    for i in range(33):
        t = -1 + 2 * i / 32
        bulge = 0.08 * (1 - t * t) - 0.05 * max(0.0, abs(t) - 0.75) / 0.25
        pts.append(grip + ax * (half * t) + front * (bulge - 0.08))
        radii.append(1.3 - 0.8 * abs(t))
    cu = bpy.data.curves.new('BowCurve', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 0.013; cu.bevel_resolution = 2
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for p_, co, r in zip(sp.points, pts, radii):
        p_.co = (*co, 1); p_.radius = r
    o = fresh('Bow', cu)
    o.data.materials.append(wood)
    cu2 = bpy.data.curves.new('StringCurve', 'CURVE'); cu2.dimensions = '3D'; cu2.bevel_depth = 0.0018
    sp = cu2.splines.new('POLY'); sp.points.add(1)
    sp.points[0].co = (*pts[0], 1); sp.points[1].co = (*pts[-1], 1)
    o2 = fresh('BowString', cu2)
    o2.data.materials.append(M('String', 'feather', 0.6))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.017, radius2=0.017, depth=0.11)
    for v in bm.verts:
        v.co = grip + v.co
    mesh_obj('BowGrip', bm, lea_dk, 1)


STAGES = {'refs': stage_refs, 'body': stage_body, 'head': stage_head, 'hands': stage_hands,
          'clothes': stage_clothes, 'cloak': stage_cloak, 'hair': stage_hair, 'gear': stage_gear, 'bow_hand': stage_bow_hand}
for st in (STAGE if isinstance(STAGE, (list, tuple)) else [STAGE]):
    STAGES[st]()
