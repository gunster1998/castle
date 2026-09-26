"""Готовит эльфа к Mixamo: тело без лука (FBX с текстурой) и лук отдельно (GLB)."""
import bpy, bmesh, sys, os
import numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=SRC)
body = bpy.data.objects['ElfBody']
me = body.data

def verts_np():
    a = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', a); return a.reshape(-1, 3)

def components():
    E = np.empty(len(me.edges) * 2, int); me.edges.foreach_get('vertices', E); E = E.reshape(-1, 2)
    parent = np.arange(len(me.vertices))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for a, b in E:
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb
    return np.array([find(i) for i in range(len(parent))])

P = verts_np(); x, y, z = P.T
comp = components()
labels, counts = np.unique(comp, return_counts=True)
main = labels[np.argmax(counts)]
isl = [l for l in labels if l != main and x[comp == l].max() > 0.4]
hand = (x > 0.44) & (z > 0.83) & (z < 1.08)
B = np.isin(comp, isl) | ((x > 0.44) & ~hand) | ((x > 0.2) & (z > 0.18) & (z < 0.95) & ((y < -0.17) | ((y > 0.12) & (z < 0.6))))
# грип лука внутри кулака: тонкая вертикаль x>0.47 в зоне кисти, дальше от центра кулака
grip = hand & (np.abs(y + 0.02) < 0.035) & (x > 0.48) & ((z < 0.9) | (z > 1.03))
B |= grip

bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
bow_faces = [f for f in bm.faces if sum(B[v.index] for v in f.verts) >= 2]
for f in bm.faces: f.select = f in set(bow_faces)
bm.to_mesh(me); bm.free()
bpy.context.view_layer.objects.active = body; body.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.separate(type='SELECTED')
bpy.ops.object.mode_set(mode='OBJECT')
bow = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o != body][0]
bow.name = 'Bow'
for o in (body, bow):
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose(); bpy.ops.object.mode_set(mode='OBJECT')
print('BODY faces', len(body.data.polygons), 'BOW faces', len(bow.data.polygons))
# текстура наружу для FBX
for img in bpy.data.images:
    if img.packed_file or img.source == 'FILE':
        img.filepath_raw = os.path.join(OUT, 'elf_texture.png'); img.file_format = 'PNG'
        try:
            img.save(); print('TEXTURE', img.name)
        except Exception as e:
            print('TEXFAIL', e)
        break
bpy.ops.object.select_all(action='DESELECT'); body.select_set(True)
bpy.ops.export_scene.fbx(filepath=os.path.join(OUT, 'elf_for_mixamo.fbx'), use_selection=True,
                         path_mode='COPY', embed_textures=True, apply_scale_options='FBX_SCALE_ALL', axis_forward='-Z', axis_up='Y')
bpy.ops.object.select_all(action='DESELECT'); bow.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'elf_bow.glb'), use_selection=True, export_format='GLB', export_image_format='JPEG')
# превью: тело без лука спереди
sc = bpy.context.scene
bow.hide_render = True
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 2.2
cam.location = (0, -5, 0.95); cam.rotation_euler = (1.5708, 0, 0)
sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'TEXTURE'
sc.render.resolution_x = sc.render.resolution_y = 600
sc.render.filepath = os.path.join(OUT, 'preview_body.png'); bpy.ops.render.render(write_still=True)
bow.hide_render = False; body.hide_render = True
sc.render.filepath = os.path.join(OUT, 'preview_bow.png'); bpy.ops.render.render(write_still=True)
