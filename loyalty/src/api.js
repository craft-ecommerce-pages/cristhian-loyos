import {
  CARD_CODE_ALPHABET,
  CARD_CODE_LENGTH,
  DEVICE_COOKIE,
  MAX_PHONES_PER_DEVICE,
  MAX_PIN_FAILS,
  MAX_PIN_FAILS_DEVICE,
  SESSION_COOKIE,
  STAMPS_PRIZE_ID,
  cardUrl,
  distanceM,
  normalizeBirthday,
  normalizeConfig,
  normalizePhone,
  parseCardCode,
  segments,
  sedesWithCoords,
} from "./contract.js";
import { walletEnabled, walletNotify, walletSaveUrl, walletSync } from "./wallet.js";

const DAY = 864e5,
  HOUR = 36e5,
  te = new TextEncoder();
const json = (body, status = 200, headers) => {
  const h = new Headers(headers);
  h.set("cache-control", "no-store");
  h.set("x-content-type-options", "nosniff");
  return Response.json(body, { status, headers: h });
};
const error = (code, status, extra) => json({ error: code, ...extra }, status);
const cookie = (n, v, age) => `${n}=${v}; Path=/club; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

export function pickSegment(segs, rand = Math.random) {
  const w = segs.map(s => Math.max(0, Number(s?.weight) || 0)),
    total = w.reduce((a, b) => a + b, 0);
  if (!total) return -1;
  let x = Math.min(Math.max(Number(rand()) || 0, 0), 1 - Number.EPSILON) * total;
  for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i;
  return w.findLastIndex(x => x > 0);
}

// club_d siempre se emite en la API; D1 solo conserva su SHA-256.
export async function handleApi(request, env, ctx, site) {
  const path = new URL(request.url).pathname.replace(/^\/club\/api\/?/, ""),
    device = await getDevice(request);
  const fn = {
      "POST login": login,
      "POST logout": logout,
      "GET me": me,
      "POST profile": profile,
      "POST play": play,
      "POST redeem": redeem,
      "POST feedback": feedback,
      "GET wallet": wallet,
    }[`${request.method} ${path}`],
    res = fn ? await fn(request, env, ctx, site, device) : error("ruta_no_encontrada", 404);
  if (!device.supplied) res.headers.append("set-cookie", cookie(DEVICE_COOKIE, device.token, 63072000));
  return res;
}

export async function handleAdmin(request, env, ctx) {
  if (!bearer(request.headers.get("authorization"), env.ADMIN_TOKEN)) return error("no_autorizado", 401);
  const url = new URL(request.url),
    p = url.pathname.split("/").filter(Boolean),
    slug = p[1] || "";
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) return error("slug_invalido", 400);
  const t = p.slice(2),
    key = t.join("/");
  if (request.method === "GET" && key === "stats") return adminStats(env, slug, url);
  if (request.method === "GET" && key === "customers") return adminCustomers(env, slug, url);
  if (request.method === "GET" && key === "customers.csv") return adminCustomersCsv(env, slug);
  if (request.method === "GET" && t[0] === "customers" && t.length === 2) return adminCustomer(env, slug, t[1]);
  if (request.method === "GET" && key === "feedback") return adminFeedback(env, slug, url);
  if (request.method === "POST" && key === "campaigns") return adminCampaign(request, env, slug);
  if (request.method === "GET" && key === "campaigns") return adminCampaigns(env, slug);
  if (request.method === "POST" && key === "credits") return createCredit(request, env, slug);
  if (request.method === "GET" && key === "credits") return adminCredits(env, slug, url);
  if (t[0] === "credits" && t.length === 3 && request.method === "POST" && (t[2] === "grant" || t[2] === "reject"))
    return resolveCredit(env, slug, t[1], t[2]);
  if (request.method === "GET" && key === "staff") return adminStaff(env, slug);
  if (request.method === "POST" && key === "staff") return createStaff(request, env, slug);
  if (request.method === "POST" && key === "staff/verify") return verifyStaff(request, env, slug);
  if (t[0] === "staff" && t.length === 2 && request.method === "PUT") return updateStaff(request, env, slug, t[1]);
  if (t[0] === "staff" && t.length === 2 && request.method === "DELETE") return deleteStaff(env, slug, t[1]);
  // Modo caja: el mesero escanea la tarjeta (o escribe el código) desde el panel.
  if (t[0] === "card" && t.length === 2 && request.method === "GET") return adminCard(env, slug, t[1]);
  if (t[0] === "card" && t.length === 3 && t[2] === "visit" && request.method === "POST")
    return adminVisit(request, env, ctx, slug, t[1]);
  if (t[0] === "rewards" && t.length === 3 && t[2] === "redeem" && request.method === "POST")
    return adminRedeem(request, env, ctx, slug, t[1]);
  return error("ruta_no_encontrada", 404);
}

async function login(request, env, _ctx, site, d) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const name = typeof b.name === "string" ? [...b.name.trim()].slice(0, 60).join("") : "";
  if (!name) return error("nombre_requerido", 400);
  const phone = normalizePhone(b.phone, site.cfg.phone_country);
  if (!phone) return error("telefono_invalido", 400);
  const birthday = b.birthday == null || b.birthday === "" ? null : normalizeBirthday(b.birthday);
  if (b.birthday != null && b.birthday !== "" && !birthday) return error("cumpleanos_invalido", 400);
  const now = Date.now(),
    pinAttempt = b.pin != null && String(b.pin) !== "";
  if (pinAttempt && (await blocked(env, site.slug, d.hash, now))) return error("bloqueado", 423);
  if (pinAttempt && (await throttled(request, env, site.slug))) return error("demasiados_intentos", 429);
  const existing = await customer(env, site.slug, phone),
    linked = await linkedDevice(env, site.slug, phone, d.hash);
  if (!linked) {
    if (await phoneLimit(env, site.slug, d.hash, phone)) return error("limite_dispositivo", 429);
    if (existing && (await hasValue(env, site.slug, phone, now))) {
      if (!pinAttempt) return error("verificacion_requerida", 403);
      const staff = await validPin(env, site.slug, b.pin, site.cfg.staff_pin_hash);
      if (!staff) return deviceFail(env, site.slug, d.hash, now);
      await link(env, site.slug, phone, d.hash, staff, now);
    } else await link(env, site.slug, phone, d.hash, null, now);
  } else await touch(env, site.slug, phone, d.hash, now);
  await env.DB.prepare(
    "INSERT INTO customers (slug,phone,name,birthday,created_at) VALUES (?,?,?,?,?) ON CONFLICT(slug,phone) DO UPDATE SET name=excluded.name,birthday=COALESCE(NULLIF(customers.birthday,''),excluded.birthday)",
  )
    .bind(site.slug, phone, name, birthday, now)
    .run();
  const current = await buildMe(env, site, phone, now);
  return json(current.me, 200, {
    "set-cookie": cookie(SESSION_COOKIE, `${phone}.${await mac(env, site.slug, phone)}`, 31536000),
  });
}
async function logout() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "set-cookie": cookie(SESSION_COOKIE, "", 0) },
  });
}
async function me(request, env, _ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401, { program: program(site) });
  const current = await buildMe(env, site, s.phone);
  return current ? json(current.me) : error("sin_sesion", 401, { program: program(site) });
}

// El cumpleaños se declara una sola vez: cambiarlo después sería una vía para farmear el regalo anual.
async function profile(request, env, _ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401);
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const birthday = normalizeBirthday(b.birthday);
  if (!birthday) return error("cumpleanos_invalido", 400);
  const c = await customer(env, site.slug, s.phone);
  if (!c) return error("sin_sesion", 401);
  if (c.birthday) return equal(c.birthday, birthday) ? json((await buildMe(env, site, s.phone)).me) : error("cumpleanos_ya_definido", 409);
  const updated = await env.DB.prepare(
    "UPDATE customers SET birthday=? WHERE slug=? AND phone=? AND (birthday IS NULL OR birthday='')",
  )
    .bind(birthday, site.slug, s.phone)
    .run();
  if (!updated.meta.changes) return error("cumpleanos_ya_definido", 409);
  return json((await buildMe(env, site, s.phone)).me);
}

// Opinión privada de la última jugada sin opinión. Puntúa 1-5 y el comentario es opcional (≤ 500).
async function feedback(request, env, _ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401);
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return error("calificacion_invalida", 400);
  const comment = typeof b.comment === "string" ? b.comment.trim() : "";
  if ([...comment].length > 500) return error("comentario_largo", 400);
  const last = await env.DB.prepare(
    `SELECT p.id FROM plays p
     WHERE p.slug=? AND p.phone=?
       AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.slug=p.slug AND f.play_id=p.id)
     ORDER BY p.created_at DESC, p.id DESC LIMIT 1`,
  )
    .bind(site.slug, s.phone)
    .first();
  if (!last) return error("sin_visita", 409);
  const inserted = await env.DB.prepare(
    `INSERT INTO feedback (slug,phone,rating,comment,play_id,created_at)
     SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM feedback WHERE slug=? AND play_id=?)`,
  )
    .bind(site.slug, s.phone, rating, comment, last.id, Date.now(), site.slug, last.id)
    .run();
  if (!inserted.meta.changes) return error("sin_visita", 409);
  return json({ ok: true, play_id: Number(last.id) });
}

async function play(request, env, ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401);
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const stamps = site.cfg.play_mode === "stamps",
    credit = b.credit === true;
  if (stamps ? b.game !== "stamp" : !site.cfg.games.includes(b.game)) return error("juego_invalido", 400);
  const now = Date.now();
  // Un crédito ya está pagado: no exige presencia ni cooldown (lo limita el tope diario del alta).
  const used = credit ? await grantedCredit(env, site.slug, s.phone) : null;
  if (credit && !used) return error("sin_creditos", 409);
  if (!credit) {
    const c = await customer(env, site.slug, s.phone),
      next = c?.last_play_at == null ? null : Number(c.last_play_at) + site.cfg.cooldown_hours * HOUR;
    if (next && now < next) return error("cooldown", 429, { next_play_at: next });
    const last = await env.DB.prepare(
        "SELECT created_at FROM plays WHERE slug=? AND device_hash=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(site.slug, d.hash)
        .first(),
      dnext = last ? Number(last.created_at) + site.cfg.cooldown_hours * HOUR : null;
    if (dnext && now < dnext) return error("cooldown", 429, { next_play_at: dnext });
  }
  const present = credit
    ? { via: "credit", lat: null, lng: null, staffId: null }
    : await presence(request, env, site, b, d, now);
  if (present.error)
    return error(present.error, present.error === "bloqueado" ? 423 : present.error === "demasiados_intentos" ? 429 : 403);
  // En modo "stamps" la visita no sortea: solo suma sello (y puede completar la tarjeta).
  let index = -1,
    prize = null,
    rewardId = null;
  if (!stamps) {
    const stable = segments(site.cfg),
      issuedRows = await env.DB.prepare("SELECT prize_id,COUNT(*) issued FROM rewards WHERE slug=? GROUP BY prize_id")
        .bind(site.slug)
        .all(),
      issued = new Map(issuedRows.results.map(x => [x.prize_id, Number(x.issued)])),
      draw = stable.map(x => {
        const p = site.cfg.prizes.find(q => q.id === x.id);
        return p?.stock != null && (issued.get(p.id) || 0) >= p.stock ? { ...x, weight: 0 } : x;
      });
    index = pickSegment(draw, () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
    const selected = index < 0 ? null : stable[index];
    prize = selected?.id == null ? null : site.cfg.prizes.find(x => x.id === selected.id) || null;
    rewardId = prize ? crypto.randomUUID() : null;
  }
  const cutoff = now - site.cfg.cooldown_hours * HOUR,
    { stmts, stampsAt, stampId } = visitStatements(env, site.cfg, {
      slug: site.slug,
      phone: s.phone,
      now,
      game: stamps ? "stamp" : b.game,
      via: present.via,
      lat: present.lat,
      lng: present.lng,
      staffId: present.staffId,
      deviceHash: d.hash,
      // La guardia del INSERT es atómica: en una jugada con crédito exige que ese crédito siga
      // `granted`; en una visita normal exige que no haya cooldown (teléfono ni dispositivo).
      // Si no se cumple, `game` queda NULL y el NOT NULL aborta el batch (lo maneja el catch).
      guardSql: `CASE WHEN (
         CASE WHEN ?=1 THEN EXISTS(SELECT 1 FROM credits WHERE id=? AND slug=? AND phone=? AND status='granted')
         ELSE (SELECT last_play_at IS NULL OR last_play_at<=? FROM customers WHERE slug=? AND phone=?)
           AND NOT EXISTS(SELECT 1 FROM plays WHERE slug=? AND device_hash=? AND created_at>?)
         END
       ) THEN ? ELSE NULL END`,
      guardArgs: [credit ? 1 : 0, used?.id ?? null, site.slug, s.phone, cutoff, site.slug, s.phone, site.slug, d.hash, cutoff],
      prize,
      rewardId,
      creditId: credit ? used.id : null,
    });
  let batch;
  try {
    batch = await env.DB.batch(stmts);
  } catch (cause) {
    if (!credit) {
      const fresh = await customer(env, site.slug, s.phone),
        n = fresh?.last_play_at == null ? null : Number(fresh.last_play_at) + site.cfg.cooldown_hours * HOUR;
      if (n && now < n) return error("cooldown", 429, { next_play_at: n });
      const recent = await env.DB.prepare(
        "SELECT created_at FROM plays WHERE slug=? AND device_hash=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(site.slug, d.hash)
        .first();
      if (recent && now < Number(recent.created_at) + site.cfg.cooldown_hours * HOUR)
        return error("cooldown", 429, { next_play_at: Number(recent.created_at) + site.cfg.cooldown_hours * HOUR });
    }
    if (prize?.stock != null) return error("premio_agotado", 409);
    if (credit && !(await grantedCredit(env, site.slug, s.phone))) return error("sin_creditos", 409);
    throw cause;
  }
  const completed = batch[stampsAt].meta.changes > 0,
    current = await buildMe(env, site, s.phone, now);
  if (current.customer.wallet_saved) sync(ctx, env, site, current);
  return json({
    result: {
      segment_index: index,
      won: Boolean(prize),
      prize: prize ? { id: prize.id, label: prize.label } : null,
      reward_id: rewardId,
      card_completed: completed,
      stamps_reward_id: completed ? stampId : null,
    },
    me: current.me,
  });
}

// Núcleo compartido de una visita válida (lo usan /club/api/play y el modo caja): registra la
// jugada con la guardia `guardSql`, el premio del sorteo si lo hay, el premio por completar la
// tarjeta y el avance de sellos/visitas. Un `staffId` identificado además libera los créditos
// pendientes de ese teléfono. Devuelve el batch y el índice del INSERT del premio de tarjeta.
function visitStatements(env, cfg, options) {
  const {
      slug, phone, now, game, via, lat = null, lng = null, staffId = null, deviceHash = null,
      guardSql = "?", guardArgs = [], prize = null, rewardId = null, creditId = null,
    } = options,
    stampId = crypto.randomUUID(),
    stmts = [
      env.DB.prepare(
        `INSERT INTO plays (slug,phone,game,prize_id,reward_id,via,lat,lng,staff_id,device_hash,created_at)
         VALUES (?,?,${guardSql},?,?,?,?,?,?,?,?)`,
      ).bind(slug, phone, ...guardArgs, game, prize?.id || null, rewardId, via, lat, lng, staffId, deviceHash, now),
    ];
  if (prize)
    stmts.push(
      env.DB.prepare(
        "INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at,expires_at) VALUES (?,CASE WHEN ? IS NULL OR (SELECT COUNT(*) FROM rewards WHERE slug=? AND prize_id=?)<? THEN ? ELSE NULL END,?,?,?,'game',?,?)",
      ).bind(rewardId, prize.stock, slug, prize.id, prize.stock, slug, phone, prize.id, prize.label, now, expires(now, prize.expires_days)),
    );
  stmts.push(
    env.DB.prepare(
      "INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at,expires_at) SELECT ?,?,?,?,?,'stamps',?,? FROM customers WHERE slug=? AND phone=? AND stamps+1>=?",
    ).bind(stampId, slug, phone, STAMPS_PRIZE_ID, cfg.stamps_reward.label, now, expires(now, cfg.stamps_reward.expires_days), slug, phone, cfg.stamps_goal),
  );
  const stampsAt = stmts.length - 1;
  stmts.push(
    env.DB.prepare(
      "UPDATE customers SET cards_completed=cards_completed+(stamps+1>=?),stamps=CASE WHEN stamps+1>=? THEN 0 ELSE stamps+1 END,visits=visits+1,last_play_at=? WHERE slug=? AND phone=?",
    ).bind(cfg.stamps_goal, cfg.stamps_goal, now, slug, phone),
  );
  if (staffId)
    stmts.push(
      env.DB.prepare(
        "UPDATE credits SET status='granted',granted_at=?,granted_by=? WHERE slug=? AND phone=? AND status='pending'",
      ).bind(now, staffId, slug, phone),
    );
  if (creditId)
    stmts.push(env.DB.prepare("UPDATE credits SET status='used',used_at=? WHERE id=? AND status='granted'").bind(now, creditId));
  return { stmts, stampsAt, stampId };
}

async function redeem(request, env, ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401);
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const r = await env.DB.prepare("SELECT * FROM rewards WHERE id=? AND slug=? AND phone=?")
      .bind(String(b.reward_id || ""), site.slug, s.phone)
      .first(),
    now = Date.now();
  if (!r) return error("premio_no_encontrado", 404);
  if (r.status === "redeemed") return error("ya_canjeado", 409);
  if (r.expires_at != null && Number(r.expires_at) <= now) return error("vencido", 409);
  if (Number(r.pin_fails) >= MAX_PIN_FAILS) return error("bloqueado", 423);
  if (!(await anyPin(env, site.slug, site.cfg.staff_pin_hash))) return error("sin_pin", 409);
  if (await blocked(env, site.slug, d.hash, now)) return error("bloqueado", 423);
  if (await throttled(request, env, site.slug)) return error("demasiados_intentos", 429);
  const staff = await validPin(env, site.slug, b.pin, site.cfg.staff_pin_hash);
  if (!staff) {
    const fail = await deviceFail(env, site.slug, d.hash, now);
    if (fail.status === 423) return fail;
    await env.DB.prepare("UPDATE rewards SET pin_fails=pin_fails+1 WHERE id=? AND status='active' AND pin_fails<?")
      .bind(r.id, MAX_PIN_FAILS)
      .run();
    const fresh = await env.DB.prepare("SELECT pin_fails FROM rewards WHERE id=?").bind(r.id).first();
    return error("pin_invalido", 403, { attempts_left: Math.max(0, MAX_PIN_FAILS - Number(fresh.pin_fails)) });
  }
  const updated = await env.DB.prepare(
    "UPDATE rewards SET status='redeemed',redeemed_at=?,redeemed_staff_id=? WHERE id=? AND slug=? AND phone=? AND status='active' AND (expires_at IS NULL OR expires_at>?) AND pin_fails<?",
  )
    .bind(now, staff, r.id, site.slug, s.phone, now, MAX_PIN_FAILS)
    .run();
  if (!updated.meta.changes) return error("ya_canjeado", 409);
  const current = await buildMe(env, site, s.phone, now);
  if (current.customer.wallet_saved) sync(ctx, env, site, current);
  return json({ reward: rewardPublic({ ...r, status: "redeemed", redeemed_at: now }, now), me: current.me });
}
async function wallet(request, env, _ctx, site, d) {
  const s = await session(request, env, site.slug, d);
  if (!s) return error("sin_sesion", 401);
  if (!walletEnabled(env)) return error("wallet_no_disponible", 404);
  const current = await buildMe(env, site, s.phone);
  if (!current) return error("sin_sesion", 401);
  try {
    const location = await walletSaveUrl(env, site.slug, site.menuCfg, site.cfg, current.customer, current.activeRewards);
    await env.DB.prepare("UPDATE customers SET wallet_saved=1 WHERE slug=? AND phone=?").bind(site.slug, s.phone).run();
    return new Response(null, {
      status: 302,
      headers: { location, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (cause) {
    console.error("No se pudo crear el pase de Wallet", cause);
    return error("wallet_error", 502);
  }
}

async function presence(request, env, site, b, d, now) {
  const sedes = sedesWithCoords(site.menuCfg),
    mustPin = site.cfg.require_pin || !sedes.length,
    attempt = b.pin != null && String(b.pin) !== "";
  if (attempt) {
    if (await blocked(env, site.slug, d.hash, now)) return { error: "bloqueado" };
    if (await throttled(request, env, site.slug)) return { error: "demasiados_intentos" };
    const staff = await validPin(env, site.slug, b.pin, site.cfg.staff_pin_hash);
    if (!staff) {
      const n = await recordFail(env, site.slug, d.hash, now);
      return { error: n >= MAX_PIN_FAILS_DEVICE ? "bloqueado" : "pin_invalido" };
    }
    return { via: "pin", lat: null, lng: null, staffId: staff };
  }
  if (mustPin) return { error: "pin_requerido" };
  const lat = num(b.lat),
    lng = num(b.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: "sin_ubicacion" };
  return sedes.some(x => distanceM(lat, lng, x.lat, x.lng) <= site.cfg.radius_m)
    ? { via: "geo", lat, lng, staffId: null }
    : { error: "fuera_de_rango" };
}

async function getDevice(request) {
  const raw = getCookie(request, DEVICE_COOKIE),
    supplied = /^[A-Za-z0-9_-]{43}$/.test(raw || ""),
    token = supplied ? raw : b64(crypto.getRandomValues(new Uint8Array(32)));
  return { token, supplied, hash: await hash(token) };
}
// Compatibilidad: un club_s válido sin club_d vincula una vez el dispositivo nuevo; el HMAC prueba la sesión anterior.
async function session(request, env, slug, d) {
  const m = /^(\d{10,15})\.([0-9a-f]{64})$/.exec(getCookie(request, SESSION_COOKIE) || "");
  if (!m || !equal(m[2], await mac(env, slug, m[1]))) return null;
  const phone = m[1],
    now = Date.now();
  if (!d.supplied) {
    if (!(await customer(env, slug, phone))) return null;
    await link(env, slug, phone, d.hash, null, now);
    return { phone };
  }
  if (!(await linkedDevice(env, slug, phone, d.hash))) return null;
  await touch(env, slug, phone, d.hash, now);
  return { phone };
}
async function link(env, slug, phone, hash, staff, now) {
  return env.DB.prepare(
    "INSERT INTO customer_devices (slug,phone,device_hash,staff_id,created_at,last_seen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(slug,phone,device_hash) DO UPDATE SET staff_id=COALESCE(excluded.staff_id,customer_devices.staff_id),last_seen_at=excluded.last_seen_at",
  )
    .bind(slug, phone, hash, staff, now, now)
    .run();
}
async function linkedDevice(env, slug, phone, hash) {
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM customer_devices WHERE slug=? AND phone=? AND device_hash=?")
      .bind(slug, phone, hash)
      .first(),
  );
}
async function touch(env, slug, phone, hash, now) {
  return env.DB.prepare(
    "UPDATE customer_devices SET last_seen_at=? WHERE slug=? AND phone=? AND device_hash=? AND last_seen_at<?",
  )
    .bind(now, slug, phone, hash, now - HOUR)
    .run();
}
async function phoneLimit(env, slug, hash, phone) {
  const r = await env.DB.prepare(
    "SELECT COUNT(DISTINCT phone) n FROM customer_devices WHERE slug=? AND device_hash=? AND phone<>?",
  )
    .bind(slug, hash, phone)
    .first();
  return Number(r?.n) >= MAX_PHONES_PER_DEVICE;
}
async function hasValue(env, slug, phone, now) {
  const c = await customer(env, slug, phone);
  if (Number(c?.stamps) || Number(c?.visits)) return true;
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM rewards WHERE slug=? AND phone=? AND status='active' AND (expires_at IS NULL OR expires_at>?) LIMIT 1",
    )
      .bind(slug, phone, now)
      .first(),
  );
}
async function blocked(env, slug, hash, now) {
  const r = await env.DB.prepare("SELECT fails,window_started_at FROM device_pin_fails WHERE slug=? AND device_hash=?")
    .bind(slug, hash)
    .first();
  return Number(r?.window_started_at) > now - DAY && Number(r?.fails) >= MAX_PIN_FAILS_DEVICE;
}
async function recordFail(env, slug, device, now) {
  const r = await env.DB.prepare("SELECT fails,window_started_at FROM device_pin_fails WHERE slug=? AND device_hash=?")
      .bind(slug, device)
      .first(),
    fails = Number(r?.window_started_at) > now - DAY ? Number(r.fails) + 1 : 1;
  await env.DB.prepare(
    "INSERT INTO device_pin_fails (slug,device_hash,window_started_at,fails) VALUES (?,?,?,?) ON CONFLICT(slug,device_hash) DO UPDATE SET window_started_at=excluded.window_started_at,fails=excluded.fails",
  )
    .bind(slug, device, now, fails)
    .run();
  return fails;
}
async function deviceFail(env, slug, d, now) {
  return (await recordFail(env, slug, d, now)) >= MAX_PIN_FAILS_DEVICE ? error("bloqueado", 423) : error("pin_invalido", 403);
}
async function anyPin(env, slug, legacy) {
  return Boolean(legacy || (await env.DB.prepare("SELECT 1 FROM staff WHERE slug=? AND active=1 LIMIT 1").bind(slug).first()));
}
async function validPin(env, slug, pin, legacy) {
  if (!/^\d{4,6}$/.test(String(pin ?? ""))) return null;
  const actual = await hash(`${slug}:${pin}`),
    rows = await env.DB.prepare("SELECT id,pin_hash FROM staff WHERE slug=? AND active=1").bind(slug).all();
  let id = null;
  for (const r of rows.results) if (equal(actual, r.pin_hash)) id ??= r.id;
  if (legacy && equal(actual, legacy)) id ??= "legacy";
  return id;
}

function expires(now, days) {
  return days == null ? null : now + days * DAY;
}
function sync(ctx, env, site, current) {
  ctx?.waitUntil?.(walletSync(env, site.slug, site.menuCfg, site.cfg, current.customer, current.activeRewards));
}
async function buildMe(env, site, phone, now = Date.now()) {
  const c = await customer(env, site.slug, phone);
  if (!c) return null;
  // La tarjeta se emite al entrar al club y, si el cliente es anterior a la migración, al leer su ficha.
  const code = await assignCardCode(env, site.slug, phone, c.card_code);
  if (code) c.card_code = code;
  const [rows, creditRows] = await Promise.all([
      env.DB.prepare(
        "SELECT id,label,source,status,created_at,expires_at,redeemed_at FROM rewards WHERE slug=? AND phone=? ORDER BY CASE WHEN status='active' AND (expires_at IS NULL OR expires_at>?) THEN 0 ELSE 1 END,created_at DESC LIMIT 50",
      )
        .bind(site.slug, phone, now)
        .all(),
      env.DB.prepare(
        "SELECT SUM(status='granted') granted,SUM(status='pending') pending FROM credits WHERE slug=? AND phone=?",
      )
        .bind(site.slug, phone)
        .first(),
    ]),
    rewards = rows.results.map(x => rewardPublic(x, now)),
    activeRewards = rewards.filter(x => x.status === "active"),
    next = c.last_play_at == null ? null : Number(c.last_play_at) + site.cfg.cooldown_hours * HOUR;
  return {
    customer: c,
    activeRewards,
    me: {
      customer: customerPublic(c),
      card: code ? { code, url: cardUrl(site.slug, code) } : null,
      program: program(site),
      can_play: next == null || now >= next,
      next_play_at: next && now < next ? next : null,
      rewards,
      credits: { granted: Number(creditRows?.granted || 0), pending: Number(creditRows?.pending || 0) },
      wallet_url: walletEnabled(env) ? "/club/api/wallet" : null,
    },
  };
}
function program(site) {
  const m = site.menuCfg || {},
    geo = sedesWithCoords(m).length > 0;
  return {
    store_name: typeof m.store_name === "string" ? m.store_name : "",
    logo: typeof m.logo === "string" ? m.logo : "",
    theme_primary: typeof m.theme_primary === "string" ? m.theme_primary : "",
    theme_accent: typeof m.theme_accent === "string" ? m.theme_accent : "",
    games: site.cfg.games,
    segments: segments(site.cfg).map(({ id, label }) => ({ id, label })),
    stamps_goal: site.cfg.stamps_goal,
    stamps_reward_label: site.cfg.stamps_reward.label,
    cooldown_hours: site.cfg.cooldown_hours,
    play_mode: site.cfg.play_mode,
    birthday: site.cfg.birthday, // la página pinta/oculta el aviso de cumpleaños
    review_url: site.cfg.review_url,
    terms: site.cfg.terms,
    geo_required: geo,
    pin_required: site.cfg.require_pin || !geo,
  };
}
const customerPublic = x => ({
  name: x.name,
  phone: x.phone,
  birthday: x.birthday || null, // la página del club lo usa para no volver a pedirlo
  stamps: Number(x.stamps),
  visits: Number(x.visits),
  cards_completed: Number(x.cards_completed),
});
const rewardPublic = (x, now) => ({
  id: x.id,
  label: x.label,
  source: x.source,
  status: x.status === "active" && x.expires_at != null && Number(x.expires_at) <= now ? "expired" : x.status,
  created_at: Number(x.created_at),
  expires_at: x.expires_at == null ? null : Number(x.expires_at),
  redeemed_at: x.redeemed_at == null ? null : Number(x.redeemed_at),
});
const customer = (env, slug, phone) =>
  env.DB.prepare("SELECT * FROM customers WHERE slug=? AND phone=?").bind(slug, phone).first();
// Código de tarjeta: 10 caracteres aleatorios del alfabeto sin ambigüedades, único por local.
// Solo escribe si el cliente aún no tiene uno; ante un choque (índice único) reintenta.
async function assignCardCode(env, slug, phone, current) {
  if (current) return current;
  for (let i = 0; i < 5; i++) {
    const code = randomCardCode();
    if (await env.DB.prepare("SELECT 1 FROM customers WHERE slug=? AND card_code=?").bind(slug, code).first()) continue;
    try {
      const updated = await env.DB.prepare(
        "UPDATE customers SET card_code=? WHERE slug=? AND phone=? AND (card_code IS NULL OR card_code='')",
      )
        .bind(code, slug, phone)
        .run();
      if (updated.meta.changes) return code;
    } catch {
      // Otro request ganó la carrera por ese código: se mira el valor definitivo y se reintenta.
    }
    const fresh = await customer(env, slug, phone);
    if (fresh?.card_code) return fresh.card_code;
  }
  return null;
}
function randomCardCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CARD_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += CARD_CODE_ALPHABET[byte % CARD_CODE_ALPHABET.length];
  return code;
}
// Crédito más viejo disponible para jugar (se consume en POST /play con credit:true).
const grantedCredit = (env, slug, phone) =>
  env.DB.prepare("SELECT * FROM credits WHERE slug=? AND phone=? AND status='granted' ORDER BY created_at,id LIMIT 1")
    .bind(slug, phone)
    .first();
async function mac(env, slug, phone) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!secret) throw new Error("SESSION_SECRET no configurado");
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(`${slug}:${phone}`))));
}
async function hash(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(value))));
}
const hex = a => [...a].map(x => x.toString(16).padStart(2, "0")).join("");
function b64(a) {
  let s = "";
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function getCookie(r, n) {
  return (r.headers.get("cookie") || "")
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith(`${n}=`))
    ?.slice(n.length + 1);
}
function equal(a, b) {
  const l = te.encode(String(a ?? "")),
    r = te.encode(String(b ?? ""));
  let d = l.length ^ r.length;
  for (let i = 0; i < r.length; i++) d |= (l[i] || 0) ^ r[i];
  return d === 0;
}
async function throttled(r, env, slug) {
  if (!env.PIN_LIMITER) return false;
  return !(await env.PIN_LIMITER.limit({ key: `${slug}:${r.headers.get("cf-connecting-ip") || "sin-ip"}` })).success;
}
const bearer = (h, t) =>
  typeof h === "string" && h.startsWith("Bearer ") && typeof t === "string" && Boolean(t) && equal(h.slice(7), t);
async function body(r) {
  try {
    const x = await r.json();
    return x && typeof x === "object" && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

async function adminStats(env, slug, url) {
  const raw = url.searchParams.get("days"),
    days = raw == null || raw === "" ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 366) return error("dias_invalidos", 400);
  const now = Date.now(),
    since = Math.floor((now - 5 * HOUR) / DAY) * DAY + 5 * HOUR - (days - 1) * DAY,
    [c, p, r, pd, cd] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(*) customers,SUM(created_at>=?) new_customers,SUM(visits>=2) returning_customers,COALESCE(SUM(cards_completed),0) cards_completed FROM customers WHERE slug=?",
      )
        .bind(since, slug)
        .first(),
      env.DB.prepare("SELECT COUNT(*) plays FROM plays WHERE slug=? AND created_at>=?").bind(slug, since).first(),
      env.DB.prepare("SELECT SUM(created_at>=?) rewards_issued,SUM(redeemed_at>=?) rewards_redeemed FROM rewards WHERE slug=?")
        .bind(since, since, slug)
        .first(),
      env.DB.prepare(
        "SELECT date(created_at/1000,'unixepoch','-5 hours') day,COUNT(*) plays FROM plays WHERE slug=? AND created_at>=? GROUP BY day",
      )
        .bind(slug, since)
        .all(),
      env.DB.prepare(
        "SELECT date(created_at/1000,'unixepoch','-5 hours') day,COUNT(*) new_customers FROM customers WHERE slug=? AND created_at>=? GROUP BY day",
      )
        .bind(slug, since)
        .all(),
    ]),
    m = new Map(pd.results.map(x => [x.day, { day: x.day, plays: Number(x.plays), new_customers: 0 }]));
  for (const x of cd.results)
    m.set(x.day, { ...(m.get(x.day) || { day: x.day, plays: 0 }), new_customers: Number(x.new_customers) });
  return json({
    customers: Number(c.customers || 0),
    new_customers: Number(c.new_customers || 0),
    plays: Number(p.plays || 0),
    returning_customers: Number(c.returning_customers || 0),
    rewards_issued: Number(r.rewards_issued || 0),
    rewards_redeemed: Number(r.rewards_redeemed || 0),
    cards_completed: Number(c.cards_completed || 0),
    by_day: [...m.values()].sort((a, b) => a.day.localeCompare(b.day)),
  });
}
async function adminCustomers(env, slug, url) {
  const q = (url.searchParams.get("q") || "").trim(),
    limit = bound(url.searchParams.get("limit"), 50, 1, 100),
    offset = bound(url.searchParams.get("offset"), 0, 0, 1e6);
  if (limit == null || offset == null) return error("paginacion_invalida", 400);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`,
    where = q ? "slug=? AND (name LIKE ? ESCAPE '\\' COLLATE NOCASE OR phone LIKE ? ESCAPE '\\')" : "slug=?",
    args = q ? [slug, like, like] : [slug],
    now = Date.now(),
    [rows, count] = await Promise.all([
      env.DB.prepare(
        `SELECT c.phone,c.name,c.birthday,c.stamps,c.visits,c.cards_completed,c.last_play_at,c.wallet_saved,(SELECT COUNT(*) FROM rewards r WHERE r.slug=c.slug AND r.phone=c.phone AND r.status='active' AND (r.expires_at IS NULL OR r.expires_at>?)) active_rewards FROM customers c WHERE ${where} ORDER BY c.last_play_at DESC,c.created_at DESC LIMIT ? OFFSET ?`,
      )
        .bind(now, ...args, limit, offset)
        .all(),
      env.DB.prepare(`SELECT COUNT(*) total FROM customers WHERE ${where}`)
        .bind(...args)
        .first(),
    ]);
  return json({ items: rows.results.map(summary), total: Number(count.total) });
}

