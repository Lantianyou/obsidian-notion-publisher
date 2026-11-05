import { FileDiff } from "@pierre/diffs";

export class ReviewDiff {
  private view: FileDiff | undefined;
  private themeObserver: MutationObserver | undefined;
  private layout: "split" | "unified" = "split";

  render(container: HTMLElement, before: string, after: string) {
    this.cleanUp();
    const controls = container.createDiv();
    controls.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px";
    controls.createEl("span", { text: "本地原文（−） → Notion 修改（＋）" });
    const toggle = controls.createEl("button", {
      text: this.layout === "split" ? "切换上下对比" : "切换并排对比",
    });
    toggle.type = "button";
    const host = document.createElement("diffs-container");
    container.appendChild(host);
    host.setAttribute("data-pierre-review", "");
    host.style.cssText =
      "max-height:35vh;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px";
    const themeType = document.body.classList.contains("theme-dark") ? "dark" : "light";
    this.view = new FileDiff({
      diffStyle: this.layout,
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType,
      diffIndicators: "classic",
      lineDiffType: "char",
      overflow: "wrap",
      disableFileHeader: true,
      expandUnchanged: true,
      unsafeCSS:
        ":host { --diffs-font-family:var(--font-monospace,monospace); --diffs-font-size:13px; --diffs-line-height:1.7; }",
    });
    this.view.render({
      oldFile: { name: "本地原文.txt", contents: before, lang: "text" },
      newFile: { name: "Notion 修改.txt", contents: after, lang: "text" },
      fileContainer: host,
    });
    this.themeObserver = new MutationObserver(() => {
      this.view?.setThemeType(document.body.classList.contains("theme-dark") ? "dark" : "light");
    });
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    toggle.onclick = () => {
      this.layout = this.layout === "split" ? "unified" : "split";
      container.empty();
      this.render(container, before, after);
    };
  }

  cleanUp() {
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.view?.cleanUp();
    this.view = undefined;
  }
}
