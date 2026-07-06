# Figura Ely

**Играй с аватарами [Figura](https://modrinth.com/mod/figura), заходя под аккаунтом [Ely.by](https://ely.by).**

> **English (short).** Figura Ely lets you use **Figura** avatars while you are
> logged in with an **Ely.by** account. Figura's official backend only accepts
> Mojang/Microsoft authentication, so this client mod points Figura at an
> Ely.by‑compatible backend that verifies you through Ely.by instead. Just install
> it next to Figura and Fabric API, launch the game with Ely.by auth
> (authlib‑injector / ElyPrismLauncher) — and your avatar works. Client‑side only.

---

## Зачем это нужно

Figura проверяет владельца аккаунта через сессионные серверы **Mojang**. Если ты
играешь под **Ely.by** (offline‑экосистема, authlib‑injector), официальный backend
Figura тебя не пропускает — аватар не грузится и не виден другим.

**Figura Ely** это чинит: мод перенаправляет Figura на backend, который проверяет
вход через **Ely.by** (`hasJoined` у Ely.by, а не у Mojang). По умолчанию
используется публичный backend, так что ничего настраивать не нужно — поставил и
играешь.

## Как это работает

1. Ты запускаешь игру под аккаунтом Ely.by (через authlib‑injector — например,
   ElyPrismLauncher). Значит, проверка входа Figura (`joinServer`) уже уходит на
   серверы Ely.by.
2. Мод подставляет Figura адрес Ely.by‑совместимого backend'а вместо официального.
3. Backend подтверждает твой вход у Ely.by и выдаёт токен. Аватары грузятся,
   синхронизируются и видны всем, кто пользуется тем же backend'ом.

Мод чисто **клиентский**, не трогает игровую сессию и общается с Figura через
рефлексию — поэтому продолжает работать при обновлениях Figura, а если что‑то
однажды поменяется внутри Figura, он просто напишет в лог, как выставить адрес
вручную, и не сломает игру.

## Требования

| | |
|---|---|
| **Загрузчик** | Fabric (Fabric Loader 0.16+) |
| **Minecraft** | 1.21.x |
| **Java** | 21+ |
| **Зависимости** | [Figura](https://modrinth.com/mod/figura) и [Fabric API](https://modrinth.com/mod/fabric-api) (обязательны) |
| **Аккаунт** | вход через **Ely.by** с [authlib‑injector](https://docs.ely.by/ru/authlib-injector.html) (проще всего — **ElyPrismLauncher**) |

> Без входа через Ely.by мод бессмысленен: backend проверяет тебя именно у Ely.by.
> Обычный Microsoft‑аккаунт нужно использовать с обычной Figura.

## Установка

1. Установи **Fabric Loader**, **Fabric API** и **Figura**.
2. Положи `figura-ely-x.y.z.jar` в папку `mods/`.
3. Запусти игру под аккаунтом **Ely.by** (authlib‑injector / ElyPrismLauncher).
4. Готово. Надевай аватар — другие игроки с этим же модом увидят его.

## Настройка (необязательно)

При первом запуске создаётся файл `config/figura-ely.json`:

```json
{
  "enabled": true,
  "backendHost": "ai.bobef.ru"
}
```

- **`enabled`** — выключатель мода (`false` → Figura остаётся на официальном backend'е).
- **`backendHost`** — адрес Ely.by‑совместимого backend'а. Можно указать свой,
  в том числе с портом: `"myhost.example:8443"`.

После изменения файла перезапусти игру.

## Свой backend

Публичный backend по умолчанию — общий «островок»: аватары видны только тем, кто
сидит на том же адресе, и он не связан с основной сетью Figura. Если хочешь полный
контроль (свой сервер, своя компания, локальная сеть) — можно поднять backend
самостоятельно (Node.js, Docker + авто‑HTTPS или самоподписанный TLS для LAN) и
прописать его в `backendHost`. Исходники backend'а и мода — по ссылке **Source** на
этой странице.

Для self‑hosted backend'а с **самоподписанным** сертификатом мод умеет добавлять
доверие автоматически: положи `config/figura-ely.crt` рядом с конфигом (или собери
jar со вшитым сертификатом) — мод импортирует его в доверенные для игровой JVM при
запуске. Для публичного домена с обычным сертификатом (Let's Encrypt) это не нужно.

## Ограничения

- Видят аватары друг друга только те, у кого **один и тот же** `backendHost`.
- Это отдельная надстройка, **не** связанная с основной сетью Figura.
- Нужен вход через Ely.by — на Microsoft/Mojang‑аккаунтах смысла нет.

## Дисклеймер

Неофициальный проект. Не связан с командой **Figura** и с **Ely.by**. Figura, Fabric
и Ely.by принадлежат их авторам. Лицензия мода — **MIT**.
