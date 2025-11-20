import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const envBool = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
};

const MIN_PRICE = Number(process.env.MIN_PRICE || 200000);
const SEARCH_URL =
  process.env.CIAN_URL ||
  `https://www.cian.ru/cat.php?deal_type=rent&engine_version=2&offer_type=flat&region=1&minprice=${MIN_PRICE}&is_by_homeowner=1&sort=creation_date_desc`;
const CIAN_SEARCH_URL = SEARCH_URL;
const AVITO_SEARCH_URL =
  process.env.AVITO_URL ||
  `https://www.avito.ru/moskva/kvartiry/sdam/na_dlitelnyy_srok?user=1&pmin=${MIN_PRICE}&s=104`;

const DATA_DIR = path.join(process.cwd(), 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'results.json');
const STATS_FILE = path.join(DATA_DIR, 'page_stats.json');
const OUTPUT_AVITO = path.join(DATA_DIR, 'results_avito.json');
const STATS_AVITO = path.join(DATA_DIR, 'page_stats_avito.json');
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');

const CARD_SELECTOR = '[data-testid="offer-card"]';
const CIAN_CARD_SELECTOR = CARD_SELECTOR;
const AVITO_CARD_SELECTOR = '[data-marker="item"]';

const PARSE_ALL = envBool('PARSE_ALL', false);
const CIAN_ALL = PARSE_ALL || envBool('CIAN_ALL', false);
const CIAN_PAGE = Number(process.env.CIAN_PAGE || 0); // 0 — выключено, >0 — жёстко заданное число страниц
const AVITO_ALL = PARSE_ALL || envBool('AVITO_ALL', false);
const AVITO_PAGE = Number(process.env.AVITO_PAGE || 0);
const ITEMS_LIMIT = Number(process.env.ITEMS_LIMIT || 5); // общий лимит для первой страницы, если не идём по всем
const SAVE_LOCAL = envBool('SAVE_LOCAL', false);
const HEADLESS = envBool('HEADLESS', true);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : null;

async function ensureCleanOutput() {
  if (!SAVE_LOCAL) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.rm(OUTPUT_FILE, { force: true });
  await fs.rm(OUTPUT_AVITO, { force: true });
  await fs.rm(STATS_FILE, { force: true }).catch(() => {});
  await fs.rm(STATS_AVITO, { force: true }).catch(() => {});
  await fs.rm(SHOTS_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(SHOTS_DIR, { recursive: true });
}

async function waitForResults(page) {
  await page.waitForFunction(
    () => !location.href.includes('showcaptcha') && document.querySelectorAll('[data-testid="offer-card"]').length > 0,
    { timeout: 300000 }
  );
  await humanScroll(page);
}

async function waitForResultsAvito(page, selector = AVITO_CARD_SELECTOR) {
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, selector, {
    timeout: 300000
  });
  await humanScroll(page);
}

async function dumpPageState(page, label = 'PAGE') {
  try {
    const url = page.url();
    const title = await page.title();
    const bodyText = await page.$eval('body', (el) => el.innerText || '').catch(() => '');
    log('warn', `${label} состояние: ${url} | ${title}`);
    if (bodyText) {
      const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 500);
      log('warn', `${label} текст (обрезано): ${snippet}`);
    }
  } catch {
    // ignore diagnostics failures
  }
}

async function autoScroll(page, targetCount = 60, selector = CARD_SELECTOR) {
  let previousHeight = 0;
  for (let i = 0; i < 40; i += 1) {
    const cardsCount = await page.$$eval(selector, (nodes) => nodes.length);
    if (cardsCount >= targetCount) break;
    const nextHeight = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
      return document.body.scrollHeight;
    });
    if (nextHeight === previousHeight) break;
    previousHeight = nextHeight;
    await page.waitForTimeout(randomPause(500, 1200));
    await page.mouse.move(
      Math.random() * page.viewportSize().width,
      Math.random() * page.viewportSize().height,
      { steps: 5 }
    );
  }
}

