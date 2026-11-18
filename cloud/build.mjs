import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cloudDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(cloudDir);
const publicDir = join(cloudDir, "public");

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

// Keep the Worker asset bundle deliberately allow-listed. In particular, do
// not copy server.mjs, lib/, data/, .env, tests/, or evaluation artifacts.
for (const file of ["index.html", "app.js", "styles.css", "teacher.html", "teacher.js"]) {
  await cp(join(appDir, file), join(publicDir, file));
}
await cp(join(appDir, "assets"), join(publicDir, "assets"), { recursive: true });

const vendorDir = join(publicDir, "vendor");
await mkdir(vendorDir, { recursive: true });
for (const file of ["katex.min.css", "katex.min.js"]) {
  await cp(join(appDir, "node_modules", "katex", "dist", file), join(vendorDir, file));
}
await cp(join(appDir, "node_modules", "katex", "dist", "contrib", "auto-render.min.js"), join(vendorDir, "auto-render.min.js"));
await cp(join(appDir, "node_modules", "katex", "dist", "fonts"), join(vendorDir, "fonts"), { recursive: true });

// The local build intentionally lets an administrator enter a temporary model
// key from the page. The public Worker uses the server-side Secret instead, so
// remove that local-only control and wording from the published student bundle.
const appPath = join(publicDir, "app.js");
let app = await readFile(appPath, "utf8");
app = app.replace(/function aiConfigTemplate\(\) \{[\s\S]*?\n\}\n\nfunction importTemplate/, `function aiConfigTemplate() {
  return "";
}

function importTemplate`);
app = app.replace(/function bindAiConfigForm\(\) \{[\s\S]*?\n\}\n\nfunction bindDraftForm/, `function bindAiConfigForm() {}

function bindDraftForm`);
app = app.replace(/pill\.querySelector\("span:last-child"\)\.textContent = configured \? "AI服务可用" : "AI服务暂不可用 · 请填写密钥";/, `pill.querySelector("span:last-child").textContent = configured ? "AI服务可用" : "AI服务暂不可用 · 请联系管理员";`);
await writeFile(appPath, app);

const teacherHtmlPath = join(publicDir, "teacher.html");
let teacherHtml = await readFile(teacherHtmlPath, "utf8");
teacherHtml = teacherHtml
  .replace("本机可直接查看；远程访问需教师口令", "云端访问需要教师口令")
  .replace("placeholder=\"本机可留空\"", "placeholder=\"请输入教师口令\"")
  .replace("点击查看后读取；本机可留空口令。", "点击查看后读取；云端必须输入教师口令。");
await writeFile(teacherHtmlPath, teacherHtml);

const teacherJsPath = join(publicDir, "teacher.js");
let teacherJs = await readFile(teacherJsPath, "utf8");
teacherJs = teacherJs.replaceAll("本机可留空口令。", "云端必须输入教师口令。");
await writeFile(teacherJsPath, teacherJs);

console.log(`Cloudflare Worker assets prepared at ${publicDir}`);

