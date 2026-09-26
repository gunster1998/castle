import bpy, sys
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=sys.argv[sys.argv.index('--') + 1])
o = bpy.data.objects['ElfBody']
bpy.context.view_layer.objects.active = o; o.select_set(True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.separate(type='LOOSE'); bpy.ops.object.mode_set(mode='OBJECT')
rows = []
for p in [x for x in bpy.context.scene.objects if x.type == 'MESH']:
    bb = [Vector(c) for c in p.bound_box]
    rows.append((len(p.data.polygons), *[f(v[i] for v in bb) for i in range(3) for f in (min, max)]))
rows.sort(reverse=True)
print('ISLANDS', len(rows))
for r in rows[:40]: print('faces=%5d x[%+.2f,%+.2f] y[%+.2f,%+.2f] z[%.2f,%.2f]' % r)