async function collectCards(page) {
  const items = await page.$$eval(CARD_SELECTOR, (cards) =>
    cards.map((card) => {
      const linkEl =
        card.querySelector('a[href*="/rent/flat/"]') ||
        card.querySelector('a[data-name="LinkArea"]');
      const priceEl = card.querySelector('[data-mark="MainPrice"]');
      const addressEl = card.querySelector('[data-name="GeoLabel"]');
      const descriptionEl = card.querySelector('[data-name="Description"]');
      const subtitleEl = card.querySelector('[data-mark="OfferSubtitle"]');
      const titleEl = card.querySelector('[data-name="TitleComponent"]');
      const infoEl = card.querySelector('[data-mark="AdditionalInfo"]');

      const cleanup = (value) => value?.replace(/\s+/g, ' ').trim() || null;

      return {
        title: cleanup(titleEl?.textContent || linkEl?.textContent),
        link: linkEl?.href || null,
        price: cleanup(priceEl?.textContent),
        address: cleanup(addressEl?.textContent),
        details: cleanup(infoEl?.textContent),
        owner: cleanup(subtitleEl?.textContent),
        description: cleanup(descriptionEl?.textContent)
      };
    })
  );

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.link || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

const collectCianCards = collectCards;

async function collectAvitoCards(page) {
  const items = await page.$$eval(AVITO_CARD_SELECTOR, (cards) =>
    cards.map((card) => {
      const linkEl = card.querySelector('a[data-marker="item-title"]');
      const priceEl =
        card.querySelector('[data-marker="item-price"]') ||
        card.querySelector('meta[itemprop="price"]');
      const titleEl = linkEl;
      const addressEl = card.querySelector('[data-marker="item-address"]');
      const descriptionEl = card.querySelector('[data-marker="item-description"]');
      const cleanup = (value) => value?.replace(/\s+/g, ' ').trim() || null;
      const href = linkEl?.href || linkEl?.getAttribute('href') || null;
      const absolute =
        href && href.startsWith('http')
          ? href
          : href
          ? `https://www.avito.ru${href}`
          : null;

      const priceRaw = priceEl?.getAttribute('content') || priceEl?.textContent || '';
      const numericPrice = parseInt(priceRaw.replace(/\D+/g, ''), 10) || null;

      return {
        title: cleanup(titleEl?.textContent),
        link: absolute,
        price: cleanup(priceEl?.textContent || priceEl?.getAttribute('content')),
        priceValue: numericPrice,
        address: cleanup(addressEl?.textContent),
        description: cleanup(descriptionEl?.textContent)
      };
    })
  );

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (item.priceValue !== null && item.priceValue < MIN_PRICE) continue;
    const key = item.link || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function getPaginationInfo(page) {
  // Возвращает href для "Дальше" и максимальную страницу в пагинации.
  return page.evaluate(() => {
    const nav = document.querySelector('nav[data-name="Pagination"]');
    if (!nav) return { nextHref: null, maxPage: 1 };
    let maxPage = 1;
    const pageButtons = nav.querySelectorAll('li button, li a');
    pageButtons.forEach((el) => {
      const num = parseInt(el.textContent.trim(), 10);
      if (!Number.isNaN(num)) maxPage = Math.max(maxPage, num);
    });
    const nextLink = [...nav.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Дальше');
    const nextHref = nextLink?.href || nextLink?.getAttribute('href') || null;
    return { nextHref, maxPage };
  });
}
async function getChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function randomPause(min = 200, max = 800) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(kind, message) {
  const icons = {
    start: '🚀',
    info: 'ℹ️',
    ok: '✅',
    warn: '⚠️',
    err: '❌'
  };
  const prefix = icons[kind] || '•';
  console.log(`${prefix} ${message}`);
}

function attachErrorLogging(page, bucket) {
  page.on('pageerror', (err) => {
    const msg = err.message || String(err);
    // Глушим шумные внутренние ошибки React
    if (msg.includes('Minified React error #418') || msg.includes('Minified React error #423')) return;
    bucket.push(`Ошибка на странице: ${msg}`);
  });
  // Пропускаем requestfailed, чтобы не шуметь по трекерам/рекламе
}

async function humanScroll(page) {
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, page.viewportSize().height * 0.6);
    await page.waitForTimeout(randomPause());
  }
}

async function pushLinksToSupabase(source, links) {
  if (!supabase) {
    log('info', `${source}: Supabase не настроен, пропускаю выгрузку.`);
    return;
  }
  const rows = links.filter(Boolean).map((url) => ({ url, parsed: false }));
  if (!rows.length) {
    log('warn', `${source}: нечего отправлять в Supabase.`);
    return;
  }
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('owners')
      .upsert(chunk, { onConflict: 'url', ignoreDuplicates: true });
    if (error) {
      log('err', `${source}: ошибка Supabase insert: ${error.message}`);
      return;
    }
  }
  log('ok', `${source}: отправлено в Supabase ${rows.length} ссылок`);
}

