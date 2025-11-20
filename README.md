# Cian & Avito scraper

Парсит объявления аренды Москвы (от 200 000 ₽, от собственников) с Cian и Avito. Поддерживает выгрузку ссылок в Supabase и (опционально) сохранение локальных JSON/скриншотов.

## Быстрый старт (локально)
```bash
npm install
npx playwright install chromium   # разово подтянуть браузер
cp .env.example .env              # заполните переменные
npm start
```

## Переменные окружения
- `PARSE_ALL` — true: парсить все страницы (перекрывает флаги ниже).
- `CIAN_ALL` / `AVITO_ALL` — true: идти по всем страницам соответствующего источника.
- `CIAN_PAGE` / `AVITO_PAGE` — число страниц (0 отключено, приоритетнее, чем *_ALL).
- `ITEMS_LIMIT` — лимит объявлений, если берём только первую страницу.
- `MIN_PRICE` — мин. цена (по умолчанию 200000).
- `SAVE_LOCAL` — true: сохранять `data/*.json` и скриншоты; false: ничего не пишет.
- `HEADLESS` — true|false (headless режим браузера).
- `SUPABASE_URL`, `SUPABASE_KEY` — при наличии ссылки отправляются в таблицу `owners` (поля `url`, `parsed=false`).

## Railway / Cron
1. Задайте переменные окружения (см. выше). Для Railway обычно `SAVE_LOCAL=false`, `HEADLESS=true`.
2. Установите браузер на билде (один раз): `npx playwright install chromium`.
3. Команда запуска: `npm start` (или `node src/scrape.js`).
4. Настройте Cron в Railway на эту команду — процесс сам завершится после парсинга.

## Вывод и логика
- Эмодзи-логирование, выводит добавленные ссылки.
- При `SAVE_LOCAL=true` пишет файлы: `data/results.json`, `data/results_avito.json`, `data/page_stats*.json`, скриншоты в `data/screenshots/`.
- При пустых результатах выводит только релевантные ошибки (те, что помешали собрать ссылки).

