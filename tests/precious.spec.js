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

  test("un objet précieux n'est ni groupe ni membre : le protéger le sort de son groupe", async ({ page }) => {
    await page.getByLabel("Chercher un objet").fill("pansements");
    await page.locator(".result", { hasText: "Pansements assortis" }).first().locator(".r-name").click();
    const dialog = page.getByRole("dialog", { name: "Modifier l'objet" });
    await dialog.getByRole("switch", { name: /Objet précieux/ }).click();
    await dialog.getByLabel("Créer le mot de passe des objets précieux").fill("coffre-2026");
    await dialog.getByLabel("Confirmer ce mot de passe").fill("coffre-2026");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog).toBeHidden();

    const item = await page.evaluate(() => JSON.parse(localStorage.getItem("fulmo.demo.v2")).items.find((i) => i.name === "Pansements assortis"));
    expect(item.groupId).toBeUndefined();
    const card = page.locator(".result", { hasText: "Pansements assortis" }).first();
    await expect(card.locator(".r-where")).toContainText("Lieu protégé");
    await expect(card).not.toContainText("Trousse de secours");
  });
});

// En ligne (app.getfulmo.com), le serveur garde le lieu : une doublure de
// window.FulmoCloud.precious, sans réseau, suffit à vérifier l'interface.
async function cloudHome(page, opts) {
  await page.addInitScript((o) => {
    window.__calls = [];
    const salon = "11111111-1111-4111-8111-111111111111";
    const bague = "22222222-2222-4222-8222-222222222222";
    const item = (id, name, extra) => Object.assign({
      id, name, locationId: null, spot: null, tags: [], description: null, quantity: 1, expiresAt: null, warrantyUntil: null,
      lentTo: null, lentAt: null, lastSeenAt: null, createdAt: Date.now(), value: null, purchasedAt: null, barcode: null,
      careLabel: null, careEvery: null, careLast: null, groupId: null, precious: false,
    }, extra);
    let lock = o.lock;
    const answer = (password, then) => (password === "secret-du-foyer" ? then() : { ok: false, error: "password", wait: o.wait || 0 });
    const known = {
      site: "/",
      uuid: () => crypto.randomUUID(),
      initial: (blank) => Object.assign({}, blank, {
        account: { name: "Camille Test", email: "camille@example.org", createdAt: "2026-10-01T00:00:00Z" },
        session: true, planSeen: true, tourSeen: true, plan: "premium",
        household: { name: "La maison", type: "house", floors: 1, basement: false },
        locations: [{ id: salon, parentId: null, kind: "room", name: "Salon", icon: null, floor: 0, space: null }],
        items: [item(bague, "Bague de mamie", { precious: true }), item(crypto.randomUUID(), "Montre", { locationId: salon, spot: "commode" })],
        preciousLock: lock ? { cloud: true } : null,
      }),
      persist: () => {},
      attach: () => {},
      role: () => o.role,
      recovery: () => false,
      media: null, moves: null, ideas: null, groups: false, aiSearch: null, aiScan: null,
      households: () => [],
      householdId: () => "33333333-3333-4333-8333-333333333333",
      precious: {
        min: 8,
        lock: (input) => { window.__calls.push(["lock", input]); lock = true; return Promise.resolve({ ok: true, changed: false }); },
        open: (id, password) => { window.__calls.push(["open", id]); return Promise.resolve(answer(password, () => ({
          ok: true, moves: [], details: Object.assign(item(id, ""), { locationId: salon, spot: "sous le matelas", tags: ["bijou"] }),
        }))); },
        save: (input) => { window.__calls.push(["save", input]); return Promise.resolve(answer(input.password, () => ({ ok: true, created: false }))); },
        unprotect: (id, password) => { window.__calls.push(["unprotect", id]); return Promise.resolve(answer(password, () => ({
          ok: true, details: { locationId: salon, spot: "sous le matelas", tags: ["bijou"] },
        }))); },
      },
    };
    window.FulmoCloud = new Proxy(known, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve({ ok: true })) });
  }, opts);
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Que cherchez-vous ?" })).toBeVisible();
}

