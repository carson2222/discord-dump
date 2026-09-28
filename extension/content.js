/* Discord Chat Exporter — content script
 * Injects a floating panel on discord.com/channels/* to export messages
 * within a date range to a .txt file. Auto-scrolls to load history.
 *
 * Selectors validated against Discord web (June 2026). Discord ships hashed
 * class names that change over time, so everything uses prefix/contains
 * matching ([class*="..."]) and stable id prefixes to survive minor updates.
 */
(() => {
  "use strict";

  if (window.__dceLoaded) return;
  window.__dceLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);

  // ---------- DOM access ----------

  // The scrollable element that owns the message list (ol.scrollerInner_*).
  function getScroller() {
    const ol = document.querySelector('ol[class*="scrollerInner_"]');
    if (!ol) return null;
    let el = ol.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function channelName() {
    // Header title in the toolbar; fall back to document title / URL.
    const h =
      document.querySelector('section[aria-label] h1') ||
      document.querySelector('[class*="title_"] h1') ||
      document.querySelector('header [class*="title_"]');
    let name = h ? h.textContent.trim() : "";
    if (!name) {
      const m = document.title.match(/#[^|]+/);
      name = m ? m[0].trim() : "discord-export";
    }
    return name.replace(/[^\w\-\u00C0-\uFFFF]+/g, "_").replace(/^_+|_+$/g, "") || "discord-export";
  }

  // ---------- Extraction ----------

  function extract(li) {
    const time = li.querySelector('time[id^="message-timestamp-"]');
    const iso = time ? time.getAttribute("datetime") : null;

    const uEl = li.querySelector('[id^="message-username-"] [class*="username_"]');
    const author = uEl ? (uEl.getAttribute("data-text") || uEl.textContent.trim()) : null;

    const cEl = li.querySelector(
      '[id^="message-content-"]:not([class*="repliedTextContent"])'
    );
    const text = cEl ? cEl.innerText.trim() : "";

    let replyTo = null;
    const reply = li.querySelector('[class*="repliedMessage_"]');
    if (reply) {
      const ru = reply.querySelector('[class*="username_"]');
      const rc = reply.querySelector('[class*="repliedTextContent_"]');
      replyTo = {
        author: ru ? (ru.getAttribute("data-text") || ru.textContent.trim()).replace(/^@/, "") : null,
        preview: rc ? rc.innerText.trim() : "",
      };
    }

    const attachments = [];
    const acc = li.querySelector('[id^="message-accessories-"]');
    if (acc) {
      acc.querySelectorAll("a[href]").forEach((a) => {
        if (a.href && !attachments.includes(a.href)) attachments.push(a.href);
      });
      acc.querySelectorAll("img[src]").forEach((i) => {
        if (i.src && !i.src.startsWith("data:") && !attachments.includes(i.src)) {
          attachments.push(i.src);
        }
      });
    }

    const id = li.id.split("-").pop();
    return { id, iso, tsMs: iso ? Date.parse(iso) : 0, author, text, replyTo, attachments };
  }

  // Harvest all messages currently in the DOM (in visual order) into a Map.
  // Continuation messages (no username header) inherit the last seen author.
  function harvest(map) {
    const lis = document.querySelectorAll('li[id^="chat-messages-"]');
    let lastAuthor = null;
    lis.forEach((li) => {
      const m = extract(li);
      if (m.author) lastAuthor = m.author;
      else m.author = lastAuthor || "(unknown)";
      if (m.id && !map.has(m.id)) map.set(m.id, m);
    });
  }

  // ---------- Scroll engine ----------

  // Signature of the currently mounted message window. Changes whenever
  // Discord mounts/unmounts rows, letting us proceed the instant new
  // history renders instead of waiting a fixed delay.
  function listSig(scroller) {
    const lis = document.querySelectorAll('li[id^="chat-messages-"]');
    const first = lis[0] ? lis[0].id : "";
    const last = lis[lis.length - 1] ? lis[lis.length - 1].id : "";
    return lis.length + "|" + first + "|" + last + "|" + scroller.scrollHeight;
  }

  // Resolve as soon as the rendered window changes (new rows mounted) or the
  // scroll position settles, capped by maxMs. Much faster than a flat sleep.
  async function waitForRender(scroller, prevSig, maxMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      await sleep(30);
      if (listSig(scroller) !== prevSig) {
        await sleep(40); // let the batch finish painting
        return true;
      }
    }
    return false; // nothing changed (likely at top / loading stalled)
  }

  async function collect(fromMs, toMs, onProgress, shouldStop) {
    const scroller = getScroller();
    if (!scroller) throw new Error("Message scroller not found. Open a text channel first.");

    const map = new Map();
    // Step ~85% of the viewport: aggressive, but the ~15% overlap (plus
    // Discord's off-screen render buffer) guarantees no rows are skipped.
    const step = () => Math.max(300, scroller.clientHeight * 0.85);
    const SETTLE_MS = 650; // max wait per step before assuming stall/top
    let stagnant = 0;
    let lastSize = -1;

    harvest(map);

    while (true) {
      if (shouldStop()) break;

      const tss = [...map.values()].map((m) => m.tsMs).filter(Boolean);
      const oldest = tss.length ? Math.min(...tss) : Infinity;
      onProgress(map.size, oldest);

      // Loaded far enough into the past.
      if (oldest <= fromMs) break;

      const before = listSig(scroller);
      scroller.scrollTop = Math.max(0, scroller.scrollTop - step());
      const changed = await waitForRender(scroller, before, SETTLE_MS);
      harvest(map);

      // Top-of-history detection: pinned at top, render didn't change, and
      // no new messages collected for several consecutive passes.
      const atTop = scroller.scrollTop <= 1;
      if (atTop && !changed && map.size === lastSize) {
        if (++stagnant >= 3) break; // reached beginning of channel
      } else {
        stagnant = 0;
      }
      lastSize = map.size;
    }

    harvest(map);
    return [...map.values()]
      .filter((m) => m.tsMs >= fromMs && m.tsMs <= toMs)
      .sort((a, b) => a.tsMs - b.tsMs);
  }

  // ---------- Formatting ----------

  function formatTxt(msgs, opt, meta) {
    const lines = [];
    lines.push(`# ${meta.channel}`);
    lines.push(`# Range: ${meta.from} \u2014 ${meta.to}`);
    lines.push(`# Messages: ${msgs.length}`);
    lines.push(`# Exported: ${new Date().toLocaleString()}`);
    lines.push("");

    for (const m of msgs) {
      const block = [];
      if (opt.replyTo && m.replyTo) {
        block.push(`\u21B3 reply to ${m.replyTo.author || "?"}: ${truncate(m.replyTo.preview, 100)}`);
      }
      const head = [];
      if (opt.timestamp && m.iso) head.push(`[${new Date(m.iso).toLocaleString()}]`);
      if (opt.author) head.push(m.author || "(unknown)");
      const prefix = head.length ? head.join(" ") + ": " : "";
      block.push(prefix + (m.text || (m.attachments.length ? "" : "(no text)")));
      if (opt.attachments && m.attachments.length) {
        m.attachments.forEach((a) => block.push(`  [attachment] ${a}`));
      }
      lines.push(block.join("\n"));
    }
    return lines.join("\n\n") + "\n";
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- UI ----------

  let stopFlag = false;

  function fmtDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function buildPanel() {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 864e5);

    const launcher = document.createElement("button");
    launcher.id = "dce-launcher";
    launcher.textContent = "Export";
    launcher.title = "Discord Chat Exporter";

    const panel = document.createElement("div");
    panel.id = "dce-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div id="dce-head">
        <span>Chat Exporter</span>
        <button id="dce-close" title="Close">\u2715</button>
      </div>
      <div class="dce-row">
        <label>From <input type="date" id="dce-from" value="${fmtDate(weekAgo)}"></label>
        <label>To <input type="date" id="dce-to" value="${fmtDate(today)}"></label>
      </div>
      <div class="dce-opts">
        <label><input type="checkbox" id="dce-o-author" checked> Author</label>
        <label><input type="checkbox" id="dce-o-timestamp" checked> Timestamp</label>
        <label><input type="checkbox" id="dce-o-replyTo" checked> Reply-to</label>
        <label><input type="checkbox" id="dce-o-attachments" checked> Attachments</label>
      </div>
      <div class="dce-actions">
        <button id="dce-run">Export .txt</button>
        <button id="dce-stop" disabled>Stop</button>
      </div>
      <div id="dce-status">Idle.</div>
    `;

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector(id);
    const status = $("#dce-status");

    launcher.onclick = () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    };
    $("#dce-close").onclick = () => (panel.style.display = "none");

    $("#dce-run").onclick = async () => {
      const fromVal = $("#dce-from").value;
      const toVal = $("#dce-to").value;
      if (!fromVal || !toVal) {
        status.textContent = "Pick both dates.";
        return;
      }
      const fromMs = new Date(fromVal + "T00:00:00").getTime();
      const toMs = new Date(toVal + "T23:59:59.999").getTime();
      if (fromMs > toMs) {
        status.textContent = "'From' is after 'To'.";
        return;
      }

      const opt = {
        author: $("#dce-o-author").checked,
        timestamp: $("#dce-o-timestamp").checked,
        replyTo: $("#dce-o-replyTo").checked,
        attachments: $("#dce-o-attachments").checked,
      };

      stopFlag = false;
      $("#dce-run").disabled = true;
      $("#dce-stop").disabled = false;

      try {
        const msgs = await collect(
          fromMs,
          toMs,
          (count, oldestMs) => {
            const oldest = Number.isFinite(oldestMs)
              ? new Date(oldestMs).toLocaleDateString()
              : "\u2014";
            status.textContent = `Scrolling\u2026 ${count} loaded, oldest ${oldest}`;
          },
          () => stopFlag
        );

        if (!msgs.length) {
          status.textContent = "No messages in that range.";
        } else {
          const channel = channelName();
          const text = formatTxt(msgs, opt, {
            channel,
            from: fromVal,
            to: toVal,
          });
          download(text, `${channel}_${fromVal}_to_${toVal}.txt`);
          status.textContent = `Done. Exported ${msgs.length} messages.`;
        }
      } catch (e) {
        status.textContent = "Error: " + e.message;
        console.error("[DCE]", e);
      } finally {
        $("#dce-run").disabled = false;
        $("#dce-stop").disabled = true;
      }
    };

    $("#dce-stop").onclick = () => {
      stopFlag = true;
      status.textContent = "Stopping\u2026";
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel);
  } else {
    buildPanel();
  }
})();
