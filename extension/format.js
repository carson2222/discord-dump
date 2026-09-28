(() => {
  "use strict";

  const KEEP_TYPES = new Set([0, 18, 19, 20, 21, 23]);
  const MAX_LINE = 1896;
  const INDENT = "  ";
  const SENTINEL = "\u0000";
  const REF_GROWTH = 8;

  const day = (iso) => iso.slice(0, 10);
  const minute = (d) => d.toISOString().slice(0, 16).replace("T", " ");
  const oneLine = (s) => s.replace(/\s+/g, " ").trim();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);
  const charsToTokens = (n) => Math.round(n / 3.7);
  const estTokens = (s) => charsToTokens(s.length);
  const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const num = (n) => n.toLocaleString("en-US");
  const byId = (a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function displayName(u) {
    if (!u) return "?";
    if ((u.username || "").startsWith("deleted_user_")) return "Deleted User";
    return oneLine((u.global_name || u.username || "?").replace(/\[/g, "(").replace(/\]/g, ")").replace(/:/g, "")) || "?";
  }

  function nameResolver(messages) {
    const idsByName = new Map();
    const note = (u) => {
      if (!u || !u.id) return;
      const n = displayName(u);
      if (!idsByName.has(n)) idsByName.set(n, new Map());
      idsByName.get(n).set(u.id, u.username);
    };
    for (const m of messages) {
      note(m.author);
      if (m.referenced_message) note(m.referenced_message.author);
    }
    return (u) => {
      const n = displayName(u);
      if (n === "Deleted User" || !u) return n;
      const ids = idsByName.get(n);
      return ids && ids.size > 1 && u.username && u.username !== n ? `${n} (@${u.username})` : n;
    };
  }

  function mapOutsideCode(text, fn) {
    return text
      .split(/(```[\s\S]*?```|`[^`\n]+`)/)
      .map((part, i) => (i % 2 ? part : fn(part)))
      .join("");
  }

  function stamp(token, seconds) {
    const d = new Date(Number(seconds) * 1000);
    return Number.isNaN(d.getTime()) ? token : minute(d) + " UTC";
  }

  function cleanContent(m, ctx) {
    const raw = (m.content || "").split(SENTINEL).join("");
    const mentions = new Map((m.mentions || []).map((u) => [u.id, u]));
    return mapOutsideCode(raw, (t) =>
      t
        .replace(/<@!?(\d+)>/g, (_, id) => "@" + (mentions.has(id) ? ctx.name(mentions.get(id)) : "user"))
        .replace(/<@&(\d+)>/g, (_, id) => "@" + (ctx.roles.get(id) || "role"))
        .replace(/<#(\d+)>/g, (_, id) => "#" + (ctx.channels.get(id) || "channel"))
        .replace(/<\/([\w -]+):\d+>/g, "/$1")
        .replace(/<a?:(\w+):\d+>/g, ":$1:")
        .replace(/<t:(-?\d+)(?::\w)?>/g, stamp)
    ).trim();
  }

  function extras(m, content) {
    const out = [];
    for (const a of m.attachments || []) {
      const type = (a.content_type || "").split("/")[0];
      out.push(type === "image" ? "[img]" : type === "video" ? "[video]" : `[file: ${a.filename}]`);
    }
    for (const s of m.sticker_items || []) out.push(`[sticker: ${s.name}]`);
    for (const e of m.embeds || []) {
      if (e.type === "gifv") { out.push("[gif]"); continue; }
      if (e.type !== "rich") continue;
      const parts = [e.author && e.author.name, e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)];
      const body = oneLine(parts.filter(Boolean).join(" | "));
      if (body && !content.includes(body)) out.push(`[embed: ${trunc(body, 300)}]`);
    }
    if (m.poll) {
      const q = m.poll.question && m.poll.question.text;
      const answers = (m.poll.answers || []).map((a) => a.poll_media && a.poll_media.text).filter(Boolean);
      out.push(`[poll: ${oneLine(q || "")} | ${answers.join(" / ")}]`);
    }
    if (m.thread) out.push(`[thread: ${oneLine(m.thread.name)}${m.thread.message_count ? `, ${m.thread.message_count} msgs` : ""}]`);
    return out;
  }

  function messageBody(m, ctx) {
    if (m.type === 18) return `[started thread: ${oneLine(m.content || "")}]`;
    const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
    const src = snap ? { ...snap, mentions: snap.mentions || [] } : m;
    let text = cleanContent(src, ctx);
    const x = extras(src, text);
    if (x.includes("[gif]") && /^https?:\/\/\S+$/.test(text)) text = "";
    const cmd = m.interaction_metadata && m.interaction_metadata.name || m.interaction && m.interaction.name;
    const parts = [cmd ? `[/${cmd}]` : "", snap ? "[fwd]" : "", text, ...x].filter(Boolean);
    return parts.join(" ") || "(no text)";
  }

  function wrap(line) {
    let max = line.includes(SENTINEL) ? MAX_LINE - REF_GROWTH : MAX_LINE;
    if (line.length <= max) return [line];
    const out = [];
    let rest = line;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut < max / 2) cut = max;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
      max = MAX_LINE - INDENT.length;
    }
    if (rest) out.push(rest);
    return out.map((s, i) => (i ? INDENT + s : s));
  }

  function format(input) {
    const { channel, range, staff = new Map(), roles = new Map(), channels = new Map(), partial = null, exportedAt = new Date(), url = "" } = input;
    const messages = input.messages.filter((m) => KEEP_TYPES.has(m.type)).sort(byId);
    const name = nameResolver(messages);
    const ctx = { name, roles, channels };
    const roleOf = (u) => (u && staff.has(u.id) ? oneLine(staff.get(u.id)) : "");
    const who = (u) => name(u) + (u && u.bot ? "[bot]" : "") + (roleOf(u) ? `[${roleOf(u)}]` : "");

    const body = [];
    const lineOf = new Map();
    const months = new Map();
    const authorCount = new Map();

    for (const raw of messages) {
      const m = raw.type === 21 && raw.referenced_message ? { ...raw.referenced_message, id: raw.id, type: 0, timestamp: raw.timestamp } : raw;
      const d = day(m.timestamp);
      let ref = "";
      if (m.message_reference && m.type === 19) {
        const rid = m.message_reference.message_id;
        if (lineOf.has(rid)) ref = ` ->${name(lineOf.get(rid).author)} ${SENTINEL}${lineOf.get(rid).idx}${SENTINEL}`;
        else if (m.referenced_message) ref = ` ->${name(m.referenced_message.author)} ${day(m.referenced_message.timestamp)} "${trunc(oneLine(cleanContent(m.referenced_message, ctx)), 100)}"`;
        else if (m.referenced_message === null) ref = " ->deleted";
        else ref = " ->unavailable";
      }
      const idx = body.length;
      lineOf.set(m.id, { idx, author: m.author });
      const text = messageBody(m, ctx);
      const lines = `${d} ${who(m.author)}${ref}: ${text}`.split("\n").filter((l, i) => i === 0 || l.trim());
      lines.forEach((l, i) => body.push(...wrap(i ? INDENT + l : l)));

      const mk = d.slice(0, 7);
      if (!months.has(mk)) months.set(mk, { start: idx, end: idx, msgs: 0, chars: 0 });
      const mo = months.get(mk);
      mo.end = body.length - 1;
      mo.msgs++;
      const key = m.author.id;
      if (!authorCount.has(key)) authorCount.set(key, { user: m.author, n: 0 });
      authorCount.get(key).n++;
    }
    for (const mo of months.values()) for (let i = mo.start; i <= mo.end; i++) mo.chars += body[i].length + 1;

    const authors = [...authorCount.values()].sort((a, b) => b.n - a.n);
    const staffGroups = new Map();
    for (const a of authors) {
      const role = roleOf(a.user);
      if (!role) continue;
      if (!staffGroups.has(role)) staffGroups.set(role, []);
      staffGroups.get(role).push(`${name(a.user)} ${a.n}`);
    }

    const title = [channel.guild, channel.parent ? "#" + channel.parent : "", channel.name].map((s) => oneLine(s || "")).filter(Boolean).join(" / ");
    const lastDay = messages.length ? day(messages[messages.length - 1].timestamp) : range.to;

    const header = (bodyStart, totalLines, tokens) => {
      const h = [`# Discord export: ${title}`];
      if (channel.topic) h.push(`Topic: ${trunc(oneLine(channel.topic), 500)}`);
      h.push(`Range: ${range.from} to ${range.to} (UTC). ${num(messages.length)} messages, ${num(authors.length)} authors, ${num(totalLines)} lines, ~${kfmt(tokens)} tokens.`);
      if (partial) h.push(`PARTIAL EXPORT: ${oneLine(partial)}, messages end at ${lastDay}.`);
      h.push(
        "Not included: thread replies, reactions, edit history, attachment and link contents.",
        'Each message is one line: "YYYY-MM-DD author: text". Indented lines continue the message above.',
        '"->bob L1234" replies to bob\'s message on line 1234. "->bob 2024-01-02 "text"" replies to a message before this range.',
        "[bot] marks bots. [Role] marks server staff." + (url ? ` Source: ${url}` : ""),
        `Exported ${minute(exportedAt)} UTC.`,
        "",
        "## Index (month: lines, messages, ~tokens)"
      );
      for (const [mk, mo] of months) h.push(`${mk}: L${bodyStart + mo.start}-${bodyStart + mo.end}, ${num(mo.msgs)} msgs, ~${kfmt(charsToTokens(mo.chars))}`);
      h.push("", "## People");
      if (staffGroups.size) h.push("Staff: " + [...staffGroups].map(([r, list]) => `${r}: ${list.join(", ")}`).join(". ") + ".");
      h.push("Top posters: " + authors.slice(0, 20).map((a) => `${name(a.user)} ${a.n}`).join(", ") + ".");
      h.push("", "## Messages");
      return h.flatMap(wrap).join("\n");
    };

    const headerLen = header(0, 0, 0).split("\n").length;
    const bodyStart = headerLen + 1;
    const resolved = body.map((l) => l.replace(/\u0000(\d+)\u0000/g, (_, i) => "L" + (bodyStart + Number(i))));
    const bodyText = resolved.join("\n");
    const totalLines = headerLen + resolved.length;
    const assemble = (tokens) => header(bodyStart, totalLines, tokens) + "\n" + bodyText + "\n";
    const tokens = estTokens(assemble(0));
    const text = assemble(tokens);

    return { text, stats: { messages: messages.length, authors: authors.length, lines: totalLines, tokens } };
  }

  const api = { format, estTokens, kfmt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.DiscordDumpFormat = api;
})();
