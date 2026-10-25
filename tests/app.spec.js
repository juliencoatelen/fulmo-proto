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
    const first = page.locator(".result", { hasText: "Passeport" }).first();
    await expect(first).toBeVisible();
    await expect(first.locator(".r-where")).toContainText("Bureau");
    await expect(page.locator("button", { hasText: "Perceuse sans fil" })).toHaveCount(0);
  });

  test("les filtres par mot-clé réduisent la liste", async ({ page }) => {
    await page.getByRole("button", { name: /^santé/ }).click();
    await expect(page.locator("button", { hasText: "Doliprane" }).first()).toBeVisible();
    await expect(page.locator("button", { hasText: "Perceuse sans fil" })).toHaveCount(0);
  });

  test("les résultats s'affichent en vitrine, avec les photos d'exemple", async ({ page }) => {
    const grid = page.locator(".r-cards.is-grid");
    await expect(grid).toBeVisible();
    const drill = page.locator(".result", { hasText: "Perceuse sans fil" }).first();
    await expect(drill.locator(".r-photo img")).toHaveAttribute("src", /\/assets\/img\/demo\/perceuse\.webp$/);
    await expect.poll(() => drill.locator(".r-photo img").evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    // Sans photo : l'icône de la pièce et l'invitation à en ajouter une.
    await page.getByLabel("Chercher un objet").fill("tournevis");
    const screwdriver = page.locator(".result", { hasText: "Tournevis cruciforme" }).first();
    await expect(screwdriver.locator(".r-photo img")).toHaveCount(0);
    await expect(screwdriver.locator(".r-addphoto")).toHaveText("Ajouter une photo");
    // Badges d'état : périmé, prêté.
    await page.getByLabel("Chercher un objet").fill("doliprane");
    await expect(page.locator(".result", { hasText: "Doliprane" }).locator(".r-badge")).toHaveText("Périmé");
  });

  test("la bascule grille / liste est retenue", async ({ page }) => {
    await page.getByRole("button", { name: "Afficher en liste" }).click();
    await expect(page.locator(".r-cards.is-list")).toBeVisible();
    await page.reload();
    await expect(page.locator(".r-cards.is-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Afficher en liste" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Afficher en grille" }).click();
    await expect(page.locator(".r-cards.is-grid")).toBeVisible();
  });

  test("l'emplacement d'une carte ouvre son chemin complet", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("passeport");
    await page.getByRole("button", { name: /^Où est Passeport/ }).click();
    const where = page.getByRole("dialog", { name: "Passeport" });
    await expect(where).toBeVisible();
    const path = where.getByRole("list", { name: "Chemin jusqu'à l'objet" });
    await expect(path.locator("li")).toHaveCount(3);
    await expect(path.locator("li").first()).toContainText("Bureau");
    await expect(path.locator("li.is-leaf")).toContainText("Tiroir du haut");
    await where.getByRole("button", { name: "Voir dans Mes lieux" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Mes lieux" })).toBeVisible();
  });

  test("le filtre par pièce se combine avec la recherche", async ({ page }) => {
    await page.locator(".room-facet").click();
    await page.getByRole("dialog", { name: "Filtrer par pièce" }).getByRole("button", { name: /^Cabanon/ }).click();
    await expect(page.locator(".r-cards .result", { hasText: "Perceuse sans fil" })).toBeVisible();
    await expect(page.locator(".r-cards .result", { hasText: "Passeport" })).toHaveCount(0);
    await page.getByLabel("Chercher un objet").fill("pince");
    await expect(page.locator(".r-cards .result", { hasText: "Pince coupante" })).toBeVisible();
    await expect(page.locator(".r-cards .result", { hasText: "Perceuse sans fil" })).toHaveCount(0);
    await page.getByRole("button", { name: "Retirer le filtre Cabanon" }).click();
    await page.getByLabel("Chercher un objet").fill("");
    await expect(page.locator(".r-cards .result", { hasText: "Passeport" })).toBeVisible();
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
    const found = page.locator(".result", { hasText: "Lampe frontale test" }).first();
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

test.describe("Application : outils pratiques", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
  });

  test("le lien d'une étiquette QR ouvre le contenu du meuble", async ({ page }) => {
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).locations.find((l) => l.name === "Servante à outils").id);
    await page.goto("/app#lieu=" + encodeURIComponent(id));
    const sheet = page.getByRole("dialog", { name: "Servante à outils" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".place-item").first()).toBeVisible();
  });

  test("l'inventaire s'exporte en tableur, avec la valeur des objets", async ({ page }) => {
    await page.getByRole("button", { name: "Réglages du foyer" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
    expect(text.split("\n")[0]).toContain("Prix d'achat");
    expect(text).toContain("Perceuse sans fil");
  });

  test("une idée proposée apparaît dans la boîte à idées", async ({ page }) => {
    await page.getByRole("button", { name: "Réglages du foyer" }).click();
    await page.locator(".set-row", { hasText: "Boîte à idées" }).getByRole("button", { name: "Ouvrir" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Boîte à idées" })).toBeVisible();
    await page.getByRole("button", { name: "Proposer une idée" }).click();
    await page.getByPlaceholder("Ex. : retrouver un objet par sa couleur").fill("Trier les objets par couleur");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await expect(page.locator(".idea", { hasText: "Trier les objets par couleur" })).toBeVisible();
  });
});

test.describe("Application : nouveautés", () => {
  test("un habitué voit les nouveautés une fois, puis leur visite pas à pas", async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
    // Un visiteur neuf n'est pas dérangé : la visite guidée lui présente déjà tout.
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog", { name: "Nouveau dans Fulmo" })).toHaveCount(0);

    // Un habitué (visite déjà vue) arrive après la mise à jour.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("fulmo.demo.v2"));
      s.tourSeen = true;
      localStorage.setItem("fulmo.demo.v2", JSON.stringify(s));
      localStorage.removeItem("fulmo.news");
    });
    await page.reload();
    const news = page.getByRole("dialog", { name: "Nouveau dans Fulmo" });
    await expect(news).toBeVisible();
    await news.getByRole("button", { name: "Découvrir en 1 minute" }).click();

    const visit = page.locator(".tour-bubble");
    await expect(visit.getByRole("heading", { name: "Une minute pour les nouveautés" })).toBeVisible();
    for (let i = 0; i < 10; i++) {
      const done = visit.getByRole("button", { name: "Terminer" });
      if (await done.isVisible()) { await done.click(); break; }
      await visit.locator(".tour-next").click();
      await page.waitForTimeout(150);
    }
    await expect(page.locator(".tour")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("[data-tab]:visible").first()).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog", { name: "Nouveau dans Fulmo" })).toHaveCount(0);
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
