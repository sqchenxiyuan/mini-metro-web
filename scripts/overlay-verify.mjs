import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  ...(process.env.METRO_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.METRO_BROWSER_EXECUTABLE_PATH } : {}),
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.goto(process.env.METRO_TEST_URL ?? 'http://127.0.0.1:4175/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.metro);
  await page.evaluate(() => { window.metro.restart({ seed: 420, mode: 'endless' }); window.metro.pause(); window.metro.step(4100); });
  await page.waitForTimeout(150);
  const counts = await page.evaluate(() => {
    const station = window.metro.getState().stations.find((s) => s.id === 2);
    const warning = window.metro.sceneCues().ringStationIds.includes(2);
    const old = document.querySelector('[data-station="2"] .crowd-countdown');
    return { station: !!station, old: !!old, warning: !!warning };
  });
  assert.equal(counts.station, true);
  assert.equal(counts.old, false, 'warnings must not live in station hit boxes');
  const overlaps = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.station-label')];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].getBoundingClientRect(), b = nodes[j].getBoundingClientRect();
      const x0 = Math.max(a.left, b.left), y0 = Math.max(a.top, b.top),
        x1 = Math.min(a.right, b.right), y1 = Math.min(a.bottom, b.bottom);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      for (let x = x0 + 2; x < x1 - 1; x += 2) for (let y = y0 + 2; y < y1 - 1; y += 2) {
        const [u, v] = [nodes[i], nodes[j]],
          p = [window.metro.projectStation(Number(u.dataset.station)), window.metro.projectStation(Number(v.dataset.station))],
          d0 = Math.hypot(p[0].x - x, p[0].y - y), d1 = Math.hypot(p[1].x - x, p[1].y - y),
          expected = d0 < d1 ? u.dataset.station : v.dataset.station,
          top = document.elementFromPoint(x, y)?.closest('.station-label')?.dataset.station;
        if (top && expected !== top && Math.min(d0, d1) < 28 && Math.abs(d0 - d1) > 5)
          return { x, y, expected, top };
      }
    }
    return null;
  });
  assert.ok(overlaps, 'fixture must contain a station hit overlap that would select the wrong station');
  await page.mouse.click(overlaps.x, overlaps.y);
  await page.waitForTimeout(100);
  const detail = await page.locator('#station-detail').textContent();
  assert.match(detail, new RegExp(`STATION ${String(overlaps.expected).padStart(2, '0')}\\b`), `clicked ${overlaps.expected}, DOM would target ${overlaps.top}`);
  console.log(JSON.stringify({ passed: true, overlappedHit: overlaps, counts }));
} finally { await browser.close(); }
