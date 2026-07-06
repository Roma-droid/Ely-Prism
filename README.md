# Figura Ely — backend

Самостоятельный backend Figura (протокол «backend2»), который проверяет вход
игроков через **Ely.by** вместо Mojang. Написан на Node.js, зависимость всего
одна (`ws`). Не требует Minecraft-сервера.

Что реализовано:

- HTTP API Figura: `auth/id`, `auth/verify`, `version`, `limits`, `motd`,
  загрузка/скачивание/удаление аватара, `equip`, получение данных пользователя.
- Проверка входа через `hasJoined` у Ely.by (authlib-injector sessionserver).
- Бинарный WebSocket-протокол `/ws`: авторизация, **ретрансляция пингов**,
  подписки (`SUB`/`UNSUB`) и **события обновления аватара** (`EVENT`) — то есть
  живая синхронизация анимаций и смены аватаров между игроками.
- Хранение аватаров на диске (`<uuid>.avtr` + `<uuid>.json`).

## Требования

- Node.js 18+ (проверено на 26). Либо Docker.
- **Домен + TLS.** Figura подключается только по `https://` и `wss://`, поэтому
  нужен валидный сертификат. Обычный Let's Encrypt подходит — Figura добавляет
  свой CA поверх системного хранилища, а не заменяет его. Способ ниже (Caddy)
  получает и продлевает сертификат автоматически.

## Локальный тест без домена (localhost)

Домен и `FIGURA_DOMAIN` нужны только для публичного хостинга. Для проверки на
своей машине их указывать **не надо** — Figura всё равно требует `https`/`wss`,
поэтому нужен лишь локально доверенный сертификат. Скрипт делает всё за вас:
генерирует сертификат для `localhost` и импортирует его в `cacerts` той JVM,
которой ваш лаунчер запускает игру (по умолчанию — Java 21 из ElyPrismLauncher,
её использует MC 1.21.x).

```bash
cd backend
npm run dev:cert                       # сгенерировать + импортировать сертификат
#   иначе: ./scripts/dev-cert.sh /путь/до/java/lib/security/cacerts

npm start                              # берёт TLS_CERT/TLS_KEY из .env
```

`npm start` автоматически читает `.env` (там уже прописаны `HOST=0.0.0.0`,
`PORT=4000` и пути к сертификату). Проверка, что TLS поднялся:

```bash
curl --cacert certs/figura-ely.crt https://localhost:4000/api/version
# -> {"prerelease":"...","release":"..."}
```

Затем в игре в `config/figura-ely.json` пропишите `"backendHost": "localhost:4000"`
и перезапустите клиент. Откатить импорт сертификата:
`keytool -delete -alias figura-ely-localhost -keystore <путь-до-cacerts> -storepass changeit`.

> Если инстанс использует другую Java (Prism → Instance → Settings → Java), передайте
> путь к её `cacerts` первым аргументом скрипта.

## Доступ по локальной сети (друзья на том же роутере)

Тот же self-signed сертификат годится и для LAN — скрипт автоматически добавляет
в него твой локальный IP (пропускает VPN/виртуальные интерфейсы). Порядок:

1. **Хост.** Сгенерировать сертификат и поднять backend на всех интерфейсах:
   ```bash
   npm run dev:cert      # сертификат покрывает localhost + твой LAN-IP
   npm start             # HOST/PORT/TLS берутся из .env
   ```
   Убедись, что TCP-порт `4000` открыт в фаерволе хоста (если он включён:
   `sudo firewall-cmd --add-port=4000/tcp` или `sudo ufw allow 4000/tcp`).

2. **Каждый друг (один раз на ПК).** Скопировать **публичный** файл
   `backend/certs/figura-ely.crt` (НЕ `.key`) и импортировать в `cacerts` своей
   игровой JVM:
   ```bash
   keytool -importcert -noprompt -alias figura-ely \
     -file figura-ely.crt \
     -keystore <их-java>/lib/security/cacerts -storepass changeit
   # ElyPrismLauncher 1.21.x -> java/java-runtime-delta/lib/security/cacerts
   ```
   Затем поставить мод `figura-ely` рядом с Figura + Fabric API. В моде уже прошит
   `backendHost` хоста, так что править конфиг не нужно — только импорт сертификата
   и вход через Ely.by (ElyPrismLauncher / authlib-injector).

