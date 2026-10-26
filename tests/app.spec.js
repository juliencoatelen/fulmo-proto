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

// En ligne, app.html est servi par app.getfulmo.com, qui définit window.FulmoCloud
// avant app.js. Ici, une doublure minimale de ce pont, sans réseau.
async function fakeCloud(page, opts) {
  await page.addInitScript((o) => {
    window.__calls = [];
    const known = {
      site: "/",
      uuid: () => crypto.randomUUID(),
      initial: (blank) => Object.assign({}, blank, o.session ? {
        account: { name: "Camille Test", email: "camille@example.org", createdAt: "2026-10-01T00:00:00Z" },
        session: true, planSeen: true, tourSeen: true,
      } : {}),
      persist: () => {},
      attach: () => {},
      role: () => "admin",
      households: () => [],
      householdId: () => null,
      requestReset: (email) => { window.__calls.push(["requestReset", email]); return Promise.resolve({ ok: true }); },
      recovery: () => !!o.recovery,
      setNewPassword: (pw) => { window.__calls.push(["nouveau", pw]); return Promise.resolve(o.reset || { ok: true }); },
    };
    window.FulmoCloud = new Proxy(known, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve({ ok: true })) });
  }, opts);
}

test.describe("Application en ligne : mot de passe oublié", () => {
  test("le lien part, avec la même réponse que l'adresse ait un compte ou non", async ({ page }) => {
    await fakeCloud(page, {});
    await page.goto("/app#login");
    await page.getByRole("button", { name: "Mot de passe oublié ?" }).click();
    await expect(page.getByText(/Indiquez d'abord l'adresse de votre compte/)).toBeVisible();

    await page.getByLabel("Adresse email").fill("Camille@Example.org ");
    await page.getByRole("button", { name: "Mot de passe oublié ?" }).click();
    await page.getByRole("button", { name: "Envoyer le lien" }).click();
    await expect(page.getByText(/Si un compte Fulmo existe pour camille@example\.org/)).toBeVisible();
    expect(await page.evaluate(() => window.__calls)).toEqual([["requestReset", "camille@example.org"]]);
  });

  test("ouvert depuis le lien, on choisit un nouveau mot de passe", async ({ page }) => {
    await fakeCloud(page, { session: true, recovery: true });
    await page.goto("/app");
    const dialog = page.getByRole("dialog", { name: "Choisissez un nouveau mot de passe" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Nouveau mot de passe").fill("court");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog.getByText(/12 au minimum/)).toBeVisible();
    await dialog.getByLabel("Nouveau mot de passe").fill("Un-nouveau-mot-de-passe-42");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Nouveau mot de passe enregistré/)).toBeVisible();
    expect(await page.evaluate(() => window.__calls)).toEqual([["nouveau", "Un-nouveau-mot-de-passe-42"]]);
  });

  test("un lien expiré le dit clairement", async ({ page }) => {
    await fakeCloud(page, { session: true, recovery: true, reset: { ok: false, error: "expire" } });
    await page.goto("/app");
    const dialog = page.getByRole("dialog", { name: "Choisissez un nouveau mot de passe" });
    await dialog.getByLabel("Nouveau mot de passe").fill("Un-nouveau-mot-de-passe-42");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog.getByText(/Ce lien a expiré/)).toBeVisible();
  });
});

test.describe("Application locale : mot de passe oublié", () => {
  test("sans serveur, l'écran explique qu'aucun email ne peut partir", async ({ page }) => {
    await page.goto("/app#login");
    await page.getByRole("button", { name: "Mot de passe oublié ?" }).click();
    await expect(page.getByText("Pas de réinitialisation pendant la bêta.")).toBeVisible();
  });
});

test.describe("Application : onglet et écran d'accueil", () => {
  test("titre d'onglet, icône et nom court pour l'écran d'accueil", async ({ page, request }) => {
    await page.goto("/app#demo");
    await expect(page).toHaveTitle("Fulmo — Retrouvez tout chez vous en 2 secondes");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "assets/img/apple-touch-icon.png");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Fulmo");
    const manifest = await (await request.get("/site.webmanifest")).json();
    expect(manifest.short_name).toBe("Fulmo");
  });
});

