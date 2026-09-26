import bpy, sys, bmesh
import numpy as np
from mathutils import Vector
src = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
o = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
me = o.data
co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
co = (np.array(o.matrix_world) @ np.c_[co, np.ones(len(co))].T).T[:, :3]
h, edges = np.histogram(co[:, 0], bins=50)
for c, e in zip(h, edges): print(f'{e:+.3f} {c}')
bpy.context.view_layer.objects.active = o; o.select_set(True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.separate(type='LOOSE'); bpy.ops.object.mode_set(mode='OBJECT')
parts = [p for p in bpy.context.scene.objects if p.type == 'MESH']
print('PARTS', len(parts))
rows = []
for p in parts:
    bb = [p.matrix_world @ Vector(c) for c in p.bound_box]
    xs = [v.x for v in bb]; zs = [v.z for v in bb]
    rows.append((len(p.data.vertices), min(xs), max(xs), min(zs), max(zs)))
rows.sort(reverse=True)
for r in rows[:25]: print('part verts=%d x[%.3f,%.3f] z[%.3f,%.3f]' % r)
