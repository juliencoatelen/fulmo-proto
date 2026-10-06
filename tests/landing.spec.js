import { test, expect, gotoHome } from "./helpers.js";

test.describe("Page d'accueil", () => {
  test.beforeEach(async ({ page }) => { await gotoHome(page); });

  test("référencement : un seul H1, titre, description, canonique, données structurées", async ({ page }) => {
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page).toHaveTitle(/Fulmo/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.{50,}/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://getfulmo.com/");
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(() => JSON.parse(b)).not.toThrow();
  });

  test("la page garde sa politique de sécurité (CSP)", async ({ page }) => {
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("la recherche de démonstration trouve un objet, même avec une faute", async ({ page }) => {
    const input = page.locator("#hero-q");
    const result = page.locator("#hero-result");
    await input.fill("passeport");
    await input.press("Enter");
    await expect(result).toHaveAttribute("data-state", "found", { timeout: 20_000 });
    await expect(result.locator(".hr-name")).toHaveText(/Passeport/i);
    await expect(result.locator(".hr-path")).toContainText("/");

    await input.fill("perseuse");
    await input.press("Enter");
    await expect(result).toHaveAttribute("data-state", "found", { timeout: 20_000 });
    await expect(result.locator(".hr-name")).toHaveText(/Perceuse/i);
  });

  test("les boutons d'action mènent à l'inscription et à la démo", async ({ page }) => {
    const hero = page.locator(".hero-content");
    await expect(hero.getByRole("link", { name: /Créer mon compte gratuit/ })).toHaveAttribute("href", "https://app.getfulmo.com/inscription");
    await expect(hero.getByRole("link", { name: "Essayer la démo" })).toHaveAttribute("href", "app#demo");
  });

  test("le thème clair / sombre se change et se mémorise", async ({ page }) => {
    const toggle = page.locator(".theme-toggle:visible").first();
    if (!(await toggle.count())) { await page.locator(".nav-toggle").click(); }
    const before = await page.locator("html").getAttribute("data-theme");
    await page.locator(".theme-toggle:visible").first().click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", before || "");
    const after = await page.locator("html").getAttribute("data-theme");
    await gotoHome(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", after);
  });

  test("les liens de navigation pointent vers des sections qui existent", async ({ page }) => {
    const hrefs = await page.locator('.nav a[href^="#"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(3);
    for (const h of hrefs) await expect(page.locator(h), `cible ${h}`).toHaveCount(1);
  });
});

test.describe("Page d'accueil sur téléphone", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile uniquement");

  test("le menu s'ouvre, se ferme, et l'en-tête ne bloque pas les boutons", async ({ page }) => {
    await gotoHome(page);
    const toggle = page.locator(".nav-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#nav-panel").getByRole("link", { name: "Essayer la démo" })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Le champ de recherche reste cliquable sous l'en-tête fixe (bug corrigé le 2026-10-04).
    await page.locator("#hero-q").click();
    await expect(page.locator("#hero-q")).toBeFocused();
  });
});

test.describe("Pages annexes", () => {
  for (const path of ["/mentions-legales", "/confidentialite", "/conditions"]) {
    test(`${path} s'affiche avec un titre`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
    });
  }

  test("une adresse inconnue affiche la page 404", async ({ page }) => {
    const res = await page.goto("/cette-page-n-existe-pas");
    expect(res.status()).toBe(404);
    await expect(page.locator("body")).toContainText(/introuvable|404/i);
  });
});
