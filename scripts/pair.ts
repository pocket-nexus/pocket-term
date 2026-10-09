// bun run pair --host <ip> — pair with a console once, while ftpd is running
// on it. The vendored tool uploads a key to the SD card and keeps its copy
// inside the submodule; this brings that copy back into .pocket/devices/,
// where it survives a re-clone of vendor/pocketjs.

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { $ } from "bun";
import { passThrough } from "./run.ts";
import { ROOT, VENDOR } from "./paths.ts";

await passThrough($`bun ${VENDOR}/tools/3ds-dev.ts pair ${process.argv.slice(2)}`.cwd(ROOT));

const vendorKeys = resolve(VENDOR, ".pocket/3ds/devices");
if (existsSync(vendorKeys)) {
  const keys = resolve(ROOT, ".pocket/devices");
  mkdirSync(keys, { recursive: true });
  for (const name of readdirSync(vendorKeys).filter((entry) => entry.endsWith(".key"))) {
    copyFileSync(resolve(vendorKeys, name), resolve(keys, name));
    console.log(`pocket-term: kept .pocket/devices/${name}`);
  }
}

// The companion transports share one app-scoped key, separate from the
// development service. The filename is retained for deployed compatibility.
const argv = process.argv.slice(2);
const address = argv[argv.indexOf("--host") + 1];
if (!argv.includes("--host") || !address) throw new Error("Expected --host <console-ip>");
const offloadKey = resolve(ROOT, ".pocket/offload.key");
if (!existsSync(offloadKey)) writeFileSync(offloadKey, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
chmodSync(offloadKey, 0o600);
const manifest = JSON.parse(readFileSync(resolve(ROOT, "pocket.json"), "utf8"));
const slot = createHash("sha256").update(manifest.id).digest("hex").slice(0, 16);
const program = `import ftplib,io,pathlib,sys
ftp=ftplib.FTP(); ftp.connect(sys.argv[1],5000,timeout=20); ftp.login()
for directory in ['/pocketjs','/pocketjs/offload']:
    try: ftp.mkd(directory)
    except ftplib.error_perm as error:
        if not str(error).startswith('550'): raise
key=pathlib.Path(sys.argv[2]).read_bytes()
remote='/pocketjs/offload/'+sys.argv[3]+'.key'
ftp.storbinary('STOR '+remote,io.BytesIO(key))
result=io.BytesIO(); ftp.retrbinary('RETR '+remote,result.write)
assert result.getvalue()==key, 'Pair key readback mismatch'
ftp.quit()
print('Pocket Term offload key paired and read back successfully')
`;
const paired = Bun.spawnSync(["python3", "-c", program, address, offloadKey, slot], { stdout: "inherit", stderr: "inherit" });
if (paired.exitCode) process.exit(paired.exitCode);
