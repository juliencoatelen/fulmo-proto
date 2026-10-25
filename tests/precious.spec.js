// Objets précieux : le lieu ne s'affiche qu'avec le mot de passe, et rien
// ne le trahit ailleurs (stockage, recherche par lieu ou mot-clé, À ranger).
import { test, expect } from "./helpers.js";

const tab = (page, name) => page.locator("[data-tab]:visible", { hasText: name }).first();
const stored = (page) => page.evaluate(() => (localStorage.getItem("fulmo.demo.v2") || "") + (localStorage.getItem("fulmo.accounts.v1") || ""));
const passport = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items.find((i) => i.name === "Passeport"));

async function protectPassport(page, password) {
  await page.getByLabel("Chercher un objet").fill("passeport");
  await page.locator(".result", { hasText: "Passeport" }).first().locator(".r-name").click();
  const dialog = page.getByRole("dialog", { name: "Modifier l'objet" });
  await dialog.getByRole("switch", { name: /Objet précieux/ }).click();
  await expect(dialog.getByText("La photo reste visible de tous")).toBeVisible();
  await dialog.getByLabel("Créer le mot de passe des objets précieux").fill(password);
  await dialog.getByLabel("Confirmer ce mot de passe").fill(password);
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("Objets précieux", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
  });

  test("le lieu est chiffré et ne se retrouve ni par lieu, ni par mot-clé", async ({ page }) => {
    await protectPassport(page, "coffre-2026");

    const item = await passport(page);
    expect(item.precious).toBe(true);
    expect(item.vault && item.vault.data).toBeTruthy();
    expect(item.locationId).toBeNull();
    for (const field of ["spot", "tags", "description", "moves"]) expect(item[field]).toBeUndefined();
    const raw = await stored(page);
    expect(raw).not.toContain("Valable jusqu'en 2031");
    expect(raw).not.toContain("coffre-2026");

    // Le nom et la photo restent dans la recherche, le lieu non.
    const card = page.locator(".result", { hasText: "Passeport" }).first();
    await expect(card).toBeVisible();
    await expect(card.locator(".r-where")).toContainText("Lieu protégé");
    await expect(card.locator(".r-photo")).toBeVisible();

    // Ni le mot-clé « papiers », ni la pièce, ni « À ranger » ne le font sortir.
    for (const q of ["papiers", "Bureau", "Tiroir du haut", "2031"]) {
      await page.getByLabel("Chercher un objet").fill(q);
      await expect(page.locator(".result", { hasText: "Passeport" })).toHaveCount(0);
    }
    await page.getByLabel("Chercher un objet").fill("");
    await expect(page.locator(".search-filters")).not.toContainText("À ranger");
  });

  test("la fiche ne s'ouvre qu'avec le bon mot de passe, à chaque fois", async ({ page }) => {
    await protectPassport(page, "coffre-2026");
    const card = page.locator(".result", { hasText: "Passeport" }).first();

    await card.locator(".r-name").click();
    const lock = page.getByRole("dialog", { name: "Passeport" });
    await expect(lock).toBeVisible();
    await expect(lock).not.toContainText("Tiroir du haut");
    await lock.getByLabel("Mot de passe des objets précieux").fill("mauvais");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    await expect(lock.getByText("Mot de passe incorrect.")).toBeVisible();

    await lock.getByLabel("Mot de passe des objets précieux").fill("coffre-2026");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    const sheet = page.getByRole("dialog", { name: "Modifier l'objet" });
    await expect(sheet.locator(".loc-current")).toContainText("Tiroir du haut");
    await expect(sheet.getByRole("switch", { name: /Objet précieux/ })).toHaveAttribute("aria-checked", "true");

    // Changer l'endroit précis : il reste chiffré.
    await sheet.getByPlaceholder("Tiroir du haut, bac 3, étagère B…").fill("Pochette bleue");
    await sheet.getByRole("button", { name: "Enregistrer" }).click();
    await expect(sheet).toBeHidden();
    expect(await stored(page)).not.toContain("Pochette bleue");

    // Fermée, la fiche se verrouille de nouveau ; le bouton du lieu ouvre le même verrou.
    await card.locator(".r-where").click();
    await expect(page.getByRole("dialog", { name: "Passeport" }).getByLabel("Mot de passe des objets précieux")).toBeVisible();
  });

  test("après cinq erreurs, une attente est imposée", async ({ page }) => {
    await protectPassport(page, "coffre-2026");
    await page.locator(".result", { hasText: "Passeport" }).first().locator(".r-name").click();
    const lock = page.getByRole("dialog", { name: "Passeport" });
    for (let i = 0; i < 5; i++) {
      await lock.getByLabel("Mot de passe des objets précieux").fill("faux-" + i);
      await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
      await expect(lock.getByRole("button", { name: "Ouvrir la fiche" })).toBeEnabled();
    }
    await expect(lock.getByRole("alert")).toContainText("réessayez dans");
    // Même le bon mot de passe attend.
    await lock.getByLabel("Mot de passe des objets précieux").fill("coffre-2026");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    await expect(lock.getByRole("alert")).toContainText("Réessayez dans");
  });

  test("retirer la protection rend le lieu, et le mot de passe se change dans les Réglages", async ({ page }) => {
    await protectPassport(page, "coffre-2026");

    // Sur téléphone, les Réglages s'ouvrent depuis l'en-tête.
    if (await tab(page, "Réglages").count()) await tab(page, "Réglages").click();
    else await page.getByRole("button", { name: "Réglages du foyer" }).click();
    await page.getByRole("button", { name: "Mot de passe" }).click();
    const change = page.getByRole("dialog", { name: "Mot de passe des objets précieux" });
    await change.getByLabel("Mot de passe actuel").fill("coffre-2026");
    await change.getByLabel("Nouveau mot de passe", { exact: false }).first().fill("tiroir-secret");
    await change.getByLabel("Confirmer le nouveau mot de passe").fill("tiroir-secret");
    await change.getByRole("button", { name: "Changer" }).click();
    await expect(change).toBeHidden();

    await tab(page, "Rechercher").click();
    await page.getByLabel("Chercher un objet").fill("passeport");
    await page.locator(".result", { hasText: "Passeport" }).first().locator(".r-name").click();
    const lock = page.getByRole("dialog", { name: "Passeport" });
    await lock.getByLabel("Mot de passe des objets précieux").fill("tiroir-secret");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    const sheet = page.getByRole("dialog", { name: "Modifier l'objet" });
    await sheet.getByRole("switch", { name: /Objet précieux/ }).click();
    await expect(sheet.getByText("son lieu redeviendra visible")).toBeVisible();
    await sheet.getByRole("button", { name: "Enregistrer" }).click();
    await expect(sheet).toBeHidden();

    const item = await passport(page);
    expect(item.precious).toBeUndefined();
    expect(item.vault).toBeUndefined();
    expect(item.locationId).toBeTruthy();
    expect(item.tags).toContain("papiers");
    await expect(page.locator(".result", { hasText: "Passeport" }).first().locator(".r-where")).toContainText("Bureau");
  });
});