> Каждый игрок должен покрываться сертификатом по тому адресу, по которому
> подключается. Если IP хоста сменится — перегенерируй сертификат
> (`REGEN=1 npm run dev:cert`) и раздай новый `.crt` заново.

## Вариант 1. Docker + Caddy (рекомендуется, для публичного хостинга)

Автоматический HTTPS для вашего домена.

```bash
cd backend
cp .env.example .env
# впишите FIGURA_DOMAIN=ваш.домен (A/AAAA-запись должна указывать на эту машину,
# порты 80 и 443 открыты)
docker compose up -d
```

Проверка:

```bash
curl https://ваш.домен/api/version   # -> {"prerelease":"...","release":"..."}
```

В Figura укажите `server_ip = ваш.домен` (или впишите домен в `config/figura-ely.json`
мода — он сделает это сам).

## Вариант 2. Node напрямую

За вашим обратным прокси (nginx/Caddy/traefik), который отвечает за TLS:

```bash
cd backend
npm install
DATA_DIR=./data PORT=4000 npm start
```

Прокси должен направлять и обычные запросы, и WebSocket `/ws` на `127.0.0.1:4000`.
Пример для nginx:

```nginx
server {
    listen 443 ssl;
    server_name figura.example.com;
    ssl_certificate     /etc/letsencrypt/live/figura.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/figura.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # для /ws
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### Терминация TLS прямо в Node (без прокси)

Если сертификат уже есть, можно обойтись без прокси:

```bash
TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem PORT=443 npm start
```

Тогда в Figura адрес будет просто `ваш.домен` (порт 443 по умолчанию). Для
нестандартного порта используйте формат `ваш.домен:8443`.

## Настройки (переменные окружения)

| Переменная          | По умолчанию                                   | Назначение |
|---------------------|------------------------------------------------|------------|
| `HOST`              | `0.0.0.0`                                       | Интерфейс прослушивания |
| `PORT`              | `4000`                                          | Порт |
| `TLS_CERT`/`TLS_KEY`| —                                               | Прямой TLS в Node (PEM) |
| `DATA_DIR`          | `./data`                                        | Где хранить аватары |
| `ELY_HASJOINED_URL` | `.../api/authlib-injector/sessionserver/session/minecraft/hasJoined` | Эндпоинт проверки Ely.by |
| `TOKEN_TTL_MS`      | `86400000`                                       | Срок жизни токена сессии |
| `MAX_AVATAR_SIZE`   | `100000`                                         | Лимит размера аватара (байт) |
| `MAX_AVATARS`       | `10`                                             | Лимит числа аватаров |
| `DEFAULT_TRUST`     | `1`                                              | Уровень доверия по умолчанию |
| `DEBUG`             | `false`                                          | Подробные логи запросов |

> ⚠️ `ELY_HASJOINED_URL` должен указывать на **тот же** session-сервер, куда уходит
> `join` вашего клиента. При стандартном `authlib-injector=ely.by` (в т.ч.
> ElyPrismLauncher) значение по умолчанию верное.

## Проверка протокола

В комплекте есть тесты (мок Ely.by, полный цикл авторизации, загрузка/экип/
скачивание аватара, ретрансляция пингов и события по WebSocket):

```bash
npm run selftest   # проверка кодирования бинарного протокола
node test/smoke.mjs # сквозной тест HTTP + WebSocket
```

## Как это работает (кратко)

```
GET /api/auth/id?username=Ник      -> serverId (кладём в "ожидающие" сессии)
   (клиент делает joinServer к Ely.by с этим serverId)
GET /api/auth/verify?id=serverId   -> hasJoined у Ely.by -> при успехе выдаём token
WebSocket /ws, первое сообщение     -> [0x00][token]  -> сервер отвечает [0x00] (AUTH)
```

UUID берётся из ответа Ely.by `hasJoined` (`id`) и приводится к каноническому виду,
поэтому совпадает с тем, что игра показывает у игрока.
