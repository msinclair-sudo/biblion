// Minimal NPY v1/v2 reader, shared by the real + sqlite data sources.
//
// Parses the magic + header and returns the raw Float32Array payload along
// with its shape. Only '<f4' (little-endian float32), 2-D C-order is
// supported — that's what `biblion advanced embedding` (biblion/embed.py) + the
// old step02_embeddings.py write. We'll grow this if other dtypes ever show up.
//
// (Originally lived inline in real.js; lifted here so sqlite.js reuses it.)

export function parseNpy(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8[0] !== 0x93 ||
      u8[1] !== 0x4e || u8[2] !== 0x55 || u8[3] !== 0x4d ||
      u8[4] !== 0x50 || u8[5] !== 0x59) {
    throw new Error("[npy] not an .npy file (bad magic)");
  }
  const major = u8[6];
  let headerLen, headerStart;
  if (major === 1) {
    headerLen = u8[8] | (u8[9] << 8);
    headerStart = 10;
  } else {
    const dv = new DataView(arrayBuffer);
    headerLen = dv.getUint32(8, true);
    headerStart = 12;
  }
  const header = new TextDecoder("ascii").decode(u8.slice(headerStart, headerStart + headerLen));

  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!shapeMatch) throw new Error(`[npy] no shape in header: ${header}`);
  const shape = shapeMatch[1].split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);

  const descrMatch = /'descr':\s*'([^']+)'/.exec(header);
  if (!descrMatch || descrMatch[1] !== "<f4") {
    throw new Error(`[npy] expected dtype '<f4'; got ${descrMatch && descrMatch[1]}`);
  }

  const dataStart = headerStart + headerLen;
  const data = new Float32Array(arrayBuffer.slice(dataStart));
  if (shape.length !== 2 || data.length !== shape[0] * shape[1]) {
    throw new Error(`[npy] shape ${shape} does not match data length ${data.length}`);
  }
  return { shape, data };
}
