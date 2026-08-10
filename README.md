# ProfitPilot MVP

Автономный прототип AI Profit Manager для продавцов Allegro и Empik.

## Informacje dla Allegro REST API

**Nazwa aplikacji:** ProfitPilot  
**Aktualna wersja:** 0.3.0  
**Właściciel:** [GlebLeonchik](https://github.com/GlebLeonchik)  
**Kontakt techniczny:** przez [GitHub Issues](https://github.com/GlebLeonchik/profitpilot/issues)

ProfitPilot to aplikacja analityczna dla sprzedawców. Pobiera po autoryzacji użytkownika dane sprzedażowe z Allegro REST API, aby obliczać rzeczywistą rentowność ofert, marżę, koszty i przygotowywać rekomendacje cenowe. Aplikacja korzysta z OAuth 2.0 Authorization Code z PKCE. Dane uwierzytelniające i tokeny są szyfrowane w lokalnej bazie użytkownika.

Identyfikator wymagany przez Allegro:

```text
ProfitPilot/0.3.0 (+https://github.com/GlebLeonchik/profitpilot)
```

## Запуск полноценного приложения

Требуется Node.js 22.5 или новее. Сторонние npm-пакеты не нужны.

```powershell
npm start
```

После этого откройте `http://localhost:8080`. При первом запуске сервер создаст `data/profitpilot.sqlite` и заполнит базу демо-данными.

Без Node.js интерфейс по-прежнему можно открыть напрямую через `index.html`; в этом случае он работает в локальном демо-режиме.

## Что уже работает

- dashboard с выручкой, чистой прибылью и маржой;
- экономика каждого SKU;
- поиск убыточных и низкомаржинальных товаров;
- рекомендации по цене и рекламным расходам;
- фильтр периода и канала продаж;
- импорт CSV и сохранение данных в браузере;
- скачивание шаблона CSV;
- адаптивный интерфейс для телефона.

## Backend API

- `GET /api/health` — состояние сервера;
- `GET /api/products?days=30` — рассчитанная экономика SKU;
- `GET /api/dashboard?days=30` — сводка и рекомендации;
- `POST /api/import/csv` — импорт CSV;
- `POST /api/demo/reset` — восстановление демо-данных;
- `GET /api/integrations` — состояние интеграций;
- `POST /api/integrations/allegro/config` — безопасная настройка приложения Allegro;
- `GET /api/auth/allegro` — начало OAuth Allegro.
- `POST /api/integrations/empik/connect` — проверка и сохранение ключа Empik;
- `POST /api/integrations/{provider}/disconnect` — отключение площадки.

## Allegro

Скопируйте `.env.example` в `.env`, задайте ключи приложения Allegro и передайте переменные окружения процессу Node. Токены OAuth хранятся в SQLite в зашифрованном виде; для постоянного ключа обязательно установите `SESSION_SECRET`.

Client ID и Client Secret также можно один раз настроить из раздела «Интеграции». Redirect URI должен точно совпадать с адресом, зарегистрированным в Allegro Developer Apps.

Allegro также требует собственный User-Agent вида `ProfitPilot/0.3.0 (+https://public-url)`. Сгенерируйте его в Developer Apps и вставьте в ту же форму настройки.

## EmpikPlace

Откройте Panel Sprzedawcy EmpikPlace → Ustawienia osobiste → Klucz API, сгенерируйте ключ и вставьте его в разделе «Интеграции». ProfitPilot проверит ключ через `/api/account` перед зашифрованным сохранением.

Формат CSV можно посмотреть в `sample-data.csv`. Все денежные расходы в файле задаются на одну проданную единицу товара.
