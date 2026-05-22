import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const distDirectory = new URL("../dist/client/", import.meta.url);
const generatedFile = new URL("../src/generated/client-assets.ts", import.meta.url);

const files = await readdir(distDirectory);
const scriptFile = files.find((file) => file.endsWith(".js"));
const styleFile = files.find((file) => file.endsWith(".css"));

if (scriptFile === undefined) {
  throw new Error("Client build did not emit a JavaScript asset");
}

if (styleFile === undefined) {
  throw new Error("Client build did not emit a CSS asset");
}

const clientScript = await readFile(new URL(scriptFile, distDirectory), "utf8");
const clientStyles = await readFile(new URL(styleFile, distDirectory), "utf8");

await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(
  generatedFile,
  `export const clientScript = ${JSON.stringify(clientScript)};\nexport const clientStyles = ${JSON.stringify(clientStyles)};\n`,
);
