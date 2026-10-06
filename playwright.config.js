// Tests de non-régression (Playwright). Lancer : npm test
// Le site est servi tel quel par tools/serve.mjs, comme sur GitHub Pages.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Sans carte graphique, la scène 3D animée sature le processeur des machines de test :
    // on teste la version « mouvement réduit », qui affiche la même scène, figée.
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command: "node tools/serve.mjs .",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "ordinateur", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
