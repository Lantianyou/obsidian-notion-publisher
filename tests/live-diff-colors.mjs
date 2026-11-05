// Check the rendered diff against the current Obsidian theme without changing any note.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const code = `JSON.stringify((()=>{
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
 const lum=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[0.2126,0.7152,0.0722][i],0);
 const root=document.querySelector('[data-pierre-review]')?.shadowRoot;
 const changed=root?[...root.querySelectorAll('[data-diff-span] span')].filter(e=>e.textContent.trim()):[];
 if(root && !root.adoptedStyleSheets.length)throw new Error('Pierre core stylesheet is missing');
 return changed.map(e=>{
  ctx.clearRect(0,0,1,1);
  const ancestors=[];for(let p=e.parentElement;p;p=p.parentElement??p.getRootNode().host)ancestors.unshift(p);
  for(const p of ancestors){ctx.fillStyle=getComputedStyle(p).backgroundColor;ctx.fillRect(0,0,1,1)}
  ctx.fillStyle=getComputedStyle(e).backgroundColor;ctx.fillRect(0,0,1,1);const bg=[...ctx.getImageData(0,0,1,1).data];
  ctx.fillStyle=getComputedStyle(e).color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data];
  const a=lum(bg),b=lum(fg);return {contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),kind:e.closest('[data-line-type]')?.dataset.lineType??'change'};
 });
})())`;
const output = execFileSync(
  "obsidian",
  [`vault=${process.argv[2] ?? "team"}`, "eval", `code=${code}`],
  { encoding: "utf8" },
);
const samples = JSON.parse(output.replace(/^=>\s*/, "").trim());
assert.ok(samples.length, "Open a review that contains added or deleted text first.");
for (const sample of samples)
  assert.ok(
    sample.contrast >= 4.5,
    `Unreadable ${sample.kind} highlight: contrast ${sample.contrast.toFixed(2)}`,
  );
console.info(
  `Rendered diff contrast passed for ${samples.length} highlights in the current theme.`,
);
