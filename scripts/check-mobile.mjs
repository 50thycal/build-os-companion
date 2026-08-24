/**
 * Mobile layout check.
 *
 * Loads every page at an iPhone viewport and fails on the two things that actually make a page
 * unusable on a phone: content wider than the screen, and tap targets a thumb misses.
 *
 * Kept out of `npm test` on purpose — it needs a browser, and the unit suite must run anywhere.
 *
 *   node scripts/check-mobile.mjs [baseUrl]
 */

let chromium, devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  console.error("This check needs Playwright: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const DEVICE = process.env.COMPANION_DEVICE ?? "iPhone 13";
/**
 * Apple's Human Interface Guidelines put the minimum at 44pt, and that is what this enforces.
 *
 * It previously failed only below 32px while citing 44 in the same breath, which meant the
 * check quietly certified something weaker than it claimed. A guideline the checker does not
 * enforce is a comment, not a check.
 */
const MIN_TAP = Number(process.env.COMPANION_MIN_TAP ?? 44);

const PAGES = [
  ["feed", "/"],
  ["needs me", "/needs-me"],
  ["projects", "/projects"],
  ["briefing", "/briefing"],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const context = await browser.newContext({ ...devices[DEVICE] });
const page = await context.newPage();

// The project page id is discovered rather than assumed, so this works against any database.
await page.goto(`${base}/projects`, { waitUntil: "domcontentloaded" });
const projectHref = await page.evaluate(() => document.querySelector('a[href^="/projects/"]')?.getAttribute("href"));
if (projectHref) PAGES.push(["project", projectHref]);

const problems = [];

for (const [name, path] of PAGES) {
  await page.goto(base + path, { waitUntil: "networkidle" });

  const report = await page.evaluate((minTap) => {
    const docWidth = document.documentElement.clientWidth;
    const tappable = [...document.querySelectorAll("a, button, summary, input")];
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: docWidth,
      overflowing: [...document.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > docWidth + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
        .slice(0, 5),
      small: tappable
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < minTap)
        .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(rect.height)}px`)
        .slice(0, 8),
    };
  }, MIN_TAP);

  if (report.scrollWidth > report.clientWidth) {
    problems.push(`${name}: scrolls horizontally (${report.scrollWidth} > ${report.clientWidth})`);
  }
  for (const el of report.overflowing) problems.push(`${name}: ${el} extends past the viewport`);
  for (const el of report.small) problems.push(`${name}: tap target under ${MIN_TAP}px — ${el}`);

  console.log(`${name.padEnd(10)} ${report.clientWidth}px wide, ${report.small.length} small targets`);
}

await browser.close();

if (problems.length > 0) {
  console.error(`\n${problems.length} layout problem(s) on ${DEVICE}:`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(`\nNo layout problems on ${DEVICE}.`);