async function runCian() {
  const collectedErrors = [];
  const pageSummaries = [];
  const chromePath = await getChromePath();
  log('start', 'CIAN: запускаю браузер...');
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: chromePath,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  const page = await context.newPage();
  attachErrorLogging(page, collectedErrors);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  log('info', 'CIAN: открываю ленту...');
  await page.goto(CIAN_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((err) => {
    throw new Error(`Не удалось открыть страницу: ${err.message}`);
  });

  if (page.url().includes('showcaptcha')) {
    log('warn', 'CIAN: капча. Решите вручную, скрипт подождёт появления карточек.');
  }

  const seen = new Set();
  const allCards = [];
  let pageIndex = 1;
  let maxPageSeen = 1;
  let targetPages = CIAN_PAGE > 0 ? CIAN_PAGE : CIAN_ALL ? Infinity : 1;
  const perPageTarget = CIAN_PAGE === 0 && !CIAN_ALL ? ITEMS_LIMIT : 60;

  while (pageIndex <= targetPages) {
    log('info', `CIAN: страница ${pageIndex}: жду карточки...`);
    await waitForResults(page);
    log('info', `CIAN: страница ${pageIndex}: скроллю и собираю...`);
    await autoScroll(page, perPageTarget, CIAN_CARD_SELECTOR);
    if (SAVE_LOCAL) {
      await page.screenshot({
        path: path.join(SHOTS_DIR, `cian_page_${pageIndex}.png`),
        fullPage: true
      });
    }
    const cards = await collectCianCards(page);
    const addedLinks = [];
    for (const card of cards) {
      const key = card.link || card.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allCards.push(card);
      if (card.link) addedLinks.push(card.link);
      if (CIAN_PAGE === 0 && !CIAN_ALL && allCards.length >= ITEMS_LIMIT) {
        break;
      }
    }
    pageSummaries.push({ page: pageIndex, added: addedLinks });

    if (CIAN_PAGE === 0 && !CIAN_ALL && allCards.length >= ITEMS_LIMIT) {
      break;
    }

    const { nextHref, maxPage } = await getPaginationInfo(page);
    maxPageSeen = Math.max(maxPageSeen, maxPage);

    if (CIAN_PAGE > 0 && CIAN_PAGE > maxPageSeen) {
      throw new Error(`Запрошено страниц: ${CIAN_PAGE}, доступно: ${maxPageSeen}. Такой страницы нет.`);
    }

    if (!nextHref) break;
    pageIndex += 1;
    if (pageIndex > targetPages) break;
    const absolute = nextHref.startsWith('http') ? nextHref : `https://www.cian.ru${nextHref}`;
    log('info', `CIAN: переход на страницу ${pageIndex}: ${absolute}`);
    await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  const links = allCards.map((c) => c.link).filter(Boolean);

  if (SAVE_LOCAL) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(allCards, null, 2), 'utf8');
    const stats = {
      totalLinks: allCards.length,
      pagesVisited: pageSummaries.length,
      perPage: pageSummaries
    };
    await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
    log('ok', `CIAN: сохранено ${allCards.length} объявлений -> ${OUTPUT_FILE}`);
  } else {
    log('ok', `CIAN: собрано ${allCards.length} объявлений`);
  }

  links.forEach((link) => log('info', `🔗 ${link}`));

  if (allCards.length === 0 && collectedErrors.length > 0) {
    collectedErrors.forEach((msg) => log('err', msg));
  }

  await pushLinksToSupabase('CIAN', links);
  await browser.close();
  log('ok', 'CIAN: браузер закрыт.');

  return {
    logSummary: `CIAN итого: ${allCards.length} ссылок, страниц ${pageSummaries.length}`
  };
}

async function getPaginationInfoAvito(page) {
  return page.evaluate(() => {
    const next =
      document.querySelector('a[data-marker="pagination-button/nextPage"]') ||
      document.querySelector('.pagination-page.js-last');

    const pageNums = Array.from(
      document.querySelectorAll('[data-marker^="pagination-button/page("], .pagination-pages a.pagination-page')
    )
      .map((el) => {
        const val = el.getAttribute('data-value') || el.textContent;
        return parseInt(val.trim(), 10);
      })
      .filter((n) => !Number.isNaN(n));

    const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
    const nextHref = next?.href || next?.getAttribute('href') || null;
    return { nextHref, maxPage };
  });
}