test.describe("Objets précieux en ligne", () => {
  test("le lieu vient du serveur, seulement avec le mot de passe du foyer", async ({ page }) => {
    await cloudHome(page, { role: "member", lock: true });
    await page.getByLabel("Chercher un objet").fill("bague");
    const card = page.locator(".result", { hasText: "Bague de mamie" }).first();
    await expect(card.locator(".r-where")).toContainText("Lieu protégé");

    await card.locator(".r-name").click();
    const lock = page.getByRole("dialog", { name: "Bague de mamie" });
    await lock.getByLabel("Mot de passe des objets précieux").fill("mauvais");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    await expect(lock.getByText("Mot de passe incorrect.")).toBeVisible();

    await lock.getByLabel("Mot de passe des objets précieux").fill("secret-du-foyer");
    await lock.getByRole("button", { name: "Ouvrir la fiche" }).click();
    const sheet = page.getByRole("dialog", { name: "Modifier l'objet" });
    await expect(sheet.getByPlaceholder("Tiroir du haut, bac 3, étagère B…")).toHaveValue("sous le matelas");

    // Enregistrer : le lieu part au serveur, jamais dans l'inventaire de l'interface.
    await sheet.getByPlaceholder("Tiroir du haut, bac 3, étagère B…").fill("boîte à chaussures");
    await sheet.getByRole("button", { name: "Enregistrer" }).click();
    await expect(sheet).toBeHidden();
    const calls = await page.evaluate(() => window.__calls);
    const saved = calls.find((c) => c[0] === "save")[1];
    expect(saved.password).toBe("secret-du-foyer");
    expect(saved.details.spot).toBe("boîte à chaussures");
    await expect(page.locator(".result", { hasText: "Bague de mamie" }).first().locator(".r-where")).toContainText("Lieu protégé");
    await expect(page.locator("body")).not.toContainText("boîte à chaussures");
  });

  test("un invité voit le nom, jamais le lieu, et ne peut pas l'ouvrir", async ({ page }) => {
    await cloudHome(page, { role: "guest", lock: true });
    await page.getByLabel("Chercher un objet").fill("bague");
    await page.locator(".result", { hasText: "Bague de mamie" }).first().locator(".r-name").click();
    const lock = page.getByRole("dialog", { name: "Bague de mamie" });
    await expect(lock.getByText(/rôle d'invité ne permet pas d'ouvrir/)).toBeVisible();
    await expect(lock.getByLabel("Mot de passe des objets précieux")).toHaveCount(0);
  });

  test("un admin crée le mot de passe en protégeant un premier objet", async ({ page }) => {
    await cloudHome(page, { role: "admin", lock: false });
    await page.getByLabel("Chercher un objet").fill("montre");
    await page.locator(".result", { hasText: "Montre" }).first().locator(".r-name").click();
    const dialog = page.getByRole("dialog", { name: "Modifier l'objet" });
    await dialog.getByRole("switch", { name: /Objet précieux/ }).click();
    await dialog.getByLabel("Créer le mot de passe des objets précieux").fill("court");
    await dialog.getByLabel("Confirmer ce mot de passe").fill("court");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog.getByText("Au moins 8 caractères.")).toBeVisible();
    await dialog.getByLabel("Créer le mot de passe des objets précieux").fill("secret-du-foyer");
    await dialog.getByLabel("Confirmer ce mot de passe").fill("secret-du-foyer");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(dialog).toBeHidden();
    const calls = await page.evaluate(() => window.__calls.map((c) => c[0]));
    expect(calls).toEqual(["lock", "save"]);
    await expect(page.locator(".result", { hasText: "Montre" }).first().locator(".r-where")).toContainText("Lieu protégé");
  });

  test("un membre sans mot de passe du foyer est invité à le demander à un admin", async ({ page }) => {
    await cloudHome(page, { role: "member", lock: false });
    await page.getByLabel("Chercher un objet").fill("montre");
    await page.locator(".result", { hasText: "Montre" }).first().locator(".r-name").click();
    const dialog = page.getByRole("dialog", { name: "Modifier l'objet" });
    await dialog.getByRole("switch", { name: /Objet précieux/ }).click();
    await expect(dialog.getByText(/administrateur du foyer doit d'abord créer/)).toBeVisible();
    await expect(dialog.getByLabel("Créer le mot de passe des objets précieux")).toHaveCount(0);
  });
});
