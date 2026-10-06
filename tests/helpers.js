// Outils communs aux tests : on échoue dès qu'une page lève une erreur JS
// ou tente de joindre un autre domaine (règle P3 : rien ne sort du navigateur).
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    const outside = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      // Les fichiers manquants sont signalés plus bas, avec leur adresse.
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && r.request().resourceType() !== "document") errors.push(`${r.status()} ${r.url()}`);
    });
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["localhost", "127.0.0.1"].includes(u.hostname) && !["data:", "blob:"].includes(u.protocol)) outside.push(r.url());
    });
    // Les liens vers l'application en ligne ne sont jamais suivis : on vérifie leur adresse.
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    await use(page);
    expect(outside, "requêtes vers un autre domaine").toEqual([]);
    expect(errors, "erreurs JavaScript dans la page").toEqual([]);
  },
});
export { expect };

// La page d'accueil construit sa scène 3D au chargement : sans carte graphique,
// le navigateur est occupé plusieurs secondes. On attend qu'elle soit prête.
export async function gotoHome(page, path = "/") {
  await page.goto(path);
  await page.waitForFunction(() => {
    const c = document.documentElement.classList;
    return c.contains("scene-ready") || c.contains("no-webgl");
  }, null, { timeout: 45_000 });
}
