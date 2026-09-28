const test = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("../extension/format.js");

const alice = { id: "1", username: "alice", global_name: "Alice" };
const bob = { id: "2", username: "bob", global_name: null };
const bot = { id: "3", username: "pricebot", global_name: "PriceBot", bot: true };
const otherAlice = { id: "4", username: "alice2", global_name: "Alice" };

let seq = 1000;
const msg = (author, ts, content, extra = {}) => ({
  id: String(seq++), type: 0, author, timestamp: ts, content, mentions: [], attachments: [], embeds: [], ...extra,
});

function build() {
  seq = 1000;
  const q = msg(alice, "2026-01-01T10:00:00Z", "how do rate limits work?\n\n```js\nconst x = <@2>;\n```");
  const old = { ...msg(bob, "2025-12-01T10:00:00Z", "old   answer"), id: "900" };
  const messages = [
    msg(bob, "2026-01-02T09:00:00Z", "per address <@1> see <#77> <:hype:123> <t:1767225600:R>", { type: 19, message_reference: { message_id: "1000" }, mentions: [alice] }),
    q,
    msg(bot, "2026-01-02T10:00:00Z", "", { embeds: [{ type: "rich", title: "HYPE", description: "42.1" }] }),
    msg(bob, "2026-01-03T10:00:00Z", "", { attachments: [{ filename: "a.png", content_type: "image/png" }, { filename: "log.txt", content_type: "text/plain" }] }),
    msg(alice, "2026-01-03T11:00:00Z", "thanks", { type: 19, message_reference: { message_id: "900" }, referenced_message: old }),
    msg(bob, "2026-01-03T12:00:00Z", "gone", { type: 19, message_reference: { message_id: "5" }, referenced_message: null }),
    msg(otherAlice, "2026-02-01T12:00:00Z", "https://tenor.com/x", { embeds: [{ type: "gifv", url: "https://tenor.com/x" }] }),
    msg(bob, "2026-02-01T13:00:00Z", "", { type: 7 }),
    msg(bob, "2026-02-01T14:00:00Z", "", { message_reference: { message_id: "9", type: 1 }, message_snapshots: [{ message: { content: "forwarded text", attachments: [], embeds: [] } }] }),
  ];
  return format({
    messages,
    channel: { guild: "Hyperliquid", name: "builders", topic: "dev\nchat" },
    range: { from: "2026-01-01", to: "2026-02-28" },
    staff: new Map([["1", "HL Labs"]]),
    channels: new Map([["77", "general"]]),
    exportedAt: new Date("2026-03-01T00:00:00Z"),
  });
}

test("header, index and stats", () => {
  const { text, stats } = build();
  const lines = text.split("\n");
  assert.equal(lines[0], "# Discord export: Hyperliquid / builders");
  assert.equal(lines[1], "Topic: dev chat");
  assert.match(text, /8 messages, 4 authors/);
  assert.equal(stats.messages, 8);
  assert.match(text, /Staff: HL Labs: Alice \(@alice\) 2\./);
  const idx = text.match(/^2026-01: L(\d+)-(\d+), 6 msgs/m);
  assert.ok(idx, "january index line");
  assert.ok(lines[Number(idx[1]) - 1].startsWith("2026-01-01 "));
  assert.ok(lines[Number(idx[2]) - 1].startsWith("2026-01-03 "));
  assert.equal(lines.filter(Boolean).length > 0 && lines.length - 1, stats.lines);
});

test("line references point at the replied message", () => {
  const { text } = build();
  const lines = text.split("\n");
  const reply = lines.find((l) => l.startsWith("2026-01-02 bob ->"));
  const n = Number(reply.match(/ L(\d+):/)[1]);
  assert.ok(lines[n - 1].startsWith("2026-01-01 Alice (@alice)[HL Labs]: how do rate limits work?"));
});

