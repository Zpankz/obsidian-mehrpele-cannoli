import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { buildPlugin, stubPlugin, BUNDLE_BUDGET } from "../packages/mehrpele-cannoli/esbuild.config.mjs";
const root = resolve(import.meta.dir,"..");
const pkgRoot = join(root,"packages/mehrpele-cannoli");
// Map installed dependency bytes directly. Some upstream source maps point to unavailable
// remote originals. Removing only the trailing mapping annotation changes no executable token.
const localMaps={name:"local-source-evidence",setup(build:any){
 build.onLoad({filter:/\.(?:c?js|mjs)$/},(args:any)=>{
  if(!args.path.includes("/node_modules/"))return undefined;
  const source=readFileSync(args.path,"utf8");
  const contents=source.replace(/\r?\n\/\/[#@] sourceMappingURL=[^\r\n]*(?:\r?\n)?$/,"\n");
  return {contents,loader:"js"};
 });
}};
const built = await buildPlugin({write:false,overrides:{sourcemap:"external",plugins:[stubPlugin,localMaps]}});
const js = built.outputFiles!.find(f=>f.path.endsWith("main.js"))!;
const map = built.outputFiles!.find(f=>f.path.endsWith("main.js.map"))!;
const supplements=JSON.parse(readFileSync(join(root,"licenses/supplements.json"),"utf8"));
const usedSupplements=new Set<string>();
const licenses = new Map<string,string>(),packages = new Map<string,{name:string;version:string;license:string;texts:string[]}>();
for (const input of Object.keys(built.metafile!.inputs)) {
  const path=realpathSync(resolve(pkgRoot,input));
  if(!path.startsWith(root+"/"))throw Error(`Bundle input escapes standalone install: ${input}`);
  let dir=dirname(path),meta;
  for(;;){
    if(existsSync(join(dir,"package.json"))){
      const candidate=JSON.parse(readFileSync(join(dir,"package.json"),"utf8"));
      if(candidate.name&&candidate.version){meta=candidate;break;}
    }
    const up=dirname(dir);if(up===dir||!up.startsWith(root+"/"))throw Error(`No package owns input ${input}`);dir=up;
  }
  const id=`${meta.name}@${meta.version}`;
  if(packages.has(id))continue;
  if(!meta.name||!meta.version||typeof meta.license!=="string")throw Error(`Missing package license metadata: ${id}`);
  const files=readdirSync(dir).filter(n=>/^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(n)).sort();
  const supplement=supplements[id];
  if(!files.length&&!supplement)throw Error(`No license text for ${id}`);
  const inputs=files.map(file=>join(dir,file));
  if(supplement){
    if(supplement.license!==meta.license)throw Error(`Supplement license differs: ${id}`);
    usedSupplements.add(id);
    for(const [file,hash] of Object.entries(supplement.files)){
      if(!/^[A-Za-z0-9.-]+$/.test(file))throw Error("Unsafe supplement path");
      const path=join(root,"licenses",file),bytes=readFileSync(path);
      if(createHash("sha256").update(bytes).digest("hex")!==hash)throw Error(`License supplement changed: ${file}`);
      inputs.push(path);
    }
  }
  const texts=inputs.map(file=>{
    const text=readFileSync(file,"utf8").trimEnd();
    if(!text.trim())throw Error(`Empty license: ${id}/${file}`);
    const hash=createHash("sha256").update(text).digest("hex");licenses.set(hash,text);return hash;
  });
  packages.set(id,{name:meta.name,version:meta.version,license:meta.license,texts});
}
if(Object.keys(supplements).some(id=>!usedSupplements.has(id)))throw Error("Stale license supplement");
const inventory=[...packages.values()].sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const notice=["# Production code notices","","This inventory is derived from the actual browser bundle inputs. It includes the companion, host API and canonical engine sources. Installed legacy provider clients used only for types and tests are not represented as bundled runtime code.","",...inventory.map(p=>`- ${p.name}@${p.version} (${p.license}): ${p.texts.map(h=>h.slice(0,12)).join(", ")}`),"",...[...licenses].sort(([a],[b])=>a.localeCompare(b)).flatMap(([hash,text])=>[`## License ${hash.slice(0,12)}`,"",text,""])].join("\n").trimEnd();
if(notice.includes("*/"))throw Error("License text needs safe comment packaging");
const result=js.text+`\n/*!\n${notice}\n*/\n`;
if(Buffer.byteLength(result)>BUNDLE_BUDGET)throw Error(`Licensed artifact exceeds ${BUNDLE_BUDGET} bytes: ${Buffer.byteLength(result)}`);
writeFileSync(join(root,"main.js"),result);
writeFileSync(join(root,"THIRD-PARTY-NOTICES.md"),notice+"\n");
for(const file of ["manifest.json","styles.css","versions.json"]){
 const a=readFileSync(join(root,file)),b=readFileSync(join(pkgRoot,file));if(!a.equals(b))throw Error(`Root asset differs: ${file}`);
}
// Local verification evidence is not a release asset or a published source map.
const {mkdirSync}=await import("node:fs");mkdirSync(join(root,"dist"),{recursive:true});
writeFileSync(join(root,"dist/build-proof.json"),JSON.stringify({metafile:built.metafile,baseBytes:js.contents.length,baseHash:createHash("sha256").update(js.contents).digest("hex"),artifactHash:createHash("sha256").update(result).digest("hex"),sourceMap:map.text,inventory,licenseHash:createHash("sha256").update(notice).digest("hex")},null,2));
console.log(`build: ${Buffer.byteLength(result)} licensed bytes, ${inventory.length} packages, ${licenses.size} distinct license texts`);