async function runAvito() {
  const collectedErrors = [];
  const pageSummaries = [];
  const chromePath = await getChromePath();
  log('start', 'AVITO: запускаю браузер...');
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: chromePath
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  const page = await context.newPage();
  attachErrorLogging(page, collectedErrors);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  log('info', `AVITO: открываю ленту (мин. цена ${MIN_PRICE})...`);
  await page.goto(AVITO_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((err) => {
    throw new Error(`Не удалось открыть страницу: ${err.message}`);
  });

  const seen = new Set();
  const allCards = [];
  let pageIndex = 1;
  let maxPageSeen = 1;
  let targetPages = AVITO_PAGE > 0 ? AVITO_PAGE : AVITO_ALL ? Infinity : 1;
  const perPageTarget = AVITO_PAGE === 0 && !AVITO_ALL ? ITEMS_LIMIT : 60;

  while (pageIndex <= targetPages) {
    log('info', `AVITO: страница ${pageIndex}: жду карточки...`);
    try {
      await waitForResultsAvito(page, AVITO_CARD_SELECTOR);
    } catch (err) {
      collectedErrors.push(`Не дождался карточек на Avito (страница ${pageIndex}): ${err.message}`);
      await dumpPageState(page, 'AVITO');
      break;
    }
    log('info', `AVITO: страница ${pageIndex}: скроллю и собираю...`);
    await autoScroll(page, perPageTarget, AVITO_CARD_SELECTOR);
    if (SAVE_LOCAL) {
      await page.screenshot({
        path: path.join(SHOTS_DIR, `avito_page_${pageIndex}.png`),
        fullPage: true
      });
    }
    const cards = await collectAvitoCards(page);
    const addedLinks = [];
    for (const card of cards) {
      const key = card.link || card.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allCards.push(card);
      if (card.link) addedLinks.push(card.link);
      if (AVITO_PAGE === 0 && !AVITO_ALL && allCards.length >= ITEMS_LIMIT) {
        break;
      }
    }
    pageSummaries.push({ page: pageIndex, added: addedLinks });

    if (AVITO_PAGE === 0 && !AVITO_ALL && allCards.length >= ITEMS_LIMIT) {
      break;
    }

    const { nextHref, maxPage } = await getPaginationInfoAvito(page);
    maxPageSeen = Math.max(maxPageSeen, maxPage);

    if (AVITO_PAGE > 0 && AVITO_PAGE > maxPageSeen) {
      throw new Error(`Запрошено страниц: ${AVITO_PAGE}, доступно: ${maxPageSeen}. Такой страницы нет.`);
    }

    if (!nextHref) break;
    pageIndex += 1;
    if (pageIndex > targetPages) break;
    const absolute = nextHref.startsWith('http') ? nextHref : `https://www.avito.ru${nextHref}`;
    log('info', `AVITO: переход на страницу ${pageIndex}: ${absolute}`);
    await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  const links = allCards.map((c) => c.link).filter(Boolean);

  if (SAVE_LOCAL) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_AVITO, JSON.stringify(allCards, null, 2), 'utf8');
    const stats = {
      totalLinks: allCards.length,
      pagesVisited: pageSummaries.length,
      perPage: pageSummaries
    };
    await fs.writeFile(STATS_AVITO, JSON.stringify(stats, null, 2), 'utf8');
    log('ok', `AVITO: сохранено ${allCards.length} объявлений -> ${OUTPUT_AVITO}`);
  } else {
    log('ok', `AVITO: собрано ${allCards.length} объявлений`);
  }

  links.forEach((link) => log('info', `🔗 ${link}`));

  if (allCards.length === 0 && collectedErrors.length > 0) {
    collectedErrors.forEach((msg) => log('err', msg));
  }

  await pushLinksToSupabase('AVITO', links);
  await browser.close();
  log('ok', 'AVITO: браузер закрыт.');

  return {
    logSummary: `AVITO итого: ${allCards.length} ссылок, страниц ${pageSummaries.length}`
  };
}

async function run() {
  await ensureCleanOutput();
  const reports = [];

  const cianResult = await runCian().catch((err) => {
    log('err', `CIAN ошибка: ${err.message}`);
    return null;
  });
  if (cianResult) reports.push(cianResult.logSummary);

  const avitoResult = await runAvito().catch((err) => {
    log('err', `AVITO ошибка: ${err.message}`);
    return null;
  });
  if (avitoResult) reports.push(avitoResult.logSummary);

  reports.forEach((r) => log('ok', r));
}

run().catch(async (err) => {
  log('err', `Ошибка: ${err.message}`);
  process.exitCode = 1;
});

process.on('unhandledRejection', (err) => {
  log('err', `Unhandled rejection: ${err?.message || err}`);
});
process.on('uncaughtException', (err) => {
  log('err', `Uncaught exception: ${err?.message || err}`);
});