test.describe("Fiche objet et Scan Éclair", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
  });

  test("la fiche d'un objet rangé affiche son emplacement actuel", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("passeport");
    await page.locator(".result", { hasText: "Passeport" }).first().locator(".r-name").click();
    const dialog = page.getByRole("dialog", { name: "Modifier l'objet" });
    await expect(dialog).toBeVisible();
    const current = dialog.locator(".loc-current");
    await expect(current).toContainText("Rangé dans");
    await expect(current).toContainText("Tiroir du haut");
    // La sélection est en tête de liste, marquée « Actuel ».
    const first = dialog.getByRole("option").first();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(first).toContainText("Actuel");
    // Changer reste possible, et s'annule.
    await dialog.getByRole("option", { name: /^Tiroir bas/ }).click();
    await expect(current).toContainText("Nouvel emplacement");
    await expect(current).toContainText("Avant :");
    await current.getByRole("button", { name: "Annuler" }).click();
    await expect(current).toContainText("Rangé dans");
  });

  test("une photo importée est allégée", async ({ page }) => {
    await page.getByRole("button", { name: "Ajouter un objet" }).click();
    const dialog = page.getByRole("dialog", { name: "Nouvel objet" });
    await dialog.getByPlaceholder("Perceuse, passeport, guirlande…").fill("Photo lourde test");
    // Une image de 3000 × 2000 pixels pleine de bruit : plusieurs mégaoctets en PNG.
    const png = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 3000; c.height = 2000;
      const g = c.getContext("2d");
      const data = g.createImageData(3000, 2000);
      for (let i = 0; i < data.data.length; i += 4) {
        const v = (i / 4) % 3000 / 12 + Math.random() * 40;
        data.data[i] = v; data.data[i + 1] = 255 - v; data.data[i + 2] = (v * 3) % 255; data.data[i + 3] = 255;
      }
      g.putImageData(data, 0, 0);
      return c.toDataURL("image/png").split(",")[1];
    }).then((b64) => Buffer.from(b64, "base64"));
    expect(png.length).toBeGreaterThan(2_000_000);
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Ajouter une photo" }).click();
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await expect(dialog.getByText("Photo prête")).toBeVisible();
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("fulmo.demo.v2"));
      const it = s.items.find((i) => i.name === "Photo lourde test");
      return it && it.media && it.media[0] ? it.media[0] : null;
    })).not.toBeNull();
    const photo = await page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items.find((i) => i.name === "Photo lourde test").media[0]);
    expect(["image/webp", "image/jpeg"]).toContain(photo.mime);
    expect(photo.size).toBeLessThan(700_000);
    expect(photo.thumbId).toBeTruthy();
  });

  test("après un scan, les fiches s'ouvrent une à une puis on revient au scan", async ({ page }) => {
    await tab(page, "Scan").click();
    await expect(page.getByRole("heading", { level: 1, name: "Scan Éclair" })).toBeVisible();
    await page.getByRole("button", { name: "Lancer une détection de démonstration" }).click();
    const rows = page.locator(".row-list .check");
    await expect(rows).toHaveCount(6);
    // On n'en garde que deux.
    for (let i = 2; i < 6; i++) await rows.nth(i).click();
    await page.getByRole("button", { name: "Tout enregistrer (2)" }).click();

    const first = page.getByRole("dialog", { name: "Compléter la fiche · 1/2" });
    await expect(first).toBeVisible();
    await expect(first.getByPlaceholder("Perceuse, passeport, guirlande…")).toHaveValue("Clé à molette 30 mm");
    await first.getByPlaceholder("Tiroir du haut, bac 3, étagère B…").fill("Bac rouge");
    await first.getByRole("button", { name: "Enregistrer" }).click();

    const second = page.getByRole("dialog", { name: "Compléter la fiche · 2/2" });
    await expect(second).toBeVisible();
    await second.getByRole("button", { name: "Enregistrer" }).click();
    await expect(second).toBeHidden();

    await expect(page.getByRole("heading", { level: 1, name: "Scan Éclair" })).toBeVisible();
    await expect(page.locator(".scan-saved")).toContainText("2 objets enregistrés");
    const spot = await page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items.findLast((i) => i.name === "Clé à molette 30 mm").spot);
    expect(spot).toBe("Bac rouge");
    // Une fiche du dernier scan se rouvre depuis la liste.
    await page.getByRole("button", { name: "Compléter la fiche de « Tournevis cruciforme »" }).click();
    await expect(page.getByRole("dialog", { name: "Compléter la fiche" })).toBeVisible();
  });
});

