# notion-mcp-bridge

Локальный «мост», который даёт **Notion Agent / Custom Agent** доступ к вашему компьютеру через MCP:

- **Roblox Studio** — проксирует встроенный MCP-сервер Studio (читать/править скрипты, запускать Luau, play-тест, генерация ассетов и т.д.);
- **файлы на компьютере** — чтение, поиск, листинг (и запись, если разрешить) в указанных папках;
- **веб** — загрузка страниц/JSON по URL (`web_fetch`);
- **shell** — выполнение команд (выключено по умолчанию);
- **любые другие stdio-MCP-серверы** (GitHub, Playwright, базы данных…) — добавляются в конфиг одной записью.

Зачем мост: Notion живёт в облаке и умеет подключать только **удалённые HTTPS MCP-серверы** с OAuth или заголовком-токеном, а Studio MCP и файловая система — это **локальные stdio-процессы**. Мост объединяет их в один Streamable-HTTP-эндпоинт с Bearer-токеном, а туннель (cloudflared/ngrok) делает его доступным для Notion.

```
Notion Agent ──HTTPS──▶ туннель ──▶ bridge (127.0.0.1:8787/mcp)
                                       ├─ roblox_*   → Roblox Studio MCP (stdio)
                                       ├─ fs_*       → папки из filesystem.roots
                                       ├─ web_fetch  → интернет
                                       ├─ shell_run  → команды (opt-in)
                                       └─ <name>_*   → другие stdio MCP-серверы
```

## Требования

| Что | Зачем |
|---|---|
| Notion **Business или Enterprise** | MCP-подключения доступны только на этих планах |
| Админ воркспейса включил **Settings → Connections → Manage → Enable custom MCP servers** | иначе кнопки «Add Custom MCP» не будет |
| Node.js ≥ 20 | запуск моста |
| Roblox Studio (Windows или macOS) | для инструментов `roblox_*` |
| `cloudflared` или `ngrok` | HTTPS-туннель до вашего компьютера |

## Шаг 1. Интернет для агента в Notion

Это делается в самом Notion, без моста:

1. **Settings → Notion AI → Web browsing** — включить. На большинстве планов уже включено по умолчанию.
2. На Enterprise-плане админ сначала включает **Settings → Notion AI → Enable web browsing for computer**.

После этого агент сам ищет в интернете и открывает сайты. `web_fetch` из моста — дополнение для случаев, когда нужен сырой текст страницы или JSON от API.

## Шаг 2. Включить MCP в Roblox Studio

В Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**. Studio должна быть открыта (с нужным плейсом), пока агент работает.

Документация Roblox: <https://create.roblox.com/docs/studio/mcp>

## Шаг 3. Установить и запустить мост

```bash
git clone <этот репозиторий> notion-mcp-bridge
cd notion-mcp-bridge
npm install
npm run build

cp bridge.config.example.json bridge.config.json   # Windows: copy bridge.config.example.json bridge.config.json
npm run token                                       # напечатает случайный токен — сохраните его
```

Откройте `bridge.config.json` и укажите папки, к которым агент получит доступ:

```json
"filesystem": { "roots": ["C:\\Users\\Вы\\Documents\\RobloxProjects"], "allowWrite": false }
```

Запуск (токен передаём через переменную окружения):

```bash
# Windows (PowerShell)
$env:MCP_BRIDGE_TOKEN="<ваш токен>"; npm start

# macOS / Linux
MCP_BRIDGE_TOKEN="<ваш токен>" npm start
```

В логе появится список инструментов и строка `listening on http://127.0.0.1:8787/mcp`. Если Studio закрыта или MCP в ней не включён, мост всё равно стартует, а `roblox_*` подключится при первом вызове.

## Шаг 4. Туннель

Во втором терминале:

```bash
npm run tunnel:cloudflare     # cloudflared tunnel --url http://127.0.0.1:8787
# или
npm run tunnel:ngrok          # ngrok http 8787
```

Скопируйте выданный `https://…` адрес. У быстрых туннелей адрес меняется при каждом перезапуске — для постоянного URL используйте именованный Cloudflare Tunnel или зарезервированный домен ngrok, тогда подключение в Notion не придётся обновлять.

## Шаг 5. Подключить в Notion

**Вариант А — для конкретного Custom Agent** (рекомендуется):

