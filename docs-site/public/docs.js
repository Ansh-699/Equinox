// Equinox docs: theme, sidebar scroll-spy, phone menu, and Mermaid diagrams
// drawn in the site's own colours (re-drawn when the theme changes).
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const root = document.documentElement;
const stored = (() => { try { return localStorage.getItem("equinox-docs-theme"); } catch { return null; } })();
if (stored === "light") root.dataset.theme = "light";

const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();

function themeVariables() {
  return {
    darkMode: root.dataset.theme !== "light",
    background: css("--t-surface"),
    fontFamily: "Poppins, ui-sans-serif, system-ui, sans-serif",
    fontSize: "14px",
    primaryColor: css("--t-surface-3"),
    primaryTextColor: css("--t-text"),
    primaryBorderColor: css("--t-border-strong"),
    secondaryColor: css("--t-surface-2"),
    tertiaryColor: css("--t-surface-2"),
    lineColor: css("--t-text-3"),
    textColor: css("--t-text"),
    mainBkg: css("--t-surface-3"),
    nodeBorder: css("--t-border-strong"),
    clusterBkg: css("--t-surface-2"),
    clusterBorder: css("--t-border"),
    titleColor: css("--t-text-2"),
    edgeLabelBackground: css("--t-surface"),
    actorBkg: css("--t-surface-3"),
    actorBorder: css("--t-border-strong"),
    actorTextColor: css("--t-text"),
    actorLineColor: css("--t-border-strong"),
    signalColor: css("--t-text-2"),
    signalTextColor: css("--t-text"),
    labelBoxBkgColor: css("--t-surface-3"),
    labelBoxBorderColor: css("--t-border-strong"),
    labelTextColor: css("--t-text"),
    loopTextColor: css("--t-text-2"),
    noteBkgColor: css("--t-surface-2"),
    noteBorderColor: css("--t-accent"),
    noteTextColor: css("--t-text"),
    activationBkgColor: css("--t-surface-2"),
    activationBorderColor: css("--t-accent"),
    sequenceNumberColor: css("--t-bg"),
    stateBkg: css("--t-surface-3"),
    stateLabelColor: css("--t-text"),
    transitionColor: css("--t-text-3"),
    transitionLabelColor: css("--t-text-2"),
  };
}

let renders = 0;
async function renderAll() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(),
    flowchart: { curve: "basis", padding: 14, htmlLabels: true },
    sequence: { showSequenceNumbers: true, actorMargin: 40, messageFontSize: 13, noteFontSize: 12.5, mirrorActors: false },
  });
  const pass = ++renders;
  for (const holder of document.querySelectorAll(".diagram")) {
    const source = holder.parentElement.querySelector(".mermaid-src").textContent;
    holder.dataset.state = "loading";
    try {
      const { svg } = await mermaid.render(`d${pass}-${holder.id}`, source);
      if (pass !== renders) return; // a newer theme pass took over
      holder.innerHTML = svg;
      holder.dataset.state = "ready";
    } catch (error) {
      holder.textContent = "Diagram failed to render.";
      holder.dataset.state = "error";
      console.error(holder.id, error);
    }
  }
}

document.querySelectorAll(".diagram").forEach((el, i) => { el.id ||= `diagram-${i}`; });
renderAll();

document.getElementById("theme").addEventListener("click", () => {
  const light = root.dataset.theme !== "light";
  if (light) root.dataset.theme = "light"; else delete root.dataset.theme;
  try { localStorage.setItem("equinox-docs-theme", light ? "light" : "dark"); } catch { /* private mode */ }
  renderAll();
});

// Phone menu.
document.getElementById("menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));
document.querySelectorAll(".sidebar a").forEach((a) => a.addEventListener("click", () => document.body.classList.remove("nav-open")));

// Scroll-spy: highlight the section being read.
const links = new Map([...document.querySelectorAll(".sidebar a")].map((a) => [a.getAttribute("href").slice(1), a]));
const spy = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    links.forEach((a) => a.classList.remove("active"));
    links.get(entry.target.id)?.classList.add("active");
  }
}, { rootMargin: "-70px 0px -70% 0px" });
document.querySelectorAll("main section[id]").forEach((s) => spy.observe(s));
