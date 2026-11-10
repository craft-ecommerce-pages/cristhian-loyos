// Genera data/catalog.json (documento nativo del panel), data/config.json y data/sedes.json
// a partir de la carta real extraída de la media del cliente (PDF de desayunos + imágenes de carta).
// Uso: node scripts/catalog-build.mjs
//
// Reglas:
// - Los precios salen de la carta; no se inventan. Los montos se guardan como string "0.00" igual que el CRM.
// - Cada producto lleva report_category fijo (sushi|fastfood|tradicional|postres), congelado por línea de pedido.
// - Las categorías visibles son subcategorías (Sushi · Rollos fríos, Fast food · Alitas, …).
// - Las imágenes se publican como rutas relativas `/media/panel/<slug>/products/<archivo>`
//   servidas por el Worker del cliente desde su binding R2. Este script deja el mapa base;
//   ejecutar después `scripts/catalog-media.mjs` para enlazar fotos reales y generadas.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Origen público de la media. Vacío = rutas relativas `/media/<key>` servidas por el
// Worker del cliente desde su binding R2 (workers.dev o dominio propio). Si se usa un
// host de media dedicado, exportar MEDIA_ORIGIN="https://media.cliente.com".
// Regenerar con:
//   MEDIA_ORIGIN="" CLIENT_SLUG="cristhian-loyos" node scripts/catalog-build.mjs
const MEDIA_ORIGIN = (process.env.MEDIA_ORIGIN || "").replace(/\/+$/, "");
const CLIENT_SLUG = process.env.CLIENT_SLUG || "cristhian-loyos";
const MEDIA = `${MEDIA_ORIGIN}/media/panel/${CLIENT_SLUG}/products`;

/* ── Categorías visibles (orden = orden del menú) ─────────────────────────── */
const CATEGORIES = [
  ["sushi-entradas", "🍣 Sushi · Entradas"],
  ["sushi-rollos-frios", "🍣 Sushi · Rollos fríos"],
  ["sushi-rollos-especiales", "🍣 Sushi · Rollos especiales"],
  ["sushi-makis", "🍣 Sushi · Makis"],
  ["sushi-tempurizados", "🍣 Sushi · Rollos tempurizados"],
  ["sushi-sashimi", "🍣 Sushi · Sashimi"],
  ["sushi-arroces", "🍣 Sushi · Arroces"],
  ["sushi-sopas", "🍣 Sushi · Sopas y ramen"],
  ["sushi-combos", "🍣 Sushi · Combos estudiantes"],
  ["sushi-extras", "🍣 Sushi · Extras"],
  ["fastfood-hamburguesas", "🍔 Fast food · Hamburguesas"],
  ["fastfood-papas-carnes", "🍔 Fast food · Papas y carnes"],
  ["fastfood-alitas", "🍔 Fast food · Alitas"],
  ["fastfood-combos", "🍔 Fast food · Combos"],
  ["fastfood-postres", "🍔 Fast food · Postres"],
  ["tradicional-desayunos", "🍲 Tradicional · Desayunos"],
  ["tradicional-almuerzos", "🍲 Tradicional · Almuerzos"],
  ["tradicional-papas-patacones", "🍲 Tradicional · Papas y patacones"],
  ["tradicional-arroces", "🍲 Tradicional · Arroces"],
];

