import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const envBool = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
};

const MIN_PRICE = Number(process.env.MIN_PRICE || 200000);
const SAVE_LOCAL = envBool('SAVE_LOCAL', false);
const HEADLESS = envBool('HEADLESS', true);
const AVITO_URL =
  process.env.AVITO_URL ||
  `https://www.avito.ru/moskva/kvartiry/sdam/na_dlitelnyy_srok-ASgBAgICAkSSA8gQ8AeQUg?f=ASgBAgECAkSSA8gQ8AeQUgFFxpoMFnsiZnJvbSI6${MIN_PRICE},%22to%22:0}&s=104&user=1`;

const DATA_DIR = path.join(process.cwd(), 'data');
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const AVITO_CARD_SELECTOR = '[data-marker="item"]';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : null;

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

function randomPause(min = 200, max = 800) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanScroll(page) {
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, page.viewportSize().height * 0.6);
    await page.waitForTimeout(randomPause());
  }
}

async function waitForResultsAvito(page, selector = AVITO_CARD_SELECTOR) {
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, selector, {
    timeout: 90000
  });
  await humanScroll(page);
}

async function collectAvitoCards(page) {
  const items = await page.$$eval(AVITO_CARD_SELECTOR, (cards) =>
    cards.map((card) => {
      const linkEl = card.querySelector('a[data-marker="item-title"]') || card.querySelector('a[itemprop="url"]');
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

async function pushLinksToSupabase(source, links) {
  if (!supabase) {
    log('info', `${source}: Supabase не настроен, пропускаю.`);
    return;
  }
  const rows = links.filter(Boolean).map((url) => ({ url, parsed: false }));
  if (!rows.length) {
    log('warn', `${source}: нечего отправлять в Supabase.`);
    return;
  }

  const urls = rows.map((r) => r.url);
  const { data: existing, error: selErr } = await supabase.from('owners').select('url').in('url', urls);
  if (selErr) {
    log('err', `${source}: ошибка Supabase select: ${selErr.message}`);
    return;
  }
  const exists = new Set(existing?.map((r) => r.url) || []);
  const newRows = rows.filter((r) => !exists.has(r.url));
  if (!newRows.length) {
    log('info', `${source}: все ссылки уже есть в Supabase.`);
    return;
  }

  const { error } = await supabase.from('owners').insert(newRows);
  if (error) {
    log('err', `${source}: ошибка Supabase insert: ${error.message}`);
    return;
  }
  log('ok', `${source}: отправлено в Supabase ${newRows.length} новых ссылок (всего собрали ${rows.length})`);
}

async function main() {
  const mobileUrl = (() => {
    try {
      const u = new URL(AVITO_URL);
      u.host = 'm.avito.ru';
      return u.toString();
    } catch {
      return AVITO_URL.replace('www.avito.ru', 'm.avito.ru');
    }
  })();

  const browser = await chromium.launch({ headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow'
  });
  const page = await context.newPage();
  log('start', 'AVITO mobile: запускаю браузер...');

  log('info', 'AVITO mobile: открываю главную...');
  await page.goto('https://m.avito.ru/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await humanScroll(page);
  await page.waitForTimeout(randomPause(800, 1500));

  log('info', `AVITO mobile: открываю ленту...`);
  await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(randomPause(600, 1200));

  let cards;
  try {
    await waitForResultsAvito(page, AVITO_CARD_SELECTOR);
    await humanScroll(page);
    cards = await collectAvitoCards(page);
  } catch (err) {
    log('err', `AVITO mobile: не дождался карточек: ${err.message}`);
    if (SAVE_LOCAL) {
      await fs.mkdir(SHOTS_DIR, { recursive: true }).catch(() => {});
      const shot = path.join(SHOTS_DIR, `avito_mobile_timeout_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log('warn', `AVITO mobile: скриншот ${shot}`);
    }
    const text = await page.$eval('body', (el) => el.innerText || '').catch(() => '');
    if (text) log('warn', `AVITO mobile текст (обрезано): ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    await browser.close();
    return;
  }

  const links = cards.map((c) => c.link).filter(Boolean);
  log('ok', `AVITO mobile: собрано ${cards.length} объявлений`);
  links.forEach((l) => log('info', `🔗 ${l}`));
  await pushLinksToSupabase('AVITO mobile', links);
  await browser.close();
  log('ok', 'AVITO mobile: браузер закрыт.');
}

main().catch((err) => {
  log('err', `AVITO mobile ошибка: ${err.message}`);
  process.exitCode = 1;
});