1. Откройте агента → **Settings → Tools & Access → Add connection → Custom MCP server**.
2. URL: `https://<адрес-туннеля>/mcp`.
3. Аутентификация: заголовок `Authorization` со значением `Bearer <ваш токен>` (мост также принимает `X-API-Key: <токен>`).
4. **Connect**.

**Вариант Б — на весь воркспейс:** **Settings → Connections → Discover → Add Custom MCP** (видна только админам и только если custom MCP разрешены).

Проверка: попросите агента «вызови bridge_status» — он должен вернуть список серверов и их состояние, а «покажи состояние Roblox Studio» вызовет `roblox_get_studio_state`.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `roblox_<tool>` | все инструменты Studio MCP: `script_read`, `multi_edit`, `script_search`, `execute_luau`, `start_stop_play`, `get_console_output`, `generate_mesh`, `insert_asset`, `screen_capture`, `save_place` и др. Каждый принимает `studio_id` (см. `roblox_list_roblox_studios`). |
| `fs_list` | дерево папки (глубина 1–5) |
| `fs_read` | текстовый файл (целиком или диапазон строк) или изображение |
| `fs_search` | поиск по имени (glob) и/или содержимому |
| `fs_write` | создать/перезаписать/дописать файл — только при `allowWrite: true` |
| `web_fetch` | текст страницы или JSON по URL |
| `shell_run` | команда в терминале — только при `shell.enabled: true` |
| `bridge_status` | состояние моста и подключённых серверов |
| `<name>_<tool>` | инструменты любого сервера из `servers` |

## Конфигурация (`bridge.config.json`)

```jsonc
{
  "host": "127.0.0.1",          // слушать только локально; наружу — через туннель
  "port": 8787,
  "path": "/mcp",
  "auth": { "token": "${MCP_BRIDGE_TOKEN}" },   // ${VAR} подставляется из окружения
  "filesystem": {
    "roots": ["..."],           // пустой список = файловые инструменты выключены
    "allowWrite": false,
    "maxFileBytes": 2000000,
    "ignore": ["node_modules", ".git", "dist", ".cache"]
  },
  "web": { "enabled": true, "allowPrivateNetwork": false, "maxChars": 60000, "timeoutMs": 20000 },
  "shell": { "enabled": false, "cwd": "...", "timeoutMs": 60000, "maxOutputChars": 40000 },
  "servers": {
    "roblox": { "preset": "roblox-studio" },      // Windows: %LOCALAPPDATA%\Roblox\mcp.bat, macOS: StudioMCP
    "github": {                                   // любой stdio MCP-сервер
      "enabled": false,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "timeoutMs": 300000
    }
  }
}
```

Переменные окружения: `MCP_BRIDGE_TOKEN`, `MCP_BRIDGE_PORT`, `MCP_BRIDGE_HOST`, `MCP_BRIDGE_CONFIG`. Флаги: `--config <путь>`, `--verbose`.

## Безопасность

- Токен обязателен: без него мост генерирует одноразовый и печатает в лог. Любой, кто знает URL туннеля **и** токен, получает всё, что разрешено в конфиге.
- Давайте доступ только к нужным папкам (`roots`), оставляйте `allowWrite: false` и `shell.enabled: false`, пока это действительно не нужно.
- Studio MCP позволяет агенту менять открытый плейс и запускать Luau — держите открытым только тот проект, с которым работаете, и регулярно сохраняйте/коммитьте.
- `web_fetch` по умолчанию не ходит в локальную сеть (`allowPrivateNetwork: false`).
- Рекомендации Notion: <https://www.notion.com/help/security-best-practices-for-agent-connections>

## Если что-то не работает

| Симптом | Причина / решение |
|---|---|
| В Notion нет «Add Custom MCP» | план не Business/Enterprise или админ не включил custom MCP servers |
| `401 Unauthorized` в логе | в Notion указан не тот токен или не тот заголовок |
| `roblox: tools unavailable … mcp.bat not found` | в Studio не включён «Enable Studio as MCP server» или Studio не установлена |
| `roblox` в состоянии `failed` в `bridge_status` | запустите Studio и вызовите инструмент ещё раз — мост переподключится |
| `filesystem.roots: directory not found` | опечатка в пути; на Windows экранируйте `\\` |
| Адрес туннеля сменился | обновите URL в подключении Notion или заведите постоянный туннель |

## Разработка

```bash
npm run dev      # запуск из исходников (tsx)
npm run check    # typecheck
npm test         # интеграционные тесты с фейковым stdio-сервером
```