// id de archivo de imagen compartida por varios productos (se documenta en media/media-map.json).
const IMG = {
  "majado.webp": ["tradicional-majado-camaron", "tradicional-majado-huevo", "tradicional-majado-queso", "tradicional-majado-chicharron", "tradicional-majado-ceviche"],
  "bolon.webp": ["tradicional-bolon-camaron", "tradicional-bolon-chicharron", "tradicional-bolon-queso", "tradicional-bolon-mixto"],
  "tortillas.webp": ["tradicional-tortillas-camaron", "tradicional-tortillas-carne", "tradicional-tortillas-arroz-estofado", "tradicional-tortillas-mixta"],
  "almuerzo-ejecutivo.webp": ["tradicional-almuerzo-ejecutivo"],
  "carne-parrilla-platano.webp": ["tradicional-carne-parrilla-platano"],
  "pollo-asado-papas.webp": ["tradicional-pollo-asado-papas"],
  "papas-queso-salchicha.webp": ["tradicional-papas-queso-salchicha"],
  "papipollo.webp": ["tradicional-papas-queso-pollo"],
  "patacones.webp": ["tradicional-patacones-solos-ensalada"],
  "papa-rellena.webp": ["tradicional-papa-rellena-camaron", "tradicional-papa-rellena-carne", "tradicional-papa-mixta"],
  "arroz-moro.webp": ["tradicional-arroz-moro-ceviche-camaron", "tradicional-arroz-moro-ceviche-pescado", "tradicional-arroz-moro-ceviche-mixto", "tradicional-arroz-moro-huevo"],
  "cheese-burger.webp": ["fastfood-arizona-classic-burger"],
  "cheese-bacon-burger.webp": ["fastfood-bbq-bacon-burger"],
  "salchipapa.webp": ["fastfood-salchi-papas"],
  "papas-cheese-bacon.webp": ["fastfood-papa-loca-carne"],
  "alitas-bbq-6.webp": ["fastfood-alitas-bbq-6"],
  "alitas-honey-6.webp": ["fastfood-alitas-miel-mostaza-6"],
  "alitas-mix-12.webp": ["fastfood-alitas-mix-12"],
  "torta-chocolate.webp": ["fastfood-torta-chocolate-belga"],
  "selva-negra.webp": ["fastfood-torta-selva-negra"],
  "combo-burger.webp": ["fastfood-combo-burger"],
  "combo-alitas-12.webp": ["fastfood-combo-alitas-12"],
};
const IMAGE_OF = Object.fromEntries(Object.entries(IMG).flatMap(([file, ids]) => ids.map(id => [id, file])));

/* ── Productos ────────────────────────────────────────────────────────────── */
const OPT = (name, options, optional = false) => ({ name, type: "option", options, optional });
const p = (id, name, cents, category, extra = {}) => ({
  id, name, type: "producto", price: (cents / 100).toFixed(2), promo_price: "",
  packaging_id: null, packaging_cost: 0, sku: "", description: extra.desc || "",
  stock: null, active: true, catalog_visible: true,
  images: IMAGE_OF[id] ? [`${MEDIA}/${IMAGE_OF[id]}`] : [],
  categories: [category], variants: extra.variants || [], groups: [],
  // Categoría de negocio congelada por línea de pedido. Postres se reporta aparte
  // (el reporte del panel debe incluir "postres"/"otros"; ver handoff).
  report_category: extra.report || category.split("-")[0],
});

