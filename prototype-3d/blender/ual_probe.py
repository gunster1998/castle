import bpy, sys
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[sys.argv.index('--') + 1])
arm = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE'][0]
print('ARM', arm.name, arm.matrix_world.to_translation(), arm.matrix_world.to_scale())
for n in ('DEF-hips', 'DEF-spine.003', 'DEF-neck', 'DEF-head', 'DEF-upper_arm.L', 'DEF-forearm.L', 'DEF-hand.L', 'DEF-thigh.L', 'DEF-shin.L', 'DEF-foot.L', 'DEF-toe.L'):
    b = arm.data.bones[n]
    print(n, 'head', (arm.matrix_world @ b.head_local).to_tuple(3), 'tail', (arm.matrix_world @ b.tail_local).to_tuple(3), 'parent', b.parent.name if b.parent else None)
acts = [a.name for a in bpy.data.actions]
print('ACTIONS', len(acts), acts[:8])
a = bpy.data.actions[0]
print('RANGE', a.name, tuple(a.frame_range), 'slots', [s.identifier for s in a.slots] if hasattr(a, 'slots') else None)
print('ANIMDATA', arm.animation_data.action.name if arm.animation_data and arm.animation_data.action else None, len(arm.animation_data.nla_tracks) if arm.animation_data else 0)
print('MESHES', [o.name for o in bpy.context.scene.objects if o.type == 'MESH'])
print('FPS', bpy.context.scene.render.fps)
