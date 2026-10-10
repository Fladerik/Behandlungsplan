// Rendert plakat.html als PNG (hochauflösend) und als A3-PDF.
// Aufruf: node save-the-date/render.js [ausgabe-ordner]
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const dir = __dirname;
  const out = process.argv[2] || dir;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1123, height: 1587 }, deviceScaleFactor: 3 });
  await page.goto("file://" + path.join(dir, "plakat.html"));
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#poster").screenshot({ path: path.join(out, "save-the-date-steelers.png") });
  // PDF aus dem PNG bauen: so sehen Druck und Bildschirm identisch aus (~290 dpi auf A3)
  const png = require("fs").readFileSync(path.join(out, "save-the-date-steelers.png")).toString("base64");
  await page.setContent(`<style>@page{size:297mm 420mm;margin:0}html,body{margin:0}img{width:297mm;height:420mm;display:block}</style><img src="data:image/png;base64,${png}">`);
  await page.pdf({ path: path.join(out, "save-the-date-steelers-A3.pdf"), width: "297mm", height: "420mm", printBackground: true });
  await browser.close();
})();