const PRODUCTS = [
  /* Sushi · Entradas (carta Munch / Arizona Sushi) */
  p("sushi-gyozas-6", "Gyozas (6 unidades)", 369, "sushi-entradas", { desc: "Empanaditas japonesas al vapor y a la plancha. Sabores: cerdo, res o camarón.", variants: [OPT("Sabor", ["Cerdo", "Res", "Camarón"])] }),
  p("sushi-camarones-tempura-5", "Camarones tempura (5 unidades)", 469, "sushi-entradas", { desc: "Camarones tempurizados crocantes con salsa togarashi." }),
  p("sushi-cubitos-fried-8", "Cubitos fried (8 unidades)", 225, "sushi-entradas", { desc: "Cubitos de mozzarella pankonizados." }),
  p("sushi-nigiris-1", "Nigiris (1 unidad)", 249, "sushi-entradas", { desc: "Nigiri de salmón o de cangrejo.", variants: [OPT("Sabor", ["Salmón", "Cangrejo"])] }),
  p("sushi-wontones-3", "Wontones rellenos (3 unidades)", 349, "sushi-entradas", { desc: "Wontones de pollo y camarón con salsa agridulce." }),
  p("sushi-rollos-primavera-3", "Rollos primavera (3 unidades)", 369, "sushi-entradas", { desc: "Rollos de pollo y vegetales con salsa japonesa." }),
  p("sushi-gunkan-cangrejo-1", "Gunkán de cangrejo (1 unidad)", 249, "sushi-entradas", { desc: "Gunkán de cangrejo." }),
  p("sushi-gunkan-salmon-1", "Gunkán de salmón sellado (1 unidad)", 249, "sushi-entradas", { desc: "Gunkán de salmón sellado." }),

  /* Sushi · Rollos fríos (porción de 5 y de 10 bocados) */
  p("sushi-oshiisake-5", "Oshiisake 5 bocados", 635, "sushi-rollos-frios", { desc: "Cobertura de salmón, relleno de queso crema, aguacate y mix de cangrejo." }),
  p("sushi-oshiisake-10", "Oshiisake 10 bocados", 1099, "sushi-rollos-frios", { desc: "Cobertura de salmón, relleno de queso crema, aguacate y mix de cangrejo." }),
  p("sushi-maguro-roll-5", "Maguro Roll 5 bocados", 750, "sushi-rollos-frios", { desc: "Cobertura de atún, relleno de queso crema, pimiento morrón y camarón tempurizado." }),
  p("sushi-maguro-roll-10", "Maguro Roll 10 bocados", 1325, "sushi-rollos-frios", { desc: "Cobertura de atún, relleno de queso crema, pimiento morrón y camarón tempurizado." }),
  p("sushi-california-5", "California 5 bocados", 485, "sushi-rollos-frios", { desc: "Cobertura de masago, relleno de cangrejo y pepinillo." }),
  p("sushi-california-10", "California 10 bocados", 769, "sushi-rollos-frios", { desc: "Cobertura de masago, relleno de cangrejo y pepinillo." }),
  p("sushi-avocado-5", "Avocado 5 bocados", 560, "sushi-rollos-frios", { desc: "Cobertura de aguacate, relleno de camarón tempura y queso crema." }),
  p("sushi-avocado-10", "Avocado 10 bocados", 769, "sushi-rollos-frios", { desc: "Cobertura de aguacate, relleno de camarón tempura y queso crema." }),
  p("sushi-filadelfia-5", "Filadelfia 5 bocados", 545, "sushi-rollos-frios", { desc: "Relleno de queso crema, aguacate y salmón fresco." }),
  p("sushi-filadelfia-10", "Filadelfia 10 bocados", 769, "sushi-rollos-frios", { desc: "Relleno de queso crema, aguacate y salmón fresco." }),
  p("sushi-kaniroll-5", "Kaniroll 5 bocados", 475, "sushi-rollos-frios", { desc: "Cobertura de kani (cangrejo), relleno de queso crema y camarón tempura." }),
  p("sushi-kaniroll-10", "Kaniroll 10 bocados", 769, "sushi-rollos-frios", { desc: "Cobertura de kani (cangrejo), relleno de queso crema y camarón tempura." }),
  p("sushi-sweetsuri-5", "Sweetsuri 5 bocados", 470, "sushi-rollos-frios", { desc: "Cobertura de maqueño y queso crema, relleno de cangrejo, aguacate y queso." }),
  p("sushi-sweetsuri-10", "Sweetsuri 10 bocados", 769, "sushi-rollos-frios", { desc: "Cobertura de maqueño y queso crema, relleno de cangrejo, aguacate y queso." }),

  /* Sushi · Rollos especiales */
  p("sushi-roll-acevichado-5", "Roll Acevichado 5 bocados", 525, "sushi-rollos-especiales", { desc: "Queso crema, aguacate y pescado tempurizado con topping de wahoo acevichado y salsa de ají amarillo." }),
  p("sushi-roll-acevichado-10", "Roll Acevichado 10 bocados", 849, "sushi-rollos-especiales", { desc: "Queso crema, aguacate y pescado tempurizado con topping de wahoo acevichado y salsa de ají amarillo." }),
  p("sushi-champilover-5", "Champilover 5 bocados", 525, "sushi-rollos-especiales", { desc: "Relleno de salmón marinado y queso crema con topping de champiñón salteado y cebollín." }),
  p("sushi-champilover-10", "Champilover 10 bocados", 849, "sushi-rollos-especiales", { desc: "Relleno de salmón marinado y queso crema con topping de champiñón salteado y cebollín." }),
  p("sushi-roll-parrillero-5", "Roll Parrillero 5 bocados", 550, "sushi-rollos-especiales", { desc: "Cobertura de lomo fino sellado a la plancha, chimichurri japonés, relleno de pimiento morrón, camarón tempura y queso crema." }),
  p("sushi-roll-parrillero-10", "Roll Parrillero 10 bocados", 869, "sushi-rollos-especiales", { desc: "Cobertura de lomo fino sellado a la plancha, chimichurri japonés, relleno de pimiento morrón, camarón tempura y queso crema." }),

  /* Sushi · Makis */
  p("sushi-maki-suri-5", "Maki Suri 5 bocados", 485, "sushi-makis", { desc: "Aguacate, salmón fresco mixsurimi y masago, cobertura de alga nori." }),
  p("sushi-maki-suri-10", "Maki Suri 10 bocados", 769, "sushi-makis", { desc: "Aguacate, salmón fresco mixsurimi y masago, cobertura de alga nori." }),
  p("sushi-kani-maki-5", "Kani Maki 5 bocados", 470, "sushi-makis", { desc: "Queso crema, aguacate, kanikama y masago, cobertura de wontón." }),
  p("sushi-kani-maki-10", "Kani Maki 10 bocados", 769, "sushi-makis", { desc: "Queso crema, aguacate, kanikama y masago, cobertura de wontón." }),

  /* Sushi · Rollos tempurizados */
  p("sushi-coco-roll-5", "Coco Roll 5 bocados", 510, "sushi-tempurizados", { desc: "Cobertura tempurizada de coco con relleno de camarón pankonizado, queso crema y aguacate." }),
  p("sushi-coco-roll-10", "Coco Roll 10 bocados", 769, "sushi-tempurizados", { desc: "Cobertura tempurizada de coco con relleno de camarón pankonizado, queso crema y aguacate." }),
  p("sushi-surimaque-5", "Surimaque 5 bocados", 485, "sushi-tempurizados", { desc: "Cobertura tempurizada, relleno de cangrejo, maqueño y queso crema." }),
  p("sushi-surimaque-10", "Surimaque 10 bocados", 749, "sushi-tempurizados", { desc: "Cobertura tempurizada, relleno de cangrejo, maqueño y queso crema." }),
  p("sushi-ebyoshii-5", "Ebyoshii 5 bocados", 485, "sushi-tempurizados", { desc: "Cobertura tempurizada, relleno Eby mix (camarón mix)." }),
  p("sushi-ebyoshii-10", "Ebyoshii 10 bocados", 749, "sushi-tempurizados", { desc: "Cobertura tempurizada, relleno Eby mix (camarón mix)." }),
  p("sushi-sakeroll-5", "Sakeroll 5 bocados", 510, "sushi-tempurizados", { desc: "Cobertura pankonizada, relleno de sake mix (salmón mix) y salsa de la casa." }),
  p("sushi-sakeroll-10", "Sakeroll 10 bocados", 769, "sushi-tempurizados", { desc: "Cobertura pankonizada, relleno de sake mix (salmón mix) y salsa de la casa." }),
  p("sushi-crocante-5", "Crocante 5 bocados", 510, "sushi-tempurizados", { desc: "Cobertura pankonizada, relleno de cangrejo, aguacate y queso crema." }),
  p("sushi-crocante-10", "Crocante 10 bocados", 769, "sushi-tempurizados", { desc: "Cobertura pankonizada, relleno de cangrejo, aguacate y queso crema." }),
  p("sushi-dragon-5", "Dragón 5 bocados", 510, "sushi-tempurizados", { desc: "Cobertura pankonizada, relleno de camarón tempura y queso crema. (La carta no lista porción de 10 bocados para este rollo.)" }),

  /* Sushi · Sashimi */
  p("sushi-sashimi-salmon-5", "Sashimi de salmón (5 unidades)", 525, "sushi-sashimi", { desc: "Cinco cortes de salmón fresco." }),
  p("sushi-sashimi-atun-5", "Sashimi de atún (5 unidades)", 550, "sushi-sashimi", { desc: "Cinco cortes de atún fresco." }),

  /* Sushi · Arroces */
  p("sushi-arroz-frito-especial", "Arroz frito especial", 649, "sushi-arroces", { desc: "Arroz frito salteado al wok con pollo, camarón y res." }),
  p("sushi-poke", "Poke", 649, "sushi-arroces", { desc: "Base de arroz gohan, camarón tempurizado, salmón y kanikama; topping de alga nori y semillas de sésamo." }),

  /* Sushi · Sopas y ramen */
  p("sushi-ramen-toki", "Ramen Toki", 499, "sushi-sopas", { desc: "Sopa a base de cerdo con panceta, huevo, naruto y fideo ramen.", variants: [OPT("Picante", ["Sin picante", "Picante"])] }),
  p("sushi-sopa-oriental-pollo", "Sopa oriental de pollo", 449, "sushi-sopas", { desc: "Sopa con piezas de pollo, vegetales y fideo.", variants: [OPT("Picante", ["Sin picante", "Picante"])] }),
  p("sushi-ramen-mariscos", "Ramen de mariscos", 499, "sushi-sopas", { desc: "Sopa de mariscos con fideo ramen, camarón, huevo, naruto y cebollín.", variants: [OPT("Picante", ["Sin picante", "Picante"])] }),

  /* Sushi · Combos estudiantes */
  p("sushi-combo-10", "Combo estudiante 10 bocados", 899, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),
  p("sushi-combo-15", "Combo estudiante 15 bocados", 1099, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),
  p("sushi-combo-20", "Combo estudiante 20 bocados", 1399, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),
  p("sushi-combo-30", "Combo estudiante 30 bocados", 1999, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),
  p("sushi-combo-40", "Combo estudiante 40 bocados", 2499, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),
  p("sushi-combo-50", "Combo estudiante 50 bocados", 2899, "sushi-combos", { desc: "Surtido de bocados de sushi. Precio con carnet estudiantil." }),

  /* Sushi · Extras */
  p("sushi-extra-salsas", "Porción de salsas", 50, "sushi-extras", { desc: "Porción adicional de salsa." }),
  p("sushi-extra-wasabi-gari", "Wasabi y gari", 75, "sushi-extras", { desc: "Wasabi y jengibre encurtido (gari)." }),

  /* Fast food · Hamburguesas (carta Arizona Grill & Burgers) */
  p("fastfood-arizona-classic-burger", "Arizona Classic Burger", 599, "fastfood-hamburguesas", { desc: "Hamburguesa clásica Arizona." }),
  p("fastfood-doble-carne-burger", "Doble Carne Burger", 749, "fastfood-hamburguesas", { desc: "Hamburguesa con doble carne." }),
  p("fastfood-bbq-bacon-burger", "BBQ Bacon Burger", 699, "fastfood-hamburguesas", { desc: "Hamburguesa BBQ con tocino." }),

  /* Fast food · Papas y carnes */
  p("fastfood-salchi-papas", "Salchi Papas", 499, "fastfood-papas-carnes", { desc: "Papas fritas con salchicha." }),
  p("fastfood-papa-loca-carne", "Papa Loca con Carne", 649, "fastfood-papas-carnes", { desc: "Papas cargadas con carne." }),
  p("fastfood-carne-parrilla-papas", "Carne a la Parrilla con Papas", 899, "fastfood-papas-carnes", { desc: "Carne a la parrilla acompañada de papas." }),

  /* Fast food · Alitas */
  p("fastfood-alitas-bbq-6", "6 Alitas BBQ", 599, "fastfood-alitas", { desc: "Seis alitas con salsa BBQ." }),
  p("fastfood-alitas-picantes-6", "6 Alitas Picantes", 599, "fastfood-alitas", { desc: "Seis alitas con salsa picante." }),
  p("fastfood-alitas-miel-mostaza-6", "6 Alitas Miel Mostaza", 649, "fastfood-alitas", { desc: "Seis alitas con salsa de miel y mostaza." }),
  p("fastfood-alitas-mix-12", "12 Alitas Mix Sabores", 1099, "fastfood-alitas", { desc: "Doce alitas en surtido de sabores." }),

  /* Fast food · Combos */
  p("fastfood-combo-burger", "Combo Burger + Papas + Bebida", 799, "fastfood-combos", { desc: "Hamburguesa con papas y bebida." }),
  p("fastfood-combo-alitas-12", "Combo Alitas 12 + Papas", 1299, "fastfood-combos", { desc: "Doce alitas con papas." }),

  /* Fast food · Postres (carta Arizona Patisserie Française) */
  p("fastfood-tiramisu", "Tiramisú Tradicional", 549, "fastfood-postres", { report: "postres", desc: "Postre francés clásico." }),
  p("fastfood-torta-chocolate-belga", "Torta de Chocolate Belga", 699, "fastfood-postres", { report: "postres", desc: "Torta de chocolate belga." }),
  p("fastfood-torta-selva-negra", "Torta Selva Negra", 649, "fastfood-postres", { report: "postres", desc: "Torta Selva Negra." }),
  p("fastfood-cheesecake-frances", "Cheesecake Francés", 599, "fastfood-postres", { report: "postres", desc: "Cheesecake estilo francés." }),
  p("fastfood-fondant-chocolate", "Fondant au Chocolat con Helado", 649, "fastfood-postres", { report: "postres", desc: "Fondant de chocolate acompañado de helado." }),
  p("fastfood-creme-brulee", "Crème Brûlée", 499, "fastfood-postres", { report: "postres", desc: "Crema catalana francesa." }),
  p("fastfood-eclair", "Éclair de Chocolate", 399, "fastfood-postres", { report: "postres", desc: "Éclair relleno con crema y cobertura de chocolate." }),
  p("fastfood-macarons-6", "Macarons (6 unidades)", 599, "fastfood-postres", { report: "postres", desc: "Seis macarons surtidos." }),
  p("fastfood-tarte-tatin", "Tarte Tatin de Manzana", 549, "fastfood-postres", { report: "postres", desc: "Tarta invertida de manzana." }),
  p("fastfood-profiteroles", "Profiteroles con Chocolate", 449, "fastfood-postres", { report: "postres", desc: "Profiteroles con salsa de chocolate." }),
  p("fastfood-mille-feuille", "Mille-Feuille de Vainilla", 599, "fastfood-postres", { report: "postres", desc: "Milhojas de crema de vainilla." }),
  p("fastfood-souffle", "Soufflé de Chocolate", 699, "fastfood-postres", { report: "postres", desc: "Soufflé de chocolate." }),

  /* Tradicional · Desayunos (PDF/docx de desayunos) */
  p("tradicional-majado-camaron", "Majado con camarón y huevo frito + café", 375, "tradicional-desayunos", { desc: "Majado de verde con camarón, huevo frito y café." }),
  p("tradicional-majado-huevo", "Majado con huevo frito + café", 375, "tradicional-desayunos", { desc: "Majado de verde con huevo frito y café." }),
  p("tradicional-majado-queso", "Majado con queso y huevo frito", 350, "tradicional-desayunos", { desc: "Majado de verde con queso y huevo frito." }),
  p("tradicional-majado-chicharron", "Majado con chicharrón y huevo frito + café", 350, "tradicional-desayunos", { desc: "Majado de verde con chicharrón, huevo frito y café." }),
  p("tradicional-majado-ceviche", "Majado con ceviche y huevo frito + café", 400, "tradicional-desayunos", { desc: "Majado de verde con ceviche, huevo frito y café." }),
  p("tradicional-bolon-camaron", "Bolón con camarón y huevo frito + café", 400, "tradicional-desayunos", { desc: "Bolón de verde con camarón, huevo frito y café." }),
  p("tradicional-bolon-chicharron", "Bolón con chicharrón y huevo frito + café", 375, "tradicional-desayunos", { desc: "Bolón de verde con chicharrón, huevo frito y café." }),
  p("tradicional-bolon-queso", "Bolón con queso y huevo frito + café", 375, "tradicional-desayunos", { desc: "Bolón de verde con queso, huevo frito y café." }),
  p("tradicional-bolon-mixto", "Bolón mixto y huevo frito + café", 400, "tradicional-desayunos", { desc: "Bolón mixto con huevo frito y café." }),
  p("tradicional-tortillas-camaron", "2 tortillas con camarón y huevo frito", 450, "tradicional-desayunos", { desc: "Dos tortillas de verde con porción de camarón y huevo frito." }),
  p("tradicional-tortillas-carne", "2 tortillas con carne (pollo o res) y huevo frito", 450, "tradicional-desayunos", { desc: "Dos tortillas de verde con porción de carne de pollo o res y huevo frito." }),
  p("tradicional-tortillas-arroz-estofado", "2 tortillas con arroz, estofado y huevo frito", 500, "tradicional-desayunos", { desc: "Dos tortillas de verde con arroz, estofado y huevo frito." }),
  p("tradicional-tortillas-mixta", "2 tortillas mixta", 500, "tradicional-desayunos", { desc: "Dos tortillas de verde en versión mixta." }),

  /* Tradicional · Almuerzos */
  p("tradicional-almuerzo-ejecutivo", "Almuerzo ejecutivo", 475, "tradicional-almuerzos", { desc: "Almuerzo ejecutivo del día. Composición sujeta a disponibilidad." }),
  p("tradicional-carne-parrilla-platano", "Carne a la parrilla con plátano y ensalada", 475, "tradicional-almuerzos", { desc: "Carne a la parrilla con plátano maduro y porción de ensalada." }),
  p("tradicional-pollo-asado-papas", "Pollo asado con papas y ensalada", 475, "tradicional-almuerzos", { desc: "Pollo asado con papas y porción de ensalada." }),

  /* Tradicional · Papas y patacones */
  p("tradicional-papas-queso-salchicha", "Papas fritas con queso y salchicha", 350, "tradicional-papas-patacones", { desc: "Papas fritas con queso y salchicha." }),
  p("tradicional-papas-queso-pollo", "Papas fritas con queso y pollo asado", 400, "tradicional-papas-patacones", { desc: "Papas fritas con queso y pollo asado." }),
  p("tradicional-papas-mixta", "Papas fritas mixta", 450, "tradicional-papas-patacones", { desc: "Papas fritas en versión mixta." }),
  p("tradicional-patacones-ceviche-camaron", "Patacones con ceviche de camarón", 375, "tradicional-papas-patacones", { desc: "Patacones con ceviche de camarón." }),
  p("tradicional-patacones-ceviche-pollo", "Patacones con ceviche de pollo", 375, "tradicional-papas-patacones", { desc: "Patacones con ceviche de pollo." }),
  p("tradicional-patacones-ceviche-mixto", "Patacones con ceviche mixto", 400, "tradicional-papas-patacones", { desc: "Patacones con ceviche mixto." }),
  p("tradicional-patacones-solos-ensalada", "Patacones solos con ensalada", 300, "tradicional-papas-patacones", { desc: "Patacones acompañados de porción de ensalada." }),
  p("tradicional-papa-rellena-camaron", "Papa con relleno de camarón y queso + ensalada", 450, "tradicional-papas-patacones", { desc: "Papa rellena de camarón y queso con porción de ensalada." }),
  p("tradicional-papa-rellena-carne", "Papa con relleno de carne y queso + ensalada", 450, "tradicional-papas-patacones", { desc: "Papa rellena de carne y queso con porción de ensalada." }),
  p("tradicional-papa-mixta", "Papa mixta + ensalada", 500, "tradicional-papas-patacones", { desc: "Papa rellena mixta con porción de ensalada." }),

  /* Tradicional · Arroces */
  p("tradicional-arroz-moro-ceviche-camaron", "Arroz moro con ceviche de camarón", 475, "tradicional-arroces", { desc: "Arroz moro con ceviche de camarón." }),
  p("tradicional-arroz-moro-ceviche-pescado", "Arroz moro con ceviche de pescado", 475, "tradicional-arroces", { desc: "Arroz moro con ceviche de pescado." }),
  p("tradicional-arroz-moro-ceviche-mixto", "Arroz moro con ceviche mixto", 500, "tradicional-arroces", { desc: "Arroz moro con ceviche mixto." }),
  p("tradicional-arroz-moro-huevo", "Arroz moro con huevo frito", 350, "tradicional-arroces", { desc: "Arroz moro con huevo frito." }),
];

