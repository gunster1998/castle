import bpy, sys
import numpy as np
bpy.ops.wm.open_mainfile(filepath=sys.argv[sys.argv.index('--') + 1])
me = bpy.data.objects['ElfBody'].data
P = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3)
x, y, z = P.T
for zlo, zhi in ((0.18, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 0.95)):
    m = (x > 0.2) & (x < 0.44) & (z > zlo) & (z < zhi)
    print(f'z {zlo}-{zhi}: n={m.sum()}')
    h, e = np.histogram(y[m], bins=12, range=(-0.35, 0.25))
    print('  y:', ' '.join(f'{a:+.2f}:{c}' for a, c in zip(e, h)))
    h, e = np.histogram(x[m], bins=12, range=(0.2, 0.44))
    print('  x:', ' '.join(f'{a:.2f}:{c}' for a, c in zip(e, h)))