// Exportación para el panel: CSV con BOM (Excel) y toda celda entre comillas. Un nombre que empiece
// por =, +, - o @ se prefija con apóstrofo para que la hoja no lo ejecute como fórmula.
async function adminCustomersCsv(env, slug) {
  const now = Date.now(),
    rows = await env.DB.prepare(
      `SELECT c.phone,c.name,c.birthday,c.stamps,c.visits,c.cards_completed,c.last_play_at,c.wallet_saved,
         (SELECT COUNT(*) FROM rewards r WHERE r.slug=c.slug AND r.phone=c.phone AND r.status='active'
            AND (r.expires_at IS NULL OR r.expires_at>?)) active_rewards
       FROM customers c WHERE c.slug=? ORDER BY c.last_play_at DESC,c.created_at DESC`,
    )
      .bind(now, slug)
      .all();
  const lines = [
    ["Nombre", "WhatsApp", "Cumpleaños", "Visitas", "Sellos", "Tarjetas completadas", "Última visita",
      "Guardó Wallet", "Premios activos"],
  ];
  for (const x of rows.results)
    lines.push([
      x.name,
      x.phone,
      x.birthday || "",
      Number(x.visits),
      Number(x.stamps),
      Number(x.cards_completed),
      ecDate(x.last_play_at),
      Number(x.wallet_saved) ? "Sí" : "No",
      Number(x.active_rewards),
    ]);
  const csv = "\uFEFF" + lines.map(line => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="clientes-${slug}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
const csvCell = value => {
  const raw = String(value ?? "");
  return `"${(/^[=+\-@]/.test(raw) ? `'${raw}` : raw).replace(/"/g, '""')}"`;
};
const EC_DATE = new Intl.DateTimeFormat("es-EC", {
  timeZone: "America/Guayaquil",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const ecDate = ms => (ms == null ? "" : EC_DATE.format(new Date(Number(ms))));

async function adminFeedback(env, slug, url) {
  const limit = bound(url.searchParams.get("limit"), 50, 1, 100),
    offset = bound(url.searchParams.get("offset"), 0, 0, 1e6);
  if (limit == null || offset == null) return error("paginacion_invalida", 400);
  const [rows, count, avg] = await Promise.all([
    env.DB.prepare(
      `SELECT f.id,f.rating,f.comment,f.phone,f.created_at,c.name FROM feedback f
       LEFT JOIN customers c ON c.slug=f.slug AND c.phone=f.phone
       WHERE f.slug=? ORDER BY f.created_at DESC,f.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(slug, limit, offset)
      .all(),
    env.DB.prepare("SELECT COUNT(*) total FROM feedback WHERE slug=?").bind(slug).first(),
    env.DB.prepare("SELECT AVG(rating) avg FROM feedback WHERE slug=?").bind(slug).first(),
  ]);
  return json({
    items: rows.results.map(x => ({
      rating: Number(x.rating),
      comment: x.comment,
      name: x.name || "",
      phone: x.phone,
      created_at: Number(x.created_at),
    })),
    total: Number(count.total),
    avg: avg?.avg == null ? 0 : Math.round(Number(avg.avg) * 10) / 10,
  });
}
async function adminCustomer(env, slug, encoded) {
  let phone;
  try {
    phone = decodeURIComponent(encoded);
  } catch {
    return error("cliente_no_encontrado", 404);
  }
  const c = await customer(env, slug, phone);
  if (!c) return error("cliente_no_encontrado", 404);
  const now = Date.now(),
    [rr, pp] = await Promise.all([
      env.DB.prepare(
        "SELECT r.*,s.name redeemed_by FROM rewards r LEFT JOIN staff s ON s.slug=r.slug AND s.id=r.redeemed_staff_id WHERE r.slug=? AND r.phone=? ORDER BY r.created_at DESC",
      )
        .bind(slug, phone)
        .all(),
      env.DB.prepare(
        "SELECT p.*,s.name staff_name FROM plays p LEFT JOIN staff s ON s.slug=p.slug AND s.id=p.staff_id WHERE p.slug=? AND p.phone=? ORDER BY p.created_at DESC LIMIT 50",
      )
        .bind(slug, phone)
        .all(),
    ]),
    rewards = rr.results.map(x => ({
      id: x.id,
      prize_id: x.prize_id,
      label: x.label,
      source: x.source,
      status: rewardPublic(x, now).status,
      pin_fails: Number(x.pin_fails),
      created_at: Number(x.created_at),
      expires_at: x.expires_at == null ? null : Number(x.expires_at),
      redeemed_at: x.redeemed_at == null ? null : Number(x.redeemed_at),
      redeemed_by: x.redeemed_by || null,
    })),
    plays = pp.results.map(x => ({
      id: Number(x.id),
      game: x.game,
      prize_id: x.prize_id,
      reward_id: x.reward_id,
      via: x.via,
      lat: x.lat == null ? null : Number(x.lat),
      lng: x.lng == null ? null : Number(x.lng),
      created_at: Number(x.created_at),
      staff_name: x.staff_name || null,
    }));
  return json({
    customer: {
      ...summary({ ...c, active_rewards: rewards.filter(x => x.status === "active").length }),
      created_at: Number(c.created_at),
    },
    rewards,
    plays,
  });
}
async function adminCampaign(request, env, slug) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const title = typeof b.title === "string" ? b.title.trim() : "",
    message = typeof b.body === "string" ? b.body.trim() : "";
  if (!title || title.length > 60) return error("titulo_invalido", 400);
  if (!message || message.length > 500) return error("cuerpo_invalido", 400);
  const rows = await env.DB.prepare("SELECT phone FROM customers WHERE slug=? AND wallet_saved=1 ORDER BY phone LIMIT 901")
    .bind(slug)
    .all();
  if (rows.results.length > 900) return error("demasiados_destinatarios", 413);
  const out = await walletNotify(
      env,
      slug,
      rows.results.map(x => x.phone),
      { title, body: message },
    ),
    sent = Number(out?.sent || 0),
    failed = Number(out?.failed || 0);
  await env.DB.prepare("INSERT INTO campaigns (slug,title,body,sent,failed,created_at) VALUES (?,?,?,?,?,?)")
    .bind(slug, title, message, sent, failed, Date.now())
    .run();
  return json({ sent, failed });
}
async function adminCampaigns(env, slug) {
  const r = await env.DB.prepare(
    "SELECT id,title,body,sent,failed,created_at FROM campaigns WHERE slug=? ORDER BY created_at DESC,id DESC LIMIT 20",
  )
    .bind(slug)
    .all();
  return json(
    r.results.map(x => ({
      ...x,
      id: Number(x.id),
      sent: Number(x.sent),
      failed: Number(x.failed),
      created_at: Number(x.created_at),
    })),
  );
}
const creditPublic = x => ({
  id: x.id,
  order_id: x.order_id,
  phone: x.phone,
  source: x.source,
  status: x.status,
  created_at: Number(x.created_at),
  granted_at: x.granted_at == null ? null : Number(x.granted_at),
  used_at: x.used_at == null ? null : Number(x.used_at),
  granted_by: x.granted_by || null,
});
const CREDIT_STATUSES = ["pending", "granted", "used", "rejected"];
// Alta desde el panel al entrar un pedido a domicilio. Idempotente por order_id y con tope
// de un crédito por teléfono cada 24 h para frenar el farming de pedidos.
async function createCredit(request, env, slug) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  // El panel puede mandar el id del pedido como número (orders.id) o como texto.
  const raw = b.order_id,
    orderId = typeof raw === "string" ? raw.trim() : Number.isInteger(raw) ? String(raw) : "",
    loy = await env.MENUS?.get?.(`${slug}:loyalty`, "json"),
    cfg = normalizeConfig(loy),
    phone = normalizePhone(b.phone, cfg.phone_country);
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(orderId)) return error("order_id_invalido", 400);
  if (!phone) return error("telefono_invalido", 400);
  const existing = await env.DB.prepare("SELECT * FROM credits WHERE slug=? AND order_id=?").bind(slug, orderId).first();
  if (existing) return json(creditPublic(existing));
  const now = Date.now(),
    recent = await env.DB.prepare("SELECT 1 FROM credits WHERE slug=? AND phone=? AND created_at>? LIMIT 1")
      .bind(slug, phone, now - DAY)
      .first();
  if (recent) return error("limite_diario", 409);
  const row = { id: crypto.randomUUID(), order_id: orderId, phone, source: "delivery", status: "pending", created_at: now };
  await env.DB.prepare(
    "INSERT INTO credits (id,slug,phone,order_id,source,status,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(row.id, slug, phone, orderId, row.source, row.status, now)
    .run();
  return json(creditPublic(row), 201);
}
async function resolveCredit(env, slug, encoded, action) {
  let orderId;
  try {
    orderId = decodeURIComponent(encoded);
  } catch {
    return error("credito_no_encontrado", 404);
  }
  const now = Date.now(),
    status = action === "grant" ? "granted" : "rejected",
    sql =
      action === "grant"
        ? "UPDATE credits SET status='granted',granted_at=?,granted_by='owner' WHERE slug=? AND order_id=? AND status='pending'"
        : "UPDATE credits SET status='rejected' WHERE slug=? AND order_id=? AND status='pending'";
  const r = await env.DB.prepare(sql)
    .bind(...(action === "grant" ? [now, slug, orderId] : [slug, orderId]))
    .run();
  const row = await env.DB.prepare("SELECT * FROM credits WHERE slug=? AND order_id=?").bind(slug, orderId).first();
  if (!row) return error("credito_no_encontrado", 404);
  if (!r.meta.changes && row.status !== status) return error("estado_invalido", 409);
  return json(creditPublic(row));
}
async function adminCredits(env, slug, url) {
  const status = url.searchParams.get("status");
  if (status && !CREDIT_STATUSES.includes(status)) return error("estado_invalido", 400);
  const where = status ? "slug=? AND status=?" : "slug=?",
    args = status ? [slug, status] : [slug],
    [rows, count] = await Promise.all([
      env.DB.prepare(`SELECT * FROM credits WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 200`)
        .bind(...args)
        .all(),
      env.DB.prepare(`SELECT COUNT(*) total FROM credits WHERE ${where}`).bind(...args).first(),
    ]);
  return json({ items: rows.results.map(creditPublic), total: Number(count.total) });
}
const staffPublic = x => ({
  id: x.id,
  name: x.name,
  active: Boolean(x.active),
  created_at: Number(x.created_at),
  rotated_at: x.rotated_at == null ? null : Number(x.rotated_at),
});
async function adminStaff(env, slug) {
  const r = await env.DB.prepare("SELECT id,name,active,created_at,rotated_at FROM staff WHERE slug=? ORDER BY created_at,id")
    .bind(slug)
    .all();
  return json({ items: r.results.map(staffPublic) });
}
async function staffInput(b, slug) {
  const name = typeof b?.name === "string" ? [...b.name.trim()].slice(0, 60).join("") : "",
    pin = String(b?.pin ?? "");
  if (!name) return { error: "nombre_invalido" };
  if (!/^\d{4,6}$/.test(pin)) return { error: "pin_invalido" };
  return { name, pin, hash: await hash(`${slug}:${pin}`) };
}
async function duplicate(env, slug, pin, id) {
  return Boolean(
    await env.DB.prepare(`SELECT 1 FROM staff WHERE slug=? AND active=1 AND pin_hash=? ${id ? "AND id<>?" : ""} LIMIT 1`)
      .bind(slug, pin, ...(id ? [id] : []))
      .first(),
  );
}
async function createStaff(request, env, slug) {
  const input = await staffInput(await body(request), slug);
  if (input.error) return error(input.error, 400);
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM staff WHERE slug=? AND active=1").bind(slug).first();
  if (Number(n.n) >= 30) return error("limite_meseros", 429);
  if (await duplicate(env, slug, input.hash)) return error("pin_repetido", 409);
  const row = { id: crypto.randomUUID(), ...input, active: 1, created_at: Date.now() };
  await env.DB.prepare("INSERT INTO staff (id,slug,name,pin_hash,active,created_at) VALUES (?,?,?,?,?,?)")
    .bind(row.id, slug, row.name, row.hash, 1, row.created_at)
    .run();
  return json(staffPublic(row), 201);
}
async function updateStaff(request, env, slug, id) {
  const old = await env.DB.prepare("SELECT * FROM staff WHERE slug=? AND id=?").bind(slug, id).first();
  if (!old) return error("mesero_no_encontrado", 404);
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  let name = old.name,
    active = Number(old.active),
    pin = null,
    rotated = old.rotated_at;
  if (b.name !== undefined) {
    name = typeof b.name === "string" ? [...b.name.trim()].slice(0, 60).join("") : "";
    if (!name) return error("nombre_invalido", 400);
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") return error("estado_invalido", 400);
    active = Number(b.active);
    if (active && !old.active) {
      const n = await env.DB.prepare("SELECT COUNT(*) n FROM staff WHERE slug=? AND active=1").bind(slug).first();
      if (Number(n.n) >= 30) return error("limite_meseros", 429);
    }
  }
  if (b.pin !== undefined) {
    if (!/^\d{4,6}$/.test(String(b.pin))) return error("pin_invalido", 400);
    pin = await hash(`${slug}:${b.pin}`);
    if (await duplicate(env, slug, pin, id)) return error("pin_repetido", 409);
    rotated = Date.now();
  }
  await env.DB.prepare("UPDATE staff SET name=?,active=?,pin_hash=COALESCE(?,pin_hash),rotated_at=? WHERE slug=? AND id=?")
    .bind(name, active, pin, rotated, slug, id)
    .run();
  return json(staffPublic({ ...old, name, active, rotated_at: rotated }));
}
async function deleteStaff(env, slug, id) {
  const r = await env.DB.prepare("UPDATE staff SET active=0 WHERE slug=? AND id=?").bind(slug, id).run();
  return r.meta.changes ? new Response(null, { status: 204 }) : error("mesero_no_encontrado", 404);
}

// ---- Modo caja: el mesero escanea la tarjeta del cliente desde el panel ----

async function adminSite(env, slug) {
  const [loyalty, menu] = await Promise.all([
    env.MENUS?.get?.(`${slug}:loyalty`, "json"),
    env.MENUS?.get?.(`${slug}:config`, "json"),
  ]);
  return { slug, cfg: normalizeConfig(loyalty), menuCfg: menu || {} };
}
// Identidad del mesero en la caja: 'owner' (dueño con sesión del panel) o un mesero activo del local.
async function activeStaff(env, slug, id) {
  if (id === "owner") return { id: "owner", name: "Dueño" };
  // El PIN general (clubs anteriores a los meseros) vale mientras siga configurado.
  if (id === "legacy") return (await adminSite(env, slug))?.cfg?.staff_pin_hash ? { id: "legacy", name: "PIN general" } : null;
  if (typeof id !== "string" || !id) return null;
  return env.DB.prepare("SELECT id,name FROM staff WHERE slug=? AND id=? AND active=1").bind(slug, id).first();
}
function cardCodeParam(encoded) {
  try {
    return parseCardCode(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}
async function syncCard(ctx, env, site, phone) {
  const current = await buildMe(env, site, phone);
  if (current?.customer.wallet_saved) sync(ctx, env, site, current);
  return current;
}
const scanPending = (env, slug, phone) =>
  env.DB.prepare("SELECT 1 FROM credits WHERE slug=? AND phone=? AND source='scan' AND status='granted' LIMIT 1")
    .bind(slug, phone)
    .first();

// Ficha para la caja: nombre, últimos cuatro dígitos, sellos, créditos y premios canjeables.
// Nunca el teléfono completo. `next_visit_at` sale de la última visita o del último crédito `scan`.
async function cardView(env, site, phone, now) {
  const c = await customer(env, site.slug, phone);
  if (!c) return null;
  const [creditRows, rewardRows, scan] = await Promise.all([
    env.DB.prepare("SELECT SUM(status='granted') granted,SUM(status='pending') pending FROM credits WHERE slug=? AND phone=?")
      .bind(site.slug, phone)
      .first(),
    env.DB.prepare(
      `SELECT id,label,source,expires_at FROM rewards
       WHERE slug=? AND phone=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
       ORDER BY created_at DESC,id`,
    )
      .bind(site.slug, phone, now)
      .all(),
    env.DB.prepare(
      "SELECT MAX(granted_at) at FROM credits WHERE slug=? AND phone=? AND source='scan' AND granted_at IS NOT NULL",
    )
      .bind(site.slug, phone)
      .first(),
  ]);
  const last = Math.max(Number(c.last_play_at || 0), Number(scan?.at || 0)) || null,
    next = last == null ? null : last + site.cfg.cooldown_hours * HOUR;
  return {
    name: c.name,
    phone_tail: String(c.phone).slice(-4),
    stamps: Number(c.stamps),
    stamps_goal: site.cfg.stamps_goal,
    visits: Number(c.visits),
    cards_completed: Number(c.cards_completed),
    last_play_at: c.last_play_at == null ? null : Number(c.last_play_at),
    next_visit_at: next && now < next ? next : null,
    credits: { granted: Number(creditRows?.granted || 0), pending: Number(creditRows?.pending || 0) },
    rewards: rewardRows.results.map(x => ({
      id: x.id,
      label: x.label,
      source: x.source,
      expires_at: x.expires_at == null ? null : Number(x.expires_at),
    })),
  };
}

async function verifyStaff(request, env, slug) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const { cfg } = await adminSite(env, slug),
    id = await validPin(env, slug, b.pin, cfg.staff_pin_hash);
  if (!id) return error("pin_invalido", 403);
  if (id === "legacy") return json({ staff: { id: "legacy", name: "PIN general" } });
  const row = await env.DB.prepare("SELECT id,name FROM staff WHERE slug=? AND id=? AND active=1").bind(slug, id).first();
  return row ? json({ staff: { id: row.id, name: row.name } }) : error("pin_invalido", 403);
}

async function adminCard(env, slug, encoded) {
  const code = cardCodeParam(encoded);
  if (!code) return error("tarjeta_no_encontrada", 404);
  const site = await adminSite(env, slug),
    row = await env.DB.prepare("SELECT phone FROM customers WHERE slug=? AND card_code=?").bind(slug, code).first();
  if (!row) return error("tarjeta_no_encontrada", 404);
  const card = await cardView(env, site, row.phone, Date.now());
  return card ? json({ card, play_mode: site.cfg.play_mode }) : error("tarjeta_no_encontrada", 404);
}

async function adminVisit(request, env, ctx, slug, encoded) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const staff = await activeStaff(env, slug, b.staff_id);
  if (!staff) return error("mesero_inactivo", 403);
  const code = cardCodeParam(encoded);
  if (!code) return error("tarjeta_no_encontrada", 404);
  const site = await adminSite(env, slug),
    now = Date.now(),
    row = await env.DB.prepare("SELECT * FROM customers WHERE slug=? AND card_code=?").bind(slug, code).first();
  if (!row) return error("tarjeta_no_encontrada", 404);
  const card = await cardView(env, site, row.phone, now);
  if (!card) return error("tarjeta_no_encontrada", 404);
  if (card.next_visit_at) return error("cooldown", 429, { next_play_at: card.next_visit_at });
  if (await scanPending(env, slug, row.phone)) return error("visita_pendiente", 409);

  if (site.cfg.play_mode === "stamps") {
    // La guardia repite el cooldown dentro del batch por si dos meseros escanean a la vez.
    const { stmts, stampsAt, stampId } = visitStatements(env, site.cfg, {
      slug,
      phone: row.phone,
      now,
      game: "stamp",
      via: "scan",
      staffId: staff.id,
      guardSql:
        "CASE WHEN (SELECT last_play_at IS NULL OR last_play_at<=? FROM customers WHERE slug=? AND phone=?) THEN ? ELSE NULL END",
      guardArgs: [now - site.cfg.cooldown_hours * HOUR, slug, row.phone],
    });
    let batch;
    try {
      batch = await env.DB.batch(stmts);
    } catch {
      if (await scanPending(env, slug, row.phone)) return error("visita_pendiente", 409);
      const fresh = await cardView(env, site, row.phone, now);
      return error("cooldown", 429, { next_play_at: fresh?.next_visit_at || now });
    }
    const completed = batch[stampsAt].meta.changes > 0;
    await syncCard(ctx, env, site, row.phone);
    return json({
      result: { card_completed: completed, stamps_reward_id: completed ? stampId : null },
      card: await cardView(env, site, row.phone, now),
    });
  }

  // Modo juego: la visita crea un crédito `scan` que el cliente juega desde su celular.
  await env.DB.prepare(
    "UPDATE credits SET status='granted',granted_at=?,granted_by=? WHERE slug=? AND phone=? AND status='pending' AND source='delivery'",
  )
    .bind(now, staff.id, slug, row.phone)
    .run();
  const id = crypto.randomUUID(),
    inserted = await env.DB.prepare(
      `INSERT INTO credits (id,slug,phone,order_id,source,status,created_at,granted_at,granted_by)
       SELECT ?,?,?,?,'scan','granted',?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM credits WHERE slug=? AND phone=? AND source='scan' AND status='granted')`,
    )
      .bind(id, slug, row.phone, `scan:${id}`, now, now, staff.id, slug, row.phone)
      .run();
  if (!inserted.meta.changes) return error("visita_pendiente", 409);
  await syncCard(ctx, env, site, row.phone);
  return json({ credit_id: id, card: await cardView(env, site, row.phone, now) });
}

async function adminRedeem(request, env, ctx, slug, encoded) {
  const b = await body(request);
  if (!b) return error("json_invalido", 400);
  const staff = await activeStaff(env, slug, b.staff_id);
  if (!staff) return error("mesero_inactivo", 403);
  let id;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return error("premio_no_encontrado", 404);
  }
  const now = Date.now(),
    r = await env.DB.prepare("SELECT * FROM rewards WHERE id=? AND slug=?").bind(id, slug).first();
  if (!r) return error("premio_no_encontrado", 404);
  if (r.status === "redeemed") return error("ya_canjeado", 409);
  if (r.expires_at != null && Number(r.expires_at) <= now) return error("vencido", 409);
  const updated = await env.DB.prepare(
    "UPDATE rewards SET status='redeemed',redeemed_at=?,redeemed_staff_id=? WHERE id=? AND slug=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",
  )
    .bind(now, staff.id, id, slug, now)
    .run();
  if (!updated.meta.changes) {
    const fresh = await env.DB.prepare("SELECT status FROM rewards WHERE id=? AND slug=?").bind(id, slug).first();
    return fresh?.status === "redeemed" ? error("ya_canjeado", 409) : error("vencido", 409);
  }
  const site = await adminSite(env, slug),
    current = await buildMe(env, site, r.phone, now);
  if (current?.customer.wallet_saved) sync(ctx, env, site, current);
  return json({ reward: rewardPublic({ ...r, status: "redeemed", redeemed_at: now }, now) });
}

const summary = x => ({
  phone: x.phone,
  name: x.name,
  birthday: x.birthday || null,
  stamps: Number(x.stamps),
  visits: Number(x.visits),
  cards_completed: Number(x.cards_completed),
  last_play_at: x.last_play_at == null ? null : Number(x.last_play_at),
  active_rewards: Number(x.active_rewards || 0),
  wallet_saved: Number(x.wallet_saved),
});
function bound(raw, f, min, max) {
  if (raw == null || raw === "") return f;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