/* ── Sedes: seis food trucks, IDs estables. Nombres/direcciones pendientes de confirmar. ── */
// IDs alineados con el QR acordado (`?sede=sede-01` … `sede-06`). Nombres, direcciones y
// universidades son provisionales: no se inventan campus ni marcas.
const SEDES = Array.from({ length: 6 }, (_, i) => ({
  id: `sede-0${i + 1}`,
  nombre: `Food truck ${i + 1}`,
  direccion: "Por confirmar",
  universidad: "",
  activa: true,
}));

const doc = {
  categories: CATEGORIES.map(([slug, name]) => ({ slug, name })),
  packagings: [],
  variant_groups: [],
  products: PRODUCTS,
};

const config = {
  store_name: "Munch",
  site_title: "Munch · Sushi, Fast Food y Tradicional",
  brand_sub: "",
  hero_kicker: "",
  hero_title: "Munch",
  hero_divider: false,
  search_placeholder: "Busca tu antojo...",
  currency: "USD",
  price_symbol: "$",
  price_locale: "en-US",
  price_decimals: 2,
  theme: { primary: "#23DDF4", accent: "#F339A8", bg: "#080A12", surface: "#141624", surface2: "#1D2030", text: "#F4FAFF", text2: "#C5D2DC", border: "#363B50" },
  hero_image: `${MEDIA_ORIGIN}/media/panel/${CLIENT_SLUG}/brand/munch-hero.png`,
  og_image: `${MEDIA_ORIGIN}/media/panel/${CLIENT_SLUG}/brand/munch-hero.png`,
  categories: Object.fromEntries(CATEGORIES.map(([slug, name]) => [slug, name])),
  category_order: CATEGORIES.map(([slug]) => slug),
  packaging: { enabled: true, mode: "per_product", label: "Empaque" },
  location: {
    // El menú usa estos IDs para `?sede=` y para el selector; `sedesFor` del panel los siembra
    // una vez en D1. `locationField` del panel acepta id/universidad/activa al editar.
    sedes: SEDES.map(({ id, nombre, direccion, universidad, activa }) => ({ id, nombre, direccion, universidad, activa })),
    out_of_coverage_message: "Selecciona tu food truck para confirmar el pedido.",
  },
  // Checkout opt-in del cliente: POST /api/orders, selección de sede y polling de estado (sin WhatsApp).
  // Sin esta clave (o con enabled:false) el menú conserva el checkout legacy por WhatsApp.
  checkout_orders: { enabled: true, api_base: "", poll_ms: 5000 },
};

await mkdir(join(root, "data"), { recursive: true });
await mkdir(join(root, "media"), { recursive: true });
await writeFile(join(root, "data/catalog.json"), JSON.stringify(doc, null, 2) + "\n");
await writeFile(join(root, "data/config.json"), JSON.stringify(config, null, 2) + "\n");
await writeFile(join(root, "data/sedes.json"), JSON.stringify({ slug: CLIENT_SLUG, sedes: SEDES, qr: { parametro: "sede", ejemplo: `/?sede=${SEDES[0].id}` } }, null, 2) + "\n");
await writeFile(join(root, "data/media-map.json"), JSON.stringify({ media_origin: MEDIA, files: IMG }, null, 2) + "\n");

const byReport = PRODUCTS.reduce((acc, x) => ((acc[x.report_category] = (acc[x.report_category] || 0) + 1), acc), {});
console.log(`catalog: ${PRODUCTS.length} productos · ${CATEGORIES.length} categorías · ${Object.entries(byReport).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`sedes: ${SEDES.length} (IDs ${SEDES.map(s => s.id).join(", ")})`);
