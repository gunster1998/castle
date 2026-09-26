"""Шаг 1: вырезать среднюю фигуру из листа с тремя ракурсами, склеить, упростить, нормировать."""
import bpy, bmesh, sys, os
import numpy as np
from mathutils import Vector, Matrix
argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
X0, X1 = -0.178, 0.158          # пустые промежутки между фигурами
TARGET_TRIS = 24000
TARGET_H = 1.9
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
o = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
bpy.context.view_layer.objects.active = o; o.select_set(True)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for e in [x for x in bpy.context.scene.objects if x.type == 'EMPTY']:
    bpy.data.objects.remove(e)
bm = bmesh.new(); bm.from_mesh(o.data)
kill = [f for f in bm.faces if not (X0 < f.calc_center_median().x < X1)]
bmesh.ops.delete(bm, geom=kill, context='FACES')
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context='VERTS')
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.to_mesh(o.data); bm.free()
tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
print('AFTER CUT tris', tris)
mod = o.modifiers.new('Dec', 'DECIMATE'); mod.ratio = min(1.0, TARGET_TRIS / tris)
bpy.ops.object.modifier_apply(modifier='Dec')
print('AFTER DECIMATE tris', sum(len(p.vertices) - 2 for p in o.data.polygons))
# нормировка: ноги на z=0, центр по x/y, рост TARGET_H
co = np.empty(len(o.data.vertices) * 3); o.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
mn, mx = co.min(0), co.max(0)
s = TARGET_H / (mx[2] - mn[2])
T = Matrix.Scale(s, 4) @ Matrix.Translation(Vector((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2])))
o.data.transform(T)
o.data.update()
o.name = 'ElfBody'
bpy.ops.object.shade_smooth()
co = np.empty(len(o.data.vertices) * 3); o.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
print('BOUNDS', co.min(0).round(3), co.max(0).round(3))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'extracted.blend'))
# ортографические рендеры с сеткой для разметки суставов
sc = bpy.context.scene
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 2.2
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'TEXTURE'
sc.render.resolution_x = sc.render.resolution_y = 880   # 400 px на метр
for name, loc, rot in (('ortho_front', (0, -5, 0.95), (1.5708, 0, 0)), ('ortho_side', (5, 0, 0.95), (1.5708, 0, 1.5708))):
    cam.location = loc; cam.rotation_euler = rot
    sc.render.filepath = os.path.join(out, name + '.png')
    bpy.ops.render.render(write_still=True)
