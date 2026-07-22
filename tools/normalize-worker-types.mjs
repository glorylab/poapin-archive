import { readFile, writeFile } from "node:fs/promises";

const generatedTypes = new URL("../worker-configuration.d.ts", import.meta.url);
const source = await readFile(generatedTypes, "utf8");
const normalized = source.replace(/[\t ]+$/gm, "");

if (normalized !== source) await writeFile(generatedTypes, normalized, "utf8");
