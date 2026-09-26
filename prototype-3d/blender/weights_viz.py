import bpy, sys, os
import numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=argv[0]); out = argv[1]
body = bpy.data.objects['ElfBody']; me = body.data
PAL = {'hips': (0, 1, 1), 'spine': (0, 0.8, 0), 'head': (1, 1, 1), 'cape': (0, 0, 1),
       'upper_arm.R': (1, 0, 0), 'forearm.R': (1, 0.5, 0), 'hand.R': (1, 1, 0),
       'upper_arm.L': (0.6, 0, 0.6), 'forearm.L': (1, 0, 1), 'hand.L': (1, 0.7, 1),
       'thigh.L': (0.3, 0.3, 1), 'shin.L': (0.5, 0.5, 1), 'foot.L': (0.7, 0.7, 1),
       'thigh.R': (0.2, 0.5, 0.2), 'shin.R': (0.4, 0.7, 0.4), 'foot.R': (0.6, 0.9, 0.6)}
names = {g.index: g.name for g in body.vertex_groups}
col = np.zeros((len(me.vertices), 3))
for v in me.vertices:
    c = np.zeros(3)
    for g in v.groups:
        c += g.weight * np.array(PAL.get(names[g.group], (0.5, 0.5, 0.5)))
    col[v.index] = c
attr = me.color_attributes.new('W', 'FLOAT_COLOR', 'POINT')
for i, c in enumerate(col):
    attr.data[i].color = (*c, 1)
me.color_attributes.active_color = attr
sc = bpy.context.scene
arm = bpy.data.objects['ElfArcherAI']
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'VERTEX'
sc.render.resolution_x = sc.render.resolution_y = 520
sc.view_settings.view_transform = 'Standard'
arm.animation_data.action = None
for t in arm.animation_data.nla_tracks: t.mute = True
for name, act, fr, loc in (('front_rest', None, 0, (0, -5, 0.95)), ('side_rest', None, 0, (5, 0, 0.95)),
                           ('shoot', 'Shoot', 16, (2.2, -3.2, 1.3)), ('run', 'Run', 6, (2.2, -3.2, 1.1))):
    arm.animation_data.action = bpy.data.actions[act] if act else None
    if not act:
        for pb in arm.pose.bones: pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    sc.frame_set(fr)
    if 'rest' in name:
        cam.data.type = 'ORTHO'; cam.data.ortho_scale = 2.2
    else:
        cam.data.type = 'PERSP'; cam.data.lens = 40
    cam.location = loc
    from mathutils import Vector
    cam.rotation_euler = (Vector((0, 0, 1.0 if 'rest' not in name else 0.95)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(out, f'w_{name}.png'); bpy.ops.render.render(write_still=True)
