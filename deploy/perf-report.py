#!/usr/bin/env python3
"""Сводка логов производительности с сервера.
  ./deploy/perf-report.py            — за сегодня
  ./deploy/perf-report.py 2026-09-26 — за дату
"""
import json, subprocess, sys, datetime
from collections import Counter, defaultdict

HOST = 'root@82.97.249.219'
day = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat()
raw = subprocess.run(['ssh', '-o', 'BatchMode=yes', HOST, f'cat /opt/castlefight3d/logs/perf-{day}.log 2>/dev/null'],
                     capture_output=True, text=True).stdout
rows = [json.loads(l) for l in raw.splitlines() if l.startswith('{')]
if not rows:
    sys.exit(f'Логов за {day} нет')

clients = [r for r in rows if r['type'] == 'client']
servers = [r for r in rows if r['type'] == 'server']
devices = {}
for r in clients:
    d = r['data'].get('device')
    if d:
        devices[r['player']] = d

print(f'=== {day}: отчётов клиентов {len(clients)}, замеров сервера {len(servers)}')
print('\n--- Устройства')
for pid, d in devices.items():
    print(f"  {pid}: {d.get('gpu')} | {d.get('cores')} ядер, {d.get('memoryGb')} ГБ | экран {d.get('screen')}")

print('\n--- Кадры по игрокам (сводки раз в 30 с)')
per = defaultdict(list)
for r in clients:
    if r['data'].get('kind') in ('report', 'final'):
        per[(r['player'], r.get('name'))].append(r['data'])
for (pid, name), reps in per.items():
    fps = [x['fpsAvg'] for x in reps if x.get('fpsAvg')]
    p95 = [x['p95'] for x in reps if x.get('p95')]
    hitches = sum(x.get('hitches', 0) for x in reps)
    outside = sum(x.get('hitchesOutside', 0) for x in reps)
    print(f"  {pid} {name}: FPS ср. {sum(fps)/max(1,len(fps)):.0f} (мин. {min(fps, default=0):.0f}), p95 кадра {max(p95, default=0):.0f} мс, "
          f"рывков {hitches}, из них вне кода {outside}")

print('\n--- На чём рывки (самый тяжёлый участок кадра)')
cause = Counter()
worst = []
for r in clients:
    d = r['data']
    for h in (d.get('worst') or []) + ([d['hitch']] if d.get('hitch') else []):
        if h['outside']:
            cause['вне кода: видеокарта, сборка мусора, браузер'] += 1
        else:
            top = max(h['sections'].items(), key=lambda kv: kv[1])[0]
            cause[f'код: {top}'] += 1
        worst.append((h['interval'], r['player'], h))
for k, v in cause.most_common():
    print(f'  {v:4} × {k}')
print('\n--- Пять худших рывков')
for ms, pid, h in sorted(worst, key=lambda x: -x[0])[:5]:
    print(f"  {ms} мс у {pid}: код {h['work']} мс {h['sections']} | юнитов {h['units']}, создано {h['created']}, качество {h['quality']}")

print('\n--- Сервер')
for r in servers[-10:]:
    rooms = ', '.join(f"{x['name']}: тик {x['tickAvgMs']}/{x['tickMaxMs']} мс, юнитов до {x['unitsMax']}, {x['sentKBps']} КБ/с" for x in r['rooms'])
    print(f"  {r['ts'][11:19]} онлайн {r['online']}, память {r['rssMB']} МБ, задержка цикла p99 {r['loopDelayMs']['p99']} мс | {rooms}")
