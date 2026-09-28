(() => {
  "use strict";

  if (window.__discordDumpLoaded) return;
  window.__discordDumpLoaded = true;

  const { format, kfmt } = globalThis.DiscordDumpFormat;
  const storage = localStore();
  const API = "/api/v9";
  const EPOCH = 1420070400000n;
  const DAY = 864e5;
  const RATE_LIMIT_PAD_MS = 250;

  function localStore() {
    if (window.localStorage) return window.localStorage;
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    try {
      document.documentElement.appendChild(frame);
      return Object.getOwnPropertyDescriptor(frame.contentWindow, "localStorage").get.call(window);
    } catch {
      return null;
    } finally {
      frame.remove();
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---------- session: reuse the headers Discord itself sends ----------

  const WANT = new Set(["authorization", "x-super-properties", "x-discord-locale", "x-discord-timezone", "x-debug-options"]);
  const captured = {};
  const apiXhr = new WeakSet();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;

  function isApiUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && /^\/api\/v\d+\//.test(u.pathname);
    } catch {
      return false;
    }
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    apiXhr.delete(this);
    const result = origOpen.call(this, method, url, ...rest);
    if (isApiUrl(url)) apiXhr.add(this);
    return result;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
    const result = origSet.call(this, key, value);
    const k = String(key).toLowerCase();
    if (apiXhr.has(this) && WANT.has(k)) captured[k] = value;
    return result;
  };

  function findInClient(test) {
    let found = null;
    try {
      window.webpackChunkdiscord_app.push([[Symbol("discord-dump")], {}, (req) => {
        for (const id in req.c) {
          const e = req.c[id] && req.c[id].exports;
          if (!e) continue;
          for (const k of [e, e.default, e.Z, e.A, e.Ay]) {
            try {
              if (!found && k && test(k)) found = k;
            } catch {}
          }
        }
      }]);
      window.webpackChunkdiscord_app.pop();
    } catch {}
    return found;
  }

  function tokenFromClient() {
    const auth = findInClient((k) => typeof k.getToken === "function" && typeof k.getToken() === "string" && k.getToken().length > 20);
    return auth ? auth.getToken() : null;
  }

  function headers() {
    const h = { ...captured };
    if (!h.authorization) h.authorization = tokenFromClient();
    if (!h.authorization) throw new Error("Couldn't read your Discord session. Reload the tab and try again.");
    return h;
  }

  let cooldownUntil = 0;

  const isGlobalLimit = (r, body) =>
    body.global === true || r.headers.get("x-ratelimit-global") === "true" || r.headers.get("x-ratelimit-scope") === "global";

  async function api(path, signal) {
    for (let attempt = 0; ; attempt++) {
      while (cooldownUntil > Date.now()) await sleep(cooldownUntil - Date.now(), signal);
      const r = await fetch(API + path, { headers: headers(), signal });
      if (r.ok) return r.json();
      if (r.status === 429) {
        const body = await r.json().catch(() => ({}));
        const wait = (Number(body.retry_after) || 1) * 1000 + RATE_LIMIT_PAD_MS;
        if (isGlobalLimit(r, body)) cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        else await sleep(wait, signal);
        continue;
      }
      if (r.status >= 500 && attempt < 3) {
        await sleep(1000 * (attempt + 1), signal);
        continue;
      }
      const err = new Error(`Discord answered ${r.status}`);
      err.status = r.status;
      throw err;
    }
  }

  const tryApi = (path, signal) => api(path, signal).catch(() => null);
  const toSnowflake = (ms) => (ms <= Number(EPOCH) ? 0n : (BigInt(Math.floor(ms)) - EPOCH) << 22n);
  const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + EPOCH);
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  // ---------- metadata ----------

  const THREAD_TYPES = new Set([10, 11, 12]);
  const CONTAINER_NOTICES = new Map([
    [4, "This is a category. Open one of its channels and export that."],
    [15, "This is a forum. Open a post and export that."],
    [16, "This is a media channel. Open a post and export that."],
  ]);
  const MOD_BITS = [1n << 1n, 1n << 2n, 1n << 3n, 1n << 5n, 1n << 13n, 1n << 28n, 1n << 40n];

  function staffRolesOf(roles, guildId) {
    const listed = roles.filter((r) => r.hoist && !r.managed && r.id !== guildId);
    const modPositions = listed.filter((r) => MOD_BITS.some((b) => BigInt(r.permissions) & b)).map((r) => r.position);
    if (!modPositions.length) return [];
    const floor = Math.min(...modPositions);
    return listed.filter((r) => r.position >= floor).sort((a, b) => b.position - a.position).slice(0, 10);
  }

  async function loadMeta(channelId, signal) {
    const c = await api(`/channels/${channelId}`, signal);
    const notice = CONTAINER_NOTICES.get(c.type);
    if (notice) return { notice };
    const meta = { channel: { name: c.name ? "#" + c.name : "", topic: c.topic || "" }, roles: new Map(), channels: new Map(), staffRoles: [] };
    if (!c.guild_id) {
      const people = (c.recipients || []).map((u) => u.global_name || u.username);
      meta.channel.guild = "Direct Messages";
      meta.channel.name = c.name || people.join(", ");
      return meta;
    }
    const isThread = THREAD_TYPES.has(c.type);
    const [guild, roles, parent] = await Promise.all([
      tryApi(`/guilds/${c.guild_id}`, signal),
      tryApi(`/guilds/${c.guild_id}/roles`, signal),
      isThread ? tryApi(`/channels/${c.parent_id}`, signal) : null,
    ]);
    meta.guildId = c.guild_id;
    meta.channel.guild = guild ? guild.name : document.title.split("|").pop().trim();
    if (isThread) {
      meta.channel.parent = parent ? parent.name : "";
      meta.channel.name = "thread: " + c.name;
    }
    for (const r of roles || []) meta.roles.set(r.id, r.name);
    meta.staffRoles = roles ? staffRolesOf(roles, c.guild_id) : null;
    return meta;
  }

  const STAFF_TTL = 7 * DAY;

  async function loadChannelNames(meta, signal) {
    if (!meta.guildId) return;
    const store = findInClient((k) => typeof k.getName === "function" && k.getName() === "ChannelStore" && typeof k.getChannel === "function");
    if (store) {
      meta.channels = { get: (id) => (store.getChannel(id) || {}).name };
      return;
    }
    for (const ch of (await tryApi(`/guilds/${meta.guildId}/channels`, signal)) || []) meta.channels.set(ch.id, ch.name);
  }

  async function loadStaff(meta, signal) {
    if (!meta.guildId) return new Map();
    const key = `discord-dump-staff-${meta.guildId}`;
    let cached = null;
    try {
      cached = JSON.parse(storage.getItem(key) || "null");
    } catch {}
    const fallback = () => new Map(cached ? cached.entries : []);
    if (!meta.staffRoles) return fallback();
    const roleKey = meta.staffRoles.map((r) => r.id + r.name).join();
    if (cached && cached.roleKey === roleKey && Date.now() - cached.at < STAFF_TTL) return fallback();

    const staff = new Map();
    let complete = true;
    for (const role of meta.staffRoles) {
      try {
        const ids = await api(`/guilds/${meta.guildId}/roles/${role.id}/member-ids`, signal);
        for (const id of ids) if (!staff.has(id)) staff.set(id, role.name);
      } catch (e) {
        if (signal.aborted) throw e;
        complete = false;
      }
    }
    if (!complete) return cached ? fallback() : staff;
    try {
      storage.setItem(key, JSON.stringify({ at: Date.now(), roleKey, entries: [...staff] }));
    } catch {}
    return staff;
  }

  // ---------- messages: walk forward from the start of the range ----------

  async function collect(channelId, fromMs, toMs, onProgress, signal) {
    const messages = [];
    const startMs = Math.max(fromMs, snowflakeMs(channelId));
    const endMs = Math.min(toMs, Date.now());
    let after = toSnowflake(fromMs);
    if (after > 0n) after -= 1n;
    try {
      while (true) {
        const page = await api(`/channels/${channelId}/messages?limit=100&after=${after}`, signal);
        if (!page.length) break;
        page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        let pastEnd = false;
        for (const m of page) {
          if (Date.parse(m.timestamp) > toMs) { pastEnd = true; break; }
          messages.push(m);
        }
        after = BigInt(page[page.length - 1].id);
        const at = Date.parse(page[page.length - 1].timestamp);
        onProgress(messages.length, Math.min(1, Math.max(0, (at - startMs) / Math.max(1, endMs - startMs))), at);
        if (pastEnd || page.length < 100) break;
      }
    } catch (e) {
      return signal.aborted ? { messages, stopped: true } : { messages, error: e };
    }
    return { messages };
  }

  // ---------- output ----------

  const safe = (s) => (s || "").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60);

  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const duration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  };

  // ---------- UI ----------

  const PRESETS = [["30d", 30], ["90d", 90], ["1y", 365], ["2y", 730], ["All", 0]];

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "dd-panel";
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "discord-dump");
    panel.innerHTML = `
      <div id="dd-head">
        <span>discord-dump</span>
        <button id="dd-close" type="button" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="dd-presets" role="group" aria-label="Range">${PRESETS.map(([l]) => `<button type="button" data-preset="${l}" aria-pressed="false">${l}</button>`).join("")}</div>
      <div class="dd-row">
        <label>From (UTC) <input type="date" id="dd-from"></label>
        <label>To (UTC) <input type="date" id="dd-to"></label>
      </div>
      <button id="dd-run" type="button">Export .txt</button>
      <div id="dd-bar"><div></div></div>
      <div class="dd-foot">
        <div id="dd-status" role="status">Pick a range.</div>
        <button id="dd-stop" type="button" disabled>Stop</button>
      </div>
    `;
    document.body.append(panel);

    const $ = (sel) => panel.querySelector(sel);
    const status = $("#dd-status");
    const bar = $("#dd-bar > div");
    const fromEl = $("#dd-from");
    const toEl = $("#dd-to");
    const presetButtons = [...panel.querySelectorAll("[data-preset]")];
    let controller = null;

    const markPreset = (label) => presetButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === label)));
    const setPreset = (label) => {
      const days = PRESETS.find(([l]) => l === label)[1];
      const now = Date.now();
      toEl.value = utcDay(now);
      fromEl.value = days ? utcDay(now - days * DAY) : "";
      markPreset(label);
      status.textContent = days ? `Last ${label}.` : "Whole channel history.";
    };
    presetButtons.forEach((b) => (b.onclick = () => setPreset(b.dataset.preset)));
    [fromEl, toEl].forEach((el) => (el.oninput = () => markPreset(null)));
    setPreset("30d");

    window.addEventListener("discord-dump:toggle", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.focus({ preventScroll: true });
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      panel.hidden = true;
    });
    $("#dd-close").onclick = () => (panel.hidden = true);
    $("#dd-stop").onclick = () => {
      controller.abort();
      status.textContent = "Stopping, saving what's loaded\u2026";
    };

    $("#dd-run").onclick = async () => {
      const [, , guildPart, channelId] = location.pathname.split("/");
      if (!/^\d+$/.test(channelId || "")) {
        status.textContent = "Open a channel first.";
        return;
      }
      const fromMs = fromEl.value ? Date.parse(fromEl.value + "T00:00:00Z") : 0;
      const toMs = toEl.value ? Date.parse(toEl.value + "T23:59:59.999Z") : Date.now();
      if (fromMs > toMs) {
        status.textContent = "'From' is after 'To'.";
        return;
      }
      const from = fromEl.value || utcDay(snowflakeMs(channelId));
      const to = toEl.value || utcDay(Date.now());

      controller = new AbortController();
      const { signal } = controller;
      $("#dd-run").disabled = true;
      $("#dd-stop").disabled = false;
      bar.style.width = "0%";
      const t0 = performance.now();

      try {
        status.textContent = "Reading channel info\u2026";
        const meta = await loadMeta(channelId, signal);
        if (meta.notice) {
          status.textContent = meta.notice;
          return;
        }
        const extrasPromise = Promise.all([loadStaff(meta, signal), loadChannelNames(meta, signal)]).catch(() => [new Map()]);
        const { messages, stopped, error } = await collect(
          channelId,
          fromMs,
          toMs,
          (count, frac, at) => {
            const elapsed = performance.now() - t0;
            const eta = frac > 0.02 ? ` ETA ${duration((elapsed / frac) * (1 - frac))}` : "";
            bar.style.width = (frac * 100).toFixed(1) + "%";
            status.textContent = `${count.toLocaleString()} msgs, at ${utcDay(at)}, ${Math.round(frac * 100)}%.${eta}`;
          },
          signal
        );
        if (!messages.length) {
          if (error) throw error;
          status.textContent = stopped ? "Stopped before anything loaded." : "No messages in that range.";
          return;
        }
        status.textContent = "Tagging staff and channels\u2026";
        const [staff] = await extrasPromise;
        const untagged = signal.aborted && !stopped ? " Stopped before staff were tagged." : "";

        const partial = error ? `stopped by an error (${error.message})` : stopped ? "stopped early" : null;
        const { text, stats } = format({
          messages,
          channel: meta.channel,
          range: { from, to },
          staff,
          roles: meta.roles,
          channels: meta.channels,
          partial,
          url: `https://discord.com/channels/${guildPart}/${channelId}`,
        });
        const name = ["discord", safe(meta.channel.guild), safe(meta.channel.parent), safe(meta.channel.name), from, "to", to].filter(Boolean).join("_");
        download(text, `${name}${partial ? "_partial" : ""}.txt`);
        bar.style.width = "100%";
        const summary = `${stats.messages.toLocaleString()} msgs, ${stats.lines.toLocaleString()} lines, ~${kfmt(stats.tokens)} tokens in ${duration(performance.now() - t0)}.`;
        if (error) {
          status.textContent = `Error: ${error.message}. Saved a partial file: ${summary}`;
          console.error("[discord-dump]", error);
        } else {
          status.textContent = `${stopped ? "Partial. " : "Done. "}${summary}${untagged}`;
        }
      } catch (e) {
        if (signal.aborted) {
          status.textContent = "Stopped before anything loaded.";
          return;
        }
        status.textContent = "Error: " + e.message;
        console.error("[discord-dump]", e);
      } finally {
        controller.abort();
        $("#dd-run").disabled = false;
        $("#dd-stop").disabled = true;
      }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildPanel);
  else buildPanel();
})();
