import { test, expect } from "./helpers.js";

// Barre d'onglets en bas sur téléphone, rail latéral sur ordinateur.
const tab = (page, name) => page.locator("[data-tab]:visible", { hasText: name }).first();

test.describe("Application : logement de démonstration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
  });

  test("la recherche tolère les fautes et donne l'emplacement", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("pasport");
    const first = page.locator("button", { hasText: "Passeport" }).first();
    await expect(first).toBeVisible();
    await expect(first).toContainText("Bureau");
    await expect(page.locator("button", { hasText: "Perceuse sans fil" })).toHaveCount(0);
  });

  test("les filtres par mot-clé réduisent la liste", async ({ page }) => {
    await page.getByRole("button", { name: /^santé/ }).click();
    await expect(page.locator("button", { hasText: "Doliprane" }).first()).toBeVisible();
    await expect(page.locator("button", { hasText: "Perceuse sans fil" })).toHaveCount(0);
  });

  test("chaque onglet s'affiche", async ({ page }) => {
    await tab(page, "Mes lieux").click();
    await expect(page.getByRole("heading", { level: 1, name: "Mes lieux" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Replier Grenier" })).toBeAttached();

    await tab(page, "Scan").click();
    await expect(page.getByRole("heading", { level: 1, name: "Scan Éclair" })).toBeVisible();

    await tab(page, "Plan").click();
    await expect(page.getByRole("heading", { level: 1, name: "Votre logement" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Grenier, \d+ objets/ })).toBeVisible();

    await tab(page, "Alertes").click();
    await expect(page.getByRole("heading", { level: 1, name: "Alertes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Objets prêtés/ })).toBeVisible();
  });

  test("un objet ajouté se retrouve, et reste après rechargement", async ({ page }) => {
    await page.getByRole("button", { name: "Ajouter un objet" }).click();
    const dialog = page.getByRole("dialog", { name: "Nouvel objet" });
    await dialog.getByPlaceholder("Perceuse, passeport, guirlande…").fill("Lampe frontale test");
    await dialog.getByRole("option", { name: /^Tiroir bas/ }).click();
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await page.getByLabel("Chercher un objet").fill("lampe frontale");
    const found = page.locator("button", { hasText: "Lampe frontale test" }).first();
    await expect(found).toBeVisible();
    await expect(found).toContainText("Buffet");
  });

  test("les réglages permettent d'exporter ses données en JSON", async ({ page }) => {
    await page.getByRole("button", { name: "Réglages du foyer" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Réglages" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter en JSON" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.json$/);
    const data = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
    expect(JSON.stringify(data)).toContain("Passeport");
  });
});

test.describe("Application : création de compte", () => {
  test("inscription, assistant du logement, puis inventaire vide prêt à remplir", async ({ page }) => {
    await page.goto("/app#signup");
    await page.getByLabel("Prénom et nom").fill("Camille Test");
    await page.getByLabel("Adresse email").fill("camille@example.org");
    await page.getByLabel("Mot de passe", { exact: true }).fill("Un-mot-de-passe-solide-42");
    await page.getByRole("button", { name: "Créer mon compte gratuit" }).click();

    const next = (name) => page.getByRole("button", { name, exact: true }).click();
    await next("Choisir ma formule");
    await next("Continuer avec Libre");
    await expect(page.getByRole("heading", { name: "Vous habitez dans…" })).toBeVisible();
    await page.getByRole("button", { name: /^Un appartement/ }).click();
    await expect(page.getByRole("heading", { name: "Comment appelez-vous ce lieu ?" })).toBeVisible();
    await next("Continuer");
    await expect(page.getByRole("heading", { name: "Quelles pièces ?" })).toBeVisible();
    await next("Ajouter : Cuisine");
    await next("Ajouter : Salon");
    await next("Continuer");
    await expect(page.getByRole("heading", { name: "Précisez les noms" })).toBeVisible();
    await next("Continuer");
    await expect(page.getByRole("heading", { name: "Les meubles de rangement" })).toBeVisible();
    await next("Ajouter : Buffet");
    await next("Créer mon logement");
    await next("Ouvrir mon inventaire");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();

    // La session survit au rechargement, et le logement créé est bien là.
    await page.reload();
    await tab(page, "Mes lieux").click();
    await expect(page.getByRole("button", { name: "Replier Salon" })).toBeAttached();
    await expect(page.getByText("Buffet", { exact: true }).first()).toBeAttached();
  });

  test("une adresse déjà utilisée sur l'appareil est refusée", async ({ page }) => {
    const signup = async () => {
      await page.goto("/app#signup");
      await page.getByLabel("Prénom et nom").fill("Camille Test");
      await page.getByLabel("Adresse email").fill("double@example.org");
      await page.getByLabel("Mot de passe", { exact: true }).fill("Un-mot-de-passe-solide-42");
      await page.getByRole("button", { name: "Créer mon compte gratuit" }).click();
    };
    await signup();
    await page.getByRole("button", { name: "Choisir ma formule", exact: true }).waitFor();
    await signup();   // app#signup ferme la session ouverte, sans rien effacer
    await expect(page.getByText(/Un compte existe déjà avec cette adresse/).first()).toBeVisible();
  });
});
