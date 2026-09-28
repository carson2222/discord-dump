async function toggle(tab) {
  const target = { tabId: tab.id };
  const run = (func) => chrome.scripting.executeScript({ target, world: "MAIN", func });
  try {
    const [{ result: loaded }] = await run(() => Boolean(window.__discordDumpLoaded));
    if (!loaded) {
      await chrome.scripting.insertCSS({ target, files: ["panel.css"] });
      await chrome.scripting.executeScript({ target, world: "MAIN", files: ["format.js", "content.js"] });
    }
    await run(() => window.dispatchEvent(new Event("discord-dump:toggle")));
  } catch {}
}

chrome.action.onClicked.addListener(toggle);
