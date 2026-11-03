// Minimal ustar writer + gzip via the browser's CompressionStream. Enough to
// hand over a case directory with Allrun still executable.

const enc = new TextEncoder();

function header(name, size, mode, type) {
  const h = new Uint8Array(512);
  const put = (str, off, len) => h.set(enc.encode(str).subarray(0, len), off);
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  if (enc.encode(name).length > 100) throw new Error(`path too long for tar: ${name}`);
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8); // checksum counts as spaces while summing
  put(type, 156, 1);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

// files: { "dir/file": { content: string, mode: number } }
export function tar(files) {
  const chunks = [];
  const dirs = new Set();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  for (const d of [...dirs].sort()) chunks.push(header(d, 0, 0o755, "5"));
  for (const [path, f] of Object.entries(files)) {
    const data = enc.encode(f.content);
    chunks.push(header(path, data.length, f.mode ?? 0o644, "0"));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  return new Blob(chunks);
}

export async function tarGz(files) {
  const stream = tar(files).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}