test("content cleanup leaves code alone", () => {
  const { text } = build();
  assert.match(text, /per address @Alice \(@alice\) see #general :hype: 2026-01-01 00:00 UTC/);
  assert.match(text, /\n  const x = <@2>;\n/);
  assert.doesNotMatch(text, /\n\s*\n  /);
});

test("replies outside range, deleted, attachments, bots, gifs, forwards, system messages", () => {
  const { text } = build();
  assert.match(text, /2026-01-03 Alice \(@alice\)\[HL Labs\] ->bob 2025-12-01 "old answer": thanks/);
  assert.match(text, /2026-01-03 bob ->deleted: gone/);
  assert.match(text, /2026-01-03 bob: \[img\] \[file: log\.txt\]/);
  assert.match(text, /2026-01-02 PriceBot\[bot\]: \[embed: HYPE \| 42\.1\]/);
  assert.match(text, /2026-02-01 Alice \(@alice2\): \[gif\]/);
  assert.match(text, /2026-02-01 bob: \[fwd\] forwarded text/);
  assert.doesNotMatch(text, /\(no text\)/);
});

test("names can't be mistaken for role tags or the text separator", () => {
  seq = 1;
  const { text } = format({
    messages: [msg({ id: "9", username: "pb", global_name: "Purrbook [purrbook.xyz]: dev" }, "2026-01-01T00:00:00Z", "hi")],
    channel: { name: "x" },
    range: { from: "2026-01-01", to: "2026-01-01" },
  });
  assert.match(text, /\n2026-01-01 Purrbook \(purrbook\.xyz\) dev: hi\n/);
});

function assertRefsResolve(text) {
  const lines = text.split("\n");
  const inMonth = (line, month) => line.startsWith(month + "-") || line.startsWith("  ");
  for (const [, month, start, end] of text.matchAll(/^(\d{4}-\d{2}): L(\d+)-(\d+),/gm)) {
    assert.ok(lines[start - 1].startsWith(month + "-"), `index start for ${month}`);
    assert.ok(inMonth(lines[end - 1], month) && !inMonth(lines[end], month), `index end for ${month}`);
  }
  let replies = 0;
  for (const [, author, n] of text.matchAll(/^\d{4}-\d{2}-\d{2} .*? ->(.+?) L(\d+): /gm)) {
    const target = lines[n - 1];
    assert.ok(/^\d{4}-\d{2}-\d{2} /.test(target) && target.slice(11).startsWith(author), `ref L${n}`);
    replies++;
  }
  return replies;
}

test("out-of-range timestamps keep their token", () => {
  seq = 1;
  const { text } = format({
    messages: [msg(bob, "2026-01-01T00:00:00Z", "at <t:999999999999999999> and <t:0:R>")],
    channel: { name: "x" },
    range: { from: "2026-01-01", to: "2026-01-01" },
  });
  assert.match(text, /at <t:999999999999999999> and 1970-01-01 00:00 UTC/);
});

test("header values are one line each and refs still resolve", () => {
  seq = 1;
  const q = msg(alice, "2026-01-01T00:00:00Z", "q");
  const { text } = format({
    messages: [q, msg(bob, "2026-02-01T00:00:00Z", "a", { type: 19, message_reference: { message_id: q.id } })],
    channel: { guild: "Hyper\nliquid", parent: "dev\r\nzone", name: "build\ners", topic: "a\n\nb" },
    range: { from: "2026-01-01", to: "2026-02-01" },
    staff: new Map([["1", "HL\nLabs"]]),
    partial: "stopped by an error (Failed\nto fetch)",
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "# Discord export: Hyper liquid / #dev zone / build ers");
  assert.equal(lines[1], "Topic: a b");
  assert.match(text, /\nPARTIAL EXPORT: stopped by an error \(Failed to fetch\), messages end at 2026-02-01\.\n/);
  assert.match(text, /\nStaff: HL Labs: Alice 1\.\n/);
  assert.match(text, /\n2026-01-01 Alice\[HL Labs\]: q\n/);
  assert.equal(assertRefsResolve(text), 1);
});

test("every line fits the reader limit and refs still resolve", () => {
  seq = 1;
  const staffers = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, username: `staffer${i}`, global_name: `Staff Member Number ${i}` }));
  const unbroken = msg(alice, "2026-01-01T00:00:00Z", "x".repeat(5000));
  const continued = msg(bob, "2026-01-02T00:00:00Z", "intro\n" + "y".repeat(3000) + "\n" + "word ".repeat(1000));
  const emoji = msg(alice, "2026-01-03T00:00:00Z", "a" + "\u{1F600}".repeat(1500));
  const messages = [
    unbroken,
    continued,
    emoji,
    ...staffers.map((u) => msg(u, "2026-01-04T00:00:00Z", "gm")),
    msg(bob, "2026-02-01T00:00:00Z", "re", { type: 19, message_reference: { message_id: unbroken.id } }),
    msg(alice, "2026-02-01T00:00:00Z", "re", { type: 19, message_reference: { message_id: continued.id } }),
    msg(bob, "2026-02-01T00:00:00Z", "re", { type: 19, message_reference: { message_id: emoji.id } }),
  ];
  const { text, stats } = format({
    messages,
    channel: { name: "x" },
    range: { from: "2026-01-01", to: "2026-02-01" },
    staff: new Map(staffers.map((u) => [u.id, "Moderator"])),
  });
  const lines = text.split("\n");
  assert.equal(Math.max(...lines.map((l) => l.length)), 1896);
  assert.ok(lines.findIndex((l) => l.startsWith("  ")) < lines.indexOf("## Messages"), "staff list wraps");
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(assertRefsResolve(text), 3);
  assert.equal(lines.length - 1, stats.lines);
});

test("a long reply to an early line stays under the limit once its ref resolves", () => {
  seq = 1;
  const first = msg(alice, "2016-01-01T00:00:00Z", "q");
  const monthly = Array.from({ length: 120 }, (_, i) => msg(bob, new Date(Date.UTC(2016, i + 1, 1)).toISOString(), "m"));
  const reply = msg(bob, "2026-06-01T00:00:00Z", "z ".repeat(933) + "zz", { type: 19, message_reference: { message_id: first.id } });
  const { text } = format({
    messages: [first, ...monthly, reply],
    channel: { name: "x" },
    range: { from: "2016-01-01", to: "2026-06-01" },
  });
  assert.ok(text.split("\n").every((l) => l.length <= 1896));
  assert.equal(assertRefsResolve(text), 1);
});

test("partial reasons", () => {
  for (const partial of ["stopped early", "stopped by an error (Discord answered 403)"]) {
    seq = 1;
    const { text } = format({
      messages: [msg(bob, "2026-01-05T00:00:00Z", "hi")],
      channel: { name: "x" },
      range: { from: "2026-01-01", to: "2026-02-01" },
      partial,
    });
    assert.ok(text.includes(`\nPARTIAL EXPORT: ${partial}, messages end at 2026-01-05.\n`));
  }
});
