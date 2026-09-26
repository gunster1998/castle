# Битва Замков

Браузерная 3D-стратегия в духе Castle Fight: строишь здания на своей базе, они сами нанимают воинов,
воины идут на вражеский замок. Люди против нежити, до 4 игроков в каждой команде, боты трёх уровней.

- **Клиент** — `client/`: TypeScript, Vite, Three.js. Модели — KayKit (CC0), анимации — из тех же наборов.
- **Сервер** — `server/`: Node.js, WebSocket (`ws`). Комнаты, быстрый поиск 1×1 / 2×2 / 4×4, боты.
  В продакшене тот же процесс отдаёт собранный клиент.

## Запуск для разработки

```bash
npm install
npm run dev:server    # ws://localhost:3001
npm run dev:client    # http://localhost:5173
```

Предпросмотр 3D без сервера (имитация боя): http://localhost:5173/preview.html
(`?stress=200` — нагрузочный режим, `?showcase` — все юниты крупно).

Модели собираются скриптом из наборов KayKit: `cd client && npm run assets` (результат — `client/public/assets`).

## Выкладка

`./deploy/deploy.sh` — собирает клиент и сервер (в один файл через esbuild), заливает на сервер
и перезапускает systemd-сервис `castlefight3d` (порт 8788).

## Устройство

| Файл | Что внутри |
|---|---|
| `server/src/index.ts` | подключения, меню, очереди поиска, список комнат |
| `server/src/GameRoom.ts` | комната: лобби, раунды, бой, постройка и улучшения, боты |
| `*/src/types.ts`, `placement.ts`, `upgrades.ts` | общие типы и правила — одинаковые у клиента и сервера |
| `client/src/renderer.ts` | 3D-отрисовка, эффекты, автокачество |
| `client/src/merge.ts` | склейка моделей для производительности |
| `client/src/main.ts` | меню, комнаты, ввод, карточка здания |
| `prototype-3d/blender/` | скрипты Blender для экспериментальных моделей |

## Лицензии моделей

- [KayKit](https://kaylousberg.com) (Kay Lousberg): Adventurers, Skeletons, Medieval Hexagon, Halloween Bits — CC0.
- [Quaternius Universal Animation Library](https://quaternius.com) — CC0 (используется в прототипах).