test.describe("Application : groupes d'objets", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app#demo");
    await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
  });
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items);
  // Une fiche qui en remplace une autre : l'ancienne reste un instant, le temps de sa sortie.
  const live = (page, name) => page.locator(".sheet-backdrop:not(.is-closing)").getByRole("dialog", { name });

  test("un groupe se reconnaît à son icône, et son contenu dit où il est", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("trousse de secours");
    const group = page.locator(".result.is-group", { hasText: "Trousse de secours" }).first();
    await expect(group.locator(".r-group")).toContainText("3 objets");
    await expect(group.locator(".r-gic")).toBeVisible();

    await page.getByLabel("Chercher un objet").fill("compresses");
    const member = page.locator(".result", { hasText: "Compresses stériles" }).first();
    await expect(member.locator(".r-ingroup")).toContainText("Dans « Trousse de secours »");
    await member.locator(".r-where").click();
    await expect(page.getByRole("dialog", { name: "Compresses stériles" }).locator(".where-path")).toContainText("Trousse de secours");
  });

  test("la fiche d'un groupe gère son contenu, qui suit le groupe quand il change de place", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("trousse de secours");
    await page.locator(".result.is-group").first().locator(".r-name").click();
    let sheet = live(page, "Modifier l'objet");
    await expect(sheet).toContainText("Contenu du groupe · 3 objets");

    // Retirer un objet du groupe.
    await sheet.getByRole("button", { name: "Retirer « Couverture de survie » du groupe" }).click();
    sheet = live(page, "Modifier l'objet");
    await expect(sheet).toContainText("Contenu du groupe · 2 objets");

    // Ajouter un objet existant, choisi par son nom.
    await sheet.getByRole("button", { name: "Ajouter des objets existants" }).click();
    const picker = page.getByRole("dialog", { name: "Ajouter à « Trousse de secours »" });
    await picker.getByLabel("Rechercher un objet").fill("thermo");
    await picker.getByRole("checkbox", { name: /Thermomètre/ }).click();
    await picker.getByRole("button", { name: "Ajouter au groupe (1)" }).click();
    sheet = live(page, "Modifier l'objet");
    await expect(sheet).toContainText("Contenu du groupe · 3 objets");
    await expect(sheet.locator(".grp-list")).toContainText("Thermomètre");

    // Déplacer le groupe déplace son contenu.
    await sheet.getByRole("option", { name: /^Tiroir bas/ }).click();
    await sheet.getByRole("button", { name: "Enregistrer" }).click();
    await expect(sheet).toBeHidden();
    const items = await stored(page);
    const trousse = items.find((i) => i.name === "Trousse de secours");
    const inside = items.filter((i) => i.groupId === trousse.id);
    expect(inside.map((i) => i.name).sort()).toEqual(["Compresses stériles", "Pansements assortis", "Thermomètre"]);
    for (const i of inside) expect(i.locationId).toBe(trousse.locationId);
    expect(items.find((i) => i.name === "Couverture de survie").groupId).toBeFalsy();
  });

  test("un objet rejoint un groupe depuis sa fiche, et en sort", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("passeport");
    await page.locator(".result", { hasText: "Passeport" }).first().locator(".r-name").click();
    const sheet = live(page, "Modifier l'objet");
    await sheet.getByRole("button", { name: "Ajouter à un groupe" }).click();
    const picker = page.getByRole("dialog", { name: "Ajouter « Passeport » à un groupe" });
    // Les groupes existants viennent en tête.
    await expect(picker.locator(".grp-opt").first()).toContainText("Trousse de secours");
    await picker.getByLabel("Rechercher un objet").fill("livret");
    await picker.getByRole("button", { name: /Livret de famille/ }).click();
    await expect(sheet.locator(".grp-card")).toContainText("Livret de famille");
    await sheet.getByRole("button", { name: "Enregistrer" }).click();
    await expect(sheet).toBeHidden();
    let items = await stored(page);
    const livret = items.find((i) => i.name === "Livret de famille");
    expect(items.find((i) => i.name === "Passeport").groupId).toBe(livret.id);

    // Supprimer le groupe garde son contenu, hors groupe.
    await expect(page.locator(".sheet-backdrop")).toHaveCount(0);
    await page.getByLabel("Chercher un objet", { exact: true }).fill("livret de famille");
    await page.locator(".result.is-group", { hasText: "Livret de famille" }).first().locator(".r-name").click();
    await live(page, "Modifier l'objet").getByRole("button", { name: "Supprimer cet objet" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("L'objet qu'il contient reste dans l'inventaire");
    await page.getByRole("alertdialog").getByRole("button", { name: "Supprimer" }).click();
    items = await stored(page);
    expect(items.find((i) => i.name === "Passeport").groupId).toBeFalsy();
  });

  test("un Scan Éclair peut réunir ses objets sous une même entrée", async ({ page }) => {
    await tab(page, "Scan").click();
    await page.getByRole("button", { name: "Lancer une détection de démonstration" }).click();
    const rows = page.locator(".row-list .check");
    await expect(rows).toHaveCount(6);
    for (let i = 3; i < 6; i++) await rows.nth(i).click();
    await page.getByRole("checkbox", { name: /Regrouper sous une même entrée/ }).click();
    const save = page.getByRole("button", { name: "Enregistrer le groupe (3)" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Nom du groupe").fill("Caisse à outils rouge");
    await expect(save).toBeEnabled();
    await save.click();

    const first = page.getByRole("dialog", { name: "Compléter la fiche · 1/4" });
    await expect(first.getByPlaceholder("Perceuse, passeport, guirlande…")).toHaveValue("Caisse à outils rouge");
    await expect(first).toContainText("Contenu du groupe · 3 objets");
    await first.getByRole("button", { name: "Fermer" }).click();
    await expect(page.locator(".scan-saved")).toContainText("4 objets enregistrés");

    const items = await stored(page);
    const box = items.find((i) => i.name === "Caisse à outils rouge");
    expect(items.filter((i) => i.groupId === box.id)).toHaveLength(3);
  });
});

test("la photo d'un Scan Éclair devient, allégée, celle des objets enregistrés", async ({ page }) => {
  // Un assistant factice, comme celui que l'hôte fournit : il renvoie deux objets.
  await page.addInitScript(() => {
    window.claude = {
      use: (name) => Promise.resolve(name !== "sample" ? null : {
        limits: () => Promise.resolve({ images: { mediaTypes: ["image/jpeg", "image/png", "image/webp"] } }),
        json: () => Promise.resolve({ items: [
          { name: "Lampe torche", quantity: 1, tags: ["bricolage"], confidence: "high" },
          { name: "Rouleau d'adhésif", quantity: 2, tags: ["bricolage"], confidence: "high" }
        ] })
      })
    };
  });
  await page.goto("/app#demo");
  await tab(page, "Scan").click();
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2400; c.height = 1800;
    const g = c.getContext("2d");
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 37 % 360} 70% 50%)`; g.fillRect((i * 97) % 2400, (i * 53) % 1800, 160, 120); }
    return c.toDataURL("image/png").split(",")[1];
  }).then((b64) => Buffer.from(b64, "base64"));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Prendre ou importer une photo" }).click();
  await page.getByRole("alertdialog", { name: "Utiliser l'IA ?" }).getByRole("button", { name: "J'accepte" }).click();
  await (await chooser).setFiles({ name: "etagere.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Tout enregistrer (2)" }).click();

  const sheet = page.getByRole("dialog", { name: "Compléter la fiche · 1/2" });
  await expect(sheet.locator(".media-photo img")).toBeVisible();
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Scan Éclair" })).toBeVisible();

  const photos = await page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items
    .filter((i) => i.name === "Lampe torche" || i.name === "Rouleau d'adhésif")
    .map((i) => i.media && i.media[0]));
  expect(photos).toHaveLength(2);
  for (const p of photos) {
    expect(p.kind).toBe("photo");
    expect(["image/webp", "image/jpeg"]).toContain(p.mime);
    expect(p.size).toBeLessThan(png.length);
  }
});
